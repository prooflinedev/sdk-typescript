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

## Waiting for a review of a specific commit

A review request targets a pull request, and the review runs on whichever commit is its head when the request lands. If the branch moves first, the result describes other code. Pass the commit you are about to ship as `headCommitSha`, and `waitForReview` reports `COMPLETED` only for a review of that commit.

```typescript
const { review_id } = await client.requestReview({
  path: { org_id: organizationId, repo_id: repositoryId, number: 12 },
});
const outcome = await client.waitForReview(organizationId, review_id, {
  headCommitSha: commitUnderTest,
});
if (outcome.status !== "COMPLETED")
  console.error(outcome.status, outcome.reason, outcome.reviewUrl);
```

The value must be 40 or 64 hexadecimal characters, upper or lower case. Anything else, `null` included, throws a `TypeError` before the first request. Leaving the option out or passing `undefined` turns the check off. If a read shows the review on a different commit, polling stops there and the result is `INCOMPLETE`, even when the review is still running or has failed, with `HEAD_COMMIT_MISMATCH` as the final gap. A finished review that records no head commit gets `HEAD_COMMIT_UNAVAILABLE` as its final gap and is never `COMPLETED`, while a pending one is polled as usual. A wait that runs out of time keeps its timeout reason and still lists the head gap. For a GitHub Actions run triggered by `pull_request`, `GITHUB_SHA` points at a temporary merge commit rather than the branch head, so pass `github.event.pull_request.head.sha` instead.

## Coverage uploads

Upload CI coverage reports with a repository-restricted token that holds `coverage:write`. The token holder must have current GitHub write access to that repository. Set `PROOFLINE_TOKEN` to that token and pass the full lowercase 40-character SHA of the commit the tests ran on.

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

The helper validates the commit SHA, the count of 1 to 50 reports, unique report names, UTF-8 content, and the 30 MiB body limit before sending a request. Each name must be a relative path with nonempty components. The helper refuses `.` and `..` components, backslashes, NUL characters, and a colon in the first component on every host. Invalid input raises a `TypeError`. File system errors such as a missing report retain their original error codes.

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
