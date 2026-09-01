#!/usr/bin/env bash
# Weekly path-policy digest: rule suites on the org's path-policy rulesets during the last month that
# failed (active), would have failed (evaluate), or were bypassed by an owner, plus open delegated
# bypass requests for push rules. Writes markdown to <out.md>; when $GITHUB_OUTPUT is set, appends
# would_fail_count, bypass_count, and bypass_open_count.
# Usage: GH_TOKEN=<org administration:read> policy/ops-digest.sh <out.md>
set -euo pipefail

ORG=postman-cs
OUT=${1:?usage: ops-digest.sh <out.md>}
MAX_SUITE_DETAILS=${MAX_SUITE_DETAILS:-300}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Suites whose overall result is fail (active), whose evaluate result is fail (would-fail), or that
# were bypassed (the suite passes because the actor is a bypass actor while a rule evaluated to fail).
{
  gh api --paginate "orgs/$ORG/rulesets/rule-suites?time_period=month&evaluate_status=evaluate&rule_suite_result=fail&per_page=100" --jq '.[]'
  gh api --paginate "orgs/$ORG/rulesets/rule-suites?time_period=month&rule_suite_result=fail&per_page=100" --jq '.[]'
  gh api --paginate "orgs/$ORG/rulesets/rule-suites?time_period=month&rule_suite_result=bypass&per_page=100" --jq '.[]'
  gh api --paginate "orgs/$ORG/rulesets/rule-suites?time_period=month&evaluate_status=evaluate&rule_suite_result=bypass&per_page=100" --jq '.[]'
} | jq -c -s 'unique_by(.id) | sort_by(.pushed_at) | reverse | .[]' > "$work/suites.jsonl"
suite_total=$(wc -l < "$work/suites.jsonl" | tr -d ' ')

# Rule-level rows for the path-policy rulesets only (enterprise rules share the same suites).
head -n "$MAX_SUITE_DETAILS" "$work/suites.jsonl" | while IFS= read -r suite; do
  id=$(jq -r '.id' <<<"$suite")
  gh api "orgs/$ORG/rulesets/rule-suites/$id" | jq -c --argjson s "$suite" '
    .rule_evaluations[]
    | select(.result == "fail" and ((.rule_source.name // "") | startswith("path-policy")))
    | {repo: $s.repository_name, ruleset: .rule_source.name, rule: .rule_type, enforcement,
       outcome: ($s.evaluation_result // $s.result), pushed_at: $s.pushed_at, ref: $s.ref,
       actor: $s.actor_name, suite: $s.id}'
done > "$work/rows.jsonl"
would_fail_count=$(jq -s '[.[] | select(.outcome != "bypass")] | length' "$work/rows.jsonl")
bypass_count=$(jq -s '[.[] | select(.outcome == "bypass")] | length' "$work/rows.jsonl")

gh api --paginate "orgs/$ORG/bypass-requests/push-rules?request_status=open&per_page=100" --jq '.[]' > "$work/bypass.jsonl"
bypass_open_count=$(wc -l < "$work/bypass.jsonl" | tr -d ' ')

{
  echo "## Would-fail digest (last month)"
  echo
  echo "Rule suites inspected: $suite_total (details fetched for up to $MAX_SUITE_DETAILS). Path-policy rule failures: $would_fail_count would-fail/failed, $bypass_count bypassed by an owner."
  echo
  if [ -s "$work/rows.jsonl" ]; then
    echo "| repository | ruleset | rule | enforcement | outcome | count | last push | last actor |"
    echo "|---|---|---|---|---|---|---|---|"
    jq -r -s '
      group_by([.repo, .ruleset, .rule, .enforcement, .outcome])
      | map({repo: .[0].repo, ruleset: .[0].ruleset, rule: .[0].rule, enforcement: .[0].enforcement,
             outcome: .[0].outcome, count: length, last: (max_by(.pushed_at))})
      | sort_by(.outcome == "bypass", -.count)
      | .[] | "| \(.repo) | \(.ruleset) | \(.rule) | \(.enforcement) | \(.outcome) | \(.count) | \(.last.pushed_at) | \(.last.actor // "-") |"' "$work/rows.jsonl"
    echo
  fi
  echo "## Open bypass requests (push rules)"
  echo
  echo "Open: $bypass_open_count"
  if [ "$bypass_open_count" -gt 0 ]; then
    echo
    echo "| # | repository | requester | created | link |"
    echo "|---|---|---|---|---|"
    jq -r '"| \(.number) | \(.repository.full_name // .repository.name) | \(.requester.actor_name // "-") | \(.created_at) | \(.html_url) |"' "$work/bypass.jsonl"
  fi
} > "$OUT"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "would_fail_count=$would_fail_count"
    echo "bypass_count=$bypass_count"
    echo "bypass_open_count=$bypass_open_count"
  } >> "$GITHUB_OUTPUT"
fi
cat "$OUT"
