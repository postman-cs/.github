# Postman Customer Success Engineering

We build open-source tooling and automation for API lifecycle management, helping enterprise teams onboard, govern, and scale their API programs with Postman.

## The Postman Enterprise Automation Suite

These actions form an onboarding pipeline that takes a service from an OpenAPI spec to a fully provisioned Postman workspace: spec upload, generated collections, repo-synced artifacts, and API Catalog visibility. Each can also run standalone.

| Action | Description |
|--------|-------------|
| [postman-resolve-service-token-action](https://github.com/postman-cs/postman-resolve-service-token-action) | Mint a service-account access token, resolve the team ID, and optionally write both to repo secrets |
| [postman-aws-spec-discovery-action](https://github.com/postman-cs/postman-aws-spec-discovery-action) | Discover AWS-backed services (API Gateway, AppSync, IaC, etc.) and export their OpenAPI specs |
| [postman-api-onboarding-action](https://github.com/postman-cs/postman-api-onboarding-action) | Composite orchestrator: runs bootstrap, repo sync, and Insights linking end to end |
| [postman-bootstrap-action](https://github.com/postman-cs/postman-bootstrap-action) | Workspace provisioning, spec upload, collection generation, and governance |
| [postman-smoke-flow-action](https://github.com/postman-cs/postman-smoke-flow-action) | Apply a curated flow.yaml to the Smoke collection created by bootstrap |
| [postman-repo-sync-action](https://github.com/postman-cs/postman-repo-sync-action) | Sync collections, environments, mocks, and monitors back to the repo and link the workspace to it |
| [postman-insights-onboarding-action](https://github.com/postman-cs/postman-insights-onboarding-action) | Link Postman Insights discovered services to API Catalog workspaces |

`postman-api-gateway-sync` is deprecated and archived. Use `postman-aws-spec-discovery-action` instead.

## Suggested sequence

```text
postman-resolve-service-token-action    mint access token + team ID
postman-aws-spec-discovery-action       optional: export the OpenAPI spec from AWS
                 |
                 v
postman-api-onboarding-action           bootstrap -> repo-sync -> insights
                 |
                 v
postman-smoke-flow-action               curated flow.yaml -> Smoke collection
```

1. Run `postman-resolve-service-token-action` first. It mints the service-account access token and resolves the team ID that the rest of the pipeline consumes, and it can refresh tokens on a schedule.
2. Add `postman-aws-spec-discovery-action` when the OpenAPI spec lives in AWS (API Gateway, AppSync, IaC exports). Its output feeds the onboarding action's `spec-url` input.
3. Call `postman-api-onboarding-action` for the standard path. The composite orchestrates bootstrap, repo sync, and Insights linking in order; the individual actions remain available when you need finer control.
4. Finish with `postman-smoke-flow-action` to apply a curated `flow.yaml` to the canonical Smoke collection, using the `workspace-id`, `spec-id`, and `smoke-collection-id` outputs from bootstrap.

## Worked examples

| Repo | What it shows |
|------|---------------|
| [postman-compile-time-assertions-demo](https://github.com/postman-cs/postman-compile-time-assertions-demo) | Pre-merge API contract gate built on the actions above: CI builds the service, replays the generated smoke and contract collections against it, and fails the PR on schema drift |
| [postman-service-account-onboarding-sample](https://github.com/postman-cs/postman-service-account-onboarding-sample) | Minimal workflow wiring the token mint into the composite onboarding action |

## Links

- [postman.com](https://www.postman.com)
- [Postman Learning Center](https://learning.postman.com)
