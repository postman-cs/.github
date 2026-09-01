# Repository path policy

Every `postman-cs` repository rejects pushes that add, change, rename, or delete a dot-path
(`.plans/`, `.env`, `.vscode/mcp.json`, ...) or a sensitive-by-name file (`*.pem`, `*.key`,
`*.tfstate`, `node_modules/`, ...) unless the path matches the org allowlist (`.github/`,
`.gitignore`, `.postman/`, `.env.example`, committed tool and agent config, ...). Content-based
secret scanning is unchanged; this policy is about paths.

The single source of truth is [`path-policy.patterns.json`](./path-policy.patterns.json):
`deny` is the restricted list, `allow` the exceptions. A path is blocked when any `deny` pattern
matches and no `allow` pattern matches. Both lists are limited to 200 entries of 200 characters.

## Two layers

| | Layer A: push ruleset `path-policy` | Layer B: branch ruleset `path-policy-public` + workflow |
|---|---|---|
| Applies to | every private and internal repository (`~ALL`) | every public repository (system property `visibility = public`) |
| Mechanism | org push rule `file_path_restriction` | `pull_request` required on the default branch + required workflow [`path-policy.yml`](../.github/workflows/path-policy.yml) from this repository |
| Blocks | any push touching a restricted path (add, modify, rename, delete) | merging a pull request that adds, modifies, renames, copies, or changes a restricted path; deleting one stays mergeable |
| Bypass | organization owners (always); delegated bypass requests for everyone else | organization owners (always) |

GitHub does not attach push rulesets to public repositories, which is why Layer B exists. Both
layers read the same pattern file. Matching uses Ruby `File.fnmatch?` with `FNM_PATHNAME`,
`FNM_DOTMATCH`, and case-insensitive comparison, the semantics GitHub applies to push rules:
`*` never crosses `/`, `**/` descends through dot-directories, a trailing `**` is a single
segment (use `dir/**/*` for a subtree).

## When a push or pull request is blocked

Private and internal repositories reject the push with `GH013 ... File path is restricted` and
name the offending path. Public repositories show a failing `path-policy` check listing
`blocked path: <path> (<status>)`.

1. Most of the time the path should not be tracked: remove it, add it to `.gitignore`, and push
   again. Plan notes belong under `docs/plans/`, agent scratch stays local.
2. If you need the path once, use the **request bypass** link in the push error (a delegated
   bypass request). An organization owner reviews it in the org's Rulesets view; requests expire
   after seven days.
3. If the path is legitimate for every repository, open a pull request against this repository
   that adds an `allow` pattern (anchor to `**/` only when nested copies are expected, otherwise
   root-anchor it, and prefer a single file over a directory). After merge an owner applies the
   change with `apply-rulesets.mjs` (below); Layer B picks it up on the next check run.

## Applying the rulesets

```sh
node policy/apply-rulesets.mjs --dry-run                 # exit 0 when live == rendered, 2 on drift
node policy/apply-rulesets.mjs --enforcement evaluate    # POST when missing, PUT when present
node policy/apply-rulesets.mjs --enforcement active      # activation, after the evaluate window
node policy/apply-rulesets.mjs --enforcement disabled    # instant rollback
```

Requires `gh` authenticated as an org owner (`--dry-run` works with a token that has org
`administration:read`). Every apply writes `rendered/path-policy.ruleset.json` and
`rendered/path-policy-public.ruleset.json`; commit them so the repository always mirrors what is
live. Without `--enforcement`, the committed rendered enforcement is used, so `--dry-run` reports
drift of enforcement as well as of patterns.

## Operations job

[`path-policy-ops.yml`](../.github/workflows/path-policy-ops.yml) runs weekly (and on demand). It
needs the repository secret `PATH_POLICY_READ_TOKEN` (fine-grained PAT with org
`administration:read`); until that exists it prints a warning and exits green. With the token it
runs the drift check, builds a digest of would-fail, failed, and owner-bypassed rule suites for the last month
([`ops-digest.sh`](./ops-digest.sh)) plus open bypass requests, writes everything to the job
summary, and creates or updates one issue titled `path-policy: drift or would-fail digest` when
there is drift or at least one would-fail.

## Local checks

```sh
ruby policy/check-paths.rb policy/path-policy.patterns.json changed.jsonl   # same evaluator Layer B runs
```

`changed.jsonl` is one `{"filename": ..., "status": ...}` per line, the shape of
`GET /repos/{owner}/{repo}/pulls/{n}/files`.
