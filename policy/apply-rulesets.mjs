#!/usr/bin/env node
// Render and apply the postman-cs path-policy org rulesets from policy/path-policy.patterns.json.
//
//   node policy/apply-rulesets.mjs --dry-run                 # diff rendered vs live; exit 0 clean, 2 drift
//   node policy/apply-rulesets.mjs --enforcement evaluate    # create (POST) or update (PUT) both rulesets
//   node policy/apply-rulesets.mjs --enforcement active|disabled
//
// Without --enforcement the enforcement of each committed policy/rendered/<name>.ruleset.json is
// used (default "evaluate"), so --dry-run detects live drift against what is committed.
// Requires `gh` authenticated as an org owner (apply) or with org administration:read (dry-run).
// Node >= 20, no dependencies.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ORG = "postman-cs";
const SOURCE_REPO = `${ORG}/.github`;
const WORKFLOW = { path: ".github/workflows/path-policy.yml", ref: "refs/heads/main" };
const NAMES = { push: "path-policy", branch: "path-policy-public" };
const ENFORCEMENTS = ["evaluate", "active", "disabled"];
const LIMIT = { entries: 200, chars: 200 };
const BYPASS_ACTORS = [{ actor_id: null, actor_type: "OrganizationAdmin", bypass_mode: "always" }];
const COMPARED_KEYS = ["name", "target", "enforcement", "bypass_actors", "conditions", "rules"];

const here = dirname(fileURLToPath(import.meta.url));
const renderedDir = join(here, "rendered");

function die(msg, code = 1) {
  console.error(`apply-rulesets: ${msg}`);
  process.exit(code);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const enforcementIdx = args.indexOf("--enforcement");
const enforcementArg = enforcementIdx >= 0 ? args[enforcementIdx + 1] : null;
if (enforcementIdx >= 0 && !ENFORCEMENTS.includes(enforcementArg)) die(`--enforcement must be one of ${ENFORCEMENTS.join("|")}`);
if (!dryRun && enforcementArg === null) die("pass --dry-run or --enforcement <evaluate|active|disabled>");
for (const a of args) if (!["--dry-run", "--enforcement", enforcementArg].includes(a)) die(`unknown argument ${a}`);

function gh(argv, input) {
  try {
    return execFileSync("gh", ["api", ...argv], { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    die(`gh api ${argv.join(" ")} failed\n${err.stderr ?? ""}${err.stdout ?? ""}`);
  }
}

// ---- patterns -------------------------------------------------------------
const patterns = JSON.parse(readFileSync(join(here, "path-policy.patterns.json"), "utf8"));
const extraKeys = Object.keys(patterns).filter((k) => !["deny", "allow"].includes(k));
if (extraKeys.length) die(`patterns file has unexpected keys: ${extraKeys.join(", ")}`);
for (const key of ["deny", "allow"]) {
  const list = patterns[key];
  if (!Array.isArray(list) || list.length === 0 || list.length > LIMIT.entries) die(`${key}: need 1..${LIMIT.entries} patterns, got ${list?.length}`);
  for (const p of list) {
    if (typeof p !== "string" || p.length === 0 || p.length > LIMIT.chars || /\s/.test(p)) die(`${key}: invalid pattern ${JSON.stringify(p)} (1..${LIMIT.chars} chars, no whitespace)`);
  }
  if (new Set(list).size !== list.length) die(`${key}: duplicate patterns`);
}

// ---- renderers ------------------------------------------------------------
function renderPush(enforcement) {
  return {
    name: NAMES.push,
    target: "push",
    enforcement,
    bypass_actors: BYPASS_ACTORS,
    conditions: { repository_name: { include: ["~ALL"], exclude: [] } },
    rules: [
      { type: "file_path_restriction", parameters: { restricted_file_paths: patterns.deny, ignored_file_paths: patterns.allow } },
    ],
  };
}

function renderBranch(enforcement, sourceRepoId) {
  return {
    name: NAMES.branch,
    target: "branch",
    enforcement,
    bypass_actors: BYPASS_ACTORS,
    conditions: {
      ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
      repository_property: { include: [{ name: "visibility", source: "system", property_values: ["public"] }], exclude: [] },
    },
    rules: [
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
          require_extra_approval_for_unattributed_changes: false,
          required_reviewers: [],
          allowed_merge_methods: ["merge", "squash", "rebase"],
        },
      },
      {
        type: "workflows",
        parameters: {
          do_not_enforce_on_create: true,
          workflows: [{ repository_id: sourceRepoId, path: WORKFLOW.path, ref: WORKFLOW.ref }],
        },
      },
    ],
  };
}

// ---- diff -----------------------------------------------------------------
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function diff(rendered, live, path = "", out = []) {
  if (Array.isArray(rendered) && Array.isArray(live)) {
    if (rendered.length !== live.length && rendered.every((v) => typeof v === "string") && live.every((v) => typeof v === "string")) {
      out.push({ path, rendered_count: rendered.length, live_count: live.length, missing_in_live: rendered.filter((v) => !live.includes(v)), extra_in_live: live.filter((v) => !rendered.includes(v)) });
    } else if (rendered.length !== live.length) {
      out.push({ path, rendered, live });
    } else {
      rendered.forEach((v, i) => diff(v, live[i], `${path}[${i}]`, out));
    }
  } else if (isObj(rendered) && isObj(live)) {
    for (const k of new Set([...Object.keys(rendered), ...Object.keys(live)])) diff(rendered[k], live[k], path ? `${path}.${k}` : k, out);
  } else if (JSON.stringify(rendered) !== JSON.stringify(live)) {
    out.push({ path, rendered, live });
  }
  return out;
}
const project = (ruleset) => Object.fromEntries(COMPARED_KEYS.map((k) => [k, ruleset[k]]));
const renderedFile = (name) => join(renderedDir, `${name}.ruleset.json`);
const committed = (name) => (existsSync(renderedFile(name)) ? JSON.parse(readFileSync(renderedFile(name), "utf8")) : null);

// ---- main -----------------------------------------------------------------
const sourceRepoId = Number(gh([`repos/${SOURCE_REPO}`, "--jq", ".id"]).trim());
if (!Number.isInteger(sourceRepoId)) die(`could not resolve repository id of ${SOURCE_REPO}`);
// The org has well under 100 rulesets; a second page would need --paginate.
const liveList = JSON.parse(gh([`orgs/${ORG}/rulesets?per_page=100`]));

const plan = [
  { name: NAMES.push, render: (e) => renderPush(e) },
  { name: NAMES.branch, render: (e) => renderBranch(e, sourceRepoId) },
];
const report = {};
let drift = false;
for (const { name, render } of plan) {
  const matches = liveList.filter((r) => r.name === name && r.source_type === "Organization");
  if (matches.length > 1) die(`more than one org ruleset named ${name}: ${matches.map((r) => r.id).join(", ")}`);
  const existing = matches[0] ?? null;
  const enforcement = enforcementArg ?? committed(name)?.enforcement ?? "evaluate";
  const body = render(enforcement);
  if (dryRun) {
    const live = existing ? project(JSON.parse(gh([`orgs/${ORG}/rulesets/${existing.id}`]))) : null;
    const liveDiff = live ? diff(body, live) : [{ path: "", rendered: "ruleset", live: "missing (would POST)" }];
    const fileDiff = committed(name) ? diff(body, committed(name)) : [{ path: "", rendered: "rendered file", live: "missing (run with --enforcement to write it)" }];
    report[name] = { id: existing?.id ?? null, enforcement, live_diff: liveDiff, rendered_file_diff: fileDiff };
    if (liveDiff.length || fileDiff.length) drift = true;
  } else {
    const payload = JSON.stringify(body);
    const saved = JSON.parse(existing
      ? gh(["-X", "PUT", `orgs/${ORG}/rulesets/${existing.id}`, "--input", "-"], payload)
      : gh(["-X", "POST", `orgs/${ORG}/rulesets`, "--input", "-"], payload));
    mkdirSync(renderedDir, { recursive: true });
    writeFileSync(renderedFile(name), JSON.stringify(body, null, 2) + "\n");
    const postApplyDiff = diff(body, project(saved));
    report[name] = { id: saved.id, action: existing ? "updated" : "created", enforcement: saved.enforcement, post_apply_diff: postApplyDiff };
    if (postApplyDiff.length) drift = true;
  }
}
console.log(JSON.stringify(report, null, 2));
if (dryRun) process.exit(drift ? 2 : 0);
if (drift) die("live ruleset differs from the rendered body after apply; inspect post_apply_diff", 3);
