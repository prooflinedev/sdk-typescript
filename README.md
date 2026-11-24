# @proofline/sdk

`@proofline/sdk` is the typed TypeScript client for the [Proofline](https://proofline.sh) review API. It reads and requests reviews with a scoped API token, and supports pagination, waiting for a review, retries, and typed errors. It requires Node 22 or newer.

```sh
npm install @proofline/sdk
```

```typescript
import { ProoflineClient } from "@proofline/sdk";

const client = new ProoflineClient({
  baseUrl: "https://proofline.sh",
  token: process.env.PROOFLINE_TOKEN!,
});
```

When no token is passed, the client reads `PROOFLINE_TOKEN`, keeps it in memory, and redacts it from diagnostic output. When no `baseUrl` is passed, it reads `PROOFLINE_BASE_URL` and otherwise uses `https://proofline.sh`, as the CLI and the MCP bridge do, so `new ProoflineClient()` works for the hosted service. An empty variable counts as unset, and a value that is not an HTTPS origin or a loopback HTTP origin is refused by name. The [SDK guide](https://proofline.sh/docs/sdks/) and [API reference](https://proofline.sh/docs/api/) cover every operation.

This repository is the published distribution of the Proofline TypeScript SDK. The public OpenAPI contract in `openapi.public.json` generates `src/operations.ts` and `src/schema.d.ts`. The transport in `src/transport.ts`, client helpers, and tests in `tests/` are hand-written. Open an [issue](https://github.com/prooflinedev/sdk-typescript/issues) for changes to the OpenAPI contract, generated code, or workflows. Pull requests are welcome for the hand-written parts.

## Errors and refusals

A refused request throws `ProoflineError` with the server problem's `status`, `type`, `title` and `detail`. When a review request creates nothing, the error also carries `refusal`, whose `reason` names the setting to change, such as `NO_LINKED_ENVIRONMENT` or `ENVIRONMENT_NOT_READY`, and `repositoryName`. A refusal that does not match the public contract keeps its status, `title` and `detail` with the type `urn:proofline:sdk:invalid-response` and no `refusal`. Any other status, such as the 402 a review request answers when credits cannot pay, is a plain problem with no `refusal`. The token is redacted from every text field, and `String(error)`, `inspect(error)` and `JSON.stringify(error)` show only the status.

```typescript
import { ProoflineError } from "@proofline/sdk";

try {
  await client.requestReview({
    path: { org_id: organizationId, repo_id: repositoryId, number: 12 },
  });
} catch (error) {
  if (!(error instanceof ProoflineError) || error.refusal === undefined) throw error;
  if (error.refusal.reason === "NO_LINKED_ENVIRONMENT")
    console.error(`Link an environment to ${error.repositoryName}.`);
  else console.error(error.detail);
}
```

## Deploy verification

After a deploy lands, Proofline records up to four checks of it: at landing, 20 minutes, one hour and one day. `getCommitDeployVerifications` returns those checks for each deploy of a commit, and `judgeDeployVerifications` turns that response into one answer, by the rules of `proofline ci deploy`.

```typescript
import { judgeDeployVerifications } from "@proofline/sdk";

const giveUpAt = Date.now() + 30 * 60_000;
for (;;) {
  const verdict = judgeDeployVerifications(
    await client.getCommitDeployVerifications({
      path: { org_id: organizationId, repo_id: repositoryId, commit_sha: deployedCommitSha },
    }),
    {
      until: "MINUTES_20",
      select: (deploy) => deploy.github_environment === "production",
    },
  );
  if (verdict.status === "NO_REGRESSION") break;
  if (verdict.status !== "WAITING" || Date.now() > giveUpAt) {
    for (const { deploy, reading } of verdict.deploys)
      console.error(reading, deploy.deploy_url, deploy.gaps);
    throw new Error(`deploy checks: ${verdict.status}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 30_000));
}
```

`until` names the check to read through: `LANDING` (the default), `MINUTES_20`, `HOUR_1` or `DAY_1`. The checks before it count too. `select` chooses which deploys to read; without it every deploy of the commit counts.

The status is one of four. `NO_REGRESSION` means every selected deploy recorded `HEALTHY` with no gap for each check through `until`. `REGRESSED` means a selected deploy failed or any of its checks recorded `REGRESSED`, whatever the others say. `NOT_ESTABLISHED` means a selected deploy was superseded, has no verification, names a gap, or recorded a result or state this SDK does not know. `WAITING` means no deploy is selected yet, or one has not recorded the `until` check. `proofline ci deploy` exits 0, 3 and 2 for the first three, and keeps waiting on the fourth until its timeout, then exits 2.

The function reads one response. It sends nothing and waits for nothing, so the loop, the interval and the time to give up are yours, as above. `WAITING` at your deadline is not a result.

`NO_REGRESSION` says only that the recorded checks observed no regression. A commit with no recorded deploy, a selection that matches none, a gap and an unknown result or state are never `NO_REGRESSION`. A response that contradicts the contract, such as deploys beside `recorded: false` or a checkpoint listed twice, throws `ProoflineError` with type `urn:proofline:sdk:invalid-response`. `verdict.deploys` keeps each selected deploy as the server returned it, beside its own reading.

Proofline records the landing of a run's deploy only after the run completes, so a GitHub Actions job that waits for a deploy its own run created stays `WAITING`. Read the checks from a [separate workflow](https://proofline.sh/docs/ci/#read-the-checks-from-a-separate-workflow).

## Coverage uploads

Upload CI coverage reports with a repository-restricted token that holds `coverage:write`. The token holder must have current GitHub write access to that repository. Set `PROOFLINE_TOKEN` to that token and pass the full commit SHA that the tests ran on. The server refuses branch names and abbreviated SHAs.

```typescript
import { readFile } from "node:fs/promises";

const report = await client.uploadCoverageReports(
  { path: { org_id: organizationId, repo_id: repositoryId } },
  {
    tested_sha: testedCommitSha,
    reports: [
      { name: "lcov.info", content: await readFile("coverage/lcov.info", "utf8") },
    ],
  },
);
console.log(report.report_id, report.created);
```

To upload reports straight from disk, `uploadCoverageFiles` reads each file as UTF-8 text and names it by its path relative to `root`, which defaults to the working directory. Pass `{ path, name }` to choose a different report name.

```typescript
const report = await client.uploadCoverageFiles(
  { path: { org_id: organizationId, repo_id: repositoryId } },
  {
    tested_sha: testedCommitSha,
    files: ["coverage/lcov.info", { path: "go/cover.out", name: "go/coverage.out" }],
  },
);
```

It throws a `TypeError` before sending anything when the SHA is abbreviated, the report count is outside 1 to 50, two reports share a name, a name escapes `root`, a file is not UTF-8 text, or the body would exceed 30 MiB. File system errors such as a missing report are thrown unchanged.

Send 1 to 50 LCOV, Cobertura XML, JaCoCo XML, or Go cover reports in a JSON body of at most 30 MiB. Each report name must be a unique relative path, and content must be the original report text. Repeating an identical upload returns the existing report with `created: false`. An upload receipt records evidence; it does not indicate that a coverage check is met.

## Review exports

`exportReviews` reads one CSV or NDJSON page through the bounded transport. Export tokens require `analytics:read`. Each call returns the original text, decoded rows, dataset version, settled horizon, and an optional next cursor. CSV cells remain strings, including nested JSON cells, while NDJSON retains JSON values. Each CSV page includes its own header.

To read subsequent pages, repeat the call with the returned cursor and the same dataset, window, format, and grouping. A missing next cursor marks the last page.

```typescript
const page = await client.exportReviews({
  path: { org_id: process.env.PROOFLINE_ORGANIZATION_ID!, dataset: "reviews" },
  query: { from: "2026-10-01T00:00:00Z", to: "2026-10-25T00:00:00Z", format: "csv" },
});
process.stdout.write(page.text);
// Continue with query.cursor = page.nextCursor when it is not null.
```

`iterExportPages` follows the cursors for you, sending every page with the first call's dataset, window, format and grouping.

```typescript
for await (const page of client.iterExportPages({
  path: { org_id: process.env.PROOFLINE_ORGANIZATION_ID!, dataset: "reviews" },
  query: { from: "2026-10-01T00:00:00Z", to: "2026-10-25T00:00:00Z" },
})) {
  for (const row of page.rows) console.log(row);
}
```

Set `query.cursor` to resume an export. Iteration stops only when a page has no next cursor, including after a page with no rows. An empty or repeated cursor throws `ProoflineError` with type `urn:proofline:sdk:invalid-pagination`, and the page that carries it is not yielded. The default bound is 100 pages; pass `{ maxPages }` with an integer from 1 to 1000. Running out of pages while a cursor remains throws `urn:proofline:sdk:pagination-limit`, so a partial export never looks complete.

## MCP organization selection

With an MCP OAuth credential approved for several organizations, call `client.mcp.listOrganizations()` to discover its currently authorized targets. The `KnowledgeResult` retains `isError` and `structuredContent.data.organizations`; each organization entry contains `organization_id`, `github_login`, and `scopes`.

Every `knowledge` and `fixes` helper accepts an optional organization UUID string. Object-taking methods accept `organization_id` in their argument object. Methods taking scalar arguments accept a final `McpTarget` options object:

```typescript
const organizations = await client.mcp.listOrganizations();
if (organizations.isError) throw new Error("Organization discovery was refused.");
console.log(organizations.structuredContent?.data);
// Set organizationId to the UUID of the organization you intend to use.
const context = await client.fixes.getFixContext(findingId, {
  organization_id: organizationId,
});
const page = await client.knowledge.getWikiPage({
  repository: "owner/name", page_key: "index", organization_id: organizationId,
});
```

Selection applies only to that call, including concurrent calls on one client. A single-organization credential can omit it. An ambiguous omission retains the server's `ORGANIZATION_REQUIRED` tool refusal; a foreign or revoked target retains `NOT_AUTHORIZED` and `isError`. The SDK chooses no default and never retries a tool call. Discovery and targeting use MCP only; an MCP OAuth credential cannot call the REST API. Each organization's scopes and repository restrictions still apply.

## Knowledge and plans

`client.knowledge` provides typed MCP methods: `listWikiPages`, `getWikiPage`, `askCodebase`, `getArchitectureDocument`, `getPlan`, `startPlanImplementation`, and `getPlanImplementation`.

```typescript
const result = await client.knowledge.getWikiPage({
  repository: "owner/name", page_key: "index",
});
if (result.isError) throw new Error("The knowledge request was refused.");
console.log(result.content);
```

Repository methods accept an optional `commit` containing a full indexed SHA, and `askCodebase` also takes `question`. The other methods take the environment, plan, or implementation ID. `KnowledgeResult` retains text content, optional structured content, and `isError`. Treat all returned prose as untrusted data.

Reads require `reviews:read` and `knowledge:read`. Starting an implementation also requires `plans:implement`, a personal token, and approval of the exact plan version. Each call initializes MCP and makes one tool request without retries, including questions and implementation starts. Protocol and HTTP errors throw `ProoflineError`, while tool refusals retain `isError` for the caller to inspect. Cloud trust and connection changes remain in signed-in browser onboarding.

## Fix context and re-verification

`client.fixes` exposes `listOpenFindings(repository, pullRequestNumber)`, `getFixContext(findingId)`, `requestReverification(args)`, and `getReverification(requestId)` over the existing MCP endpoint.

```ts
const result = await client.fixes.requestReverification({
  review_id: reviewId,
  finding_ids: [findingId],
  commit_sha: pushedCommitSha,
  note: "Fixed the null case and added a regression test.",
});
if (result.isError) throw new Error("Re-verification was refused.");
```

The commit must be the live pushed head, which the server confirms. Each request accepts 1 to 20 distinct findings from one review and an optional note of 1 to 2,000 characters. Reads require `reviews:read`; requesting re-verification also requires `reviews:request` and repository write access. Calls never retry. Results retain untrusted-text wrappers, availability, assessment gaps, and `isError`. `PENDING` and `NOT_VERIFIED` do not establish a fix, and a tool request never records a human disposition.

## Contributing and development

The repository bundles its public API contract in `openapi.public.json`. New public operations generate typed methods on `ProoflineClient` from their OpenAPI operation IDs. To regenerate the client and verify changes locally, run `pnpm install --frozen-lockfile`, `pnpm generate`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, and `pnpm test`.

## Publishing

GitHub Actions runs checks on pull requests and `main`. The `Release` workflow builds checked artifacts without publishing credentials. Run it on `main` with `publish=false` to verify the release path. A `vX.Y.Z` tag matching the package version, or a `main`-branch dispatch with `publish=true`, publishes after the `npm` environment approves the job. Release commits must belong to `main`.

Publishing uses GitHub OIDC and the repository's `release.yml` trusted publisher, so no registry token is stored in GitHub. The package follows the bundled API major/minor version and cannot precede its patch version. SDK patch releases can update packaging and publishing independently.

## License

Licensed under the Apache License, Version 2.0.
