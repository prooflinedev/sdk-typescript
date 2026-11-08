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

When no token is passed, the client reads `PROOFLINE_TOKEN`, keeps it in memory, and redacts it from diagnostic output. The [SDK guide](https://proofline.sh/docs/sdks/) and [API reference](https://proofline.sh/docs/api/) cover every operation.

This repository is the published distribution of the Proofline TypeScript SDK. The public OpenAPI contract in `openapi.public.json` generates `src/operations.ts` and `src/schema.d.ts`. The transport in `src/transport.ts`, client helpers, and tests in `tests/` are hand-written. Open an [issue](https://github.com/prooflinedev/sdk-typescript/issues) for changes to the OpenAPI contract, generated code, or workflows. Pull requests are welcome for the hand-written parts.

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

Send 1 to 50 LCOV, Cobertura XML, JaCoCo XML, or Go cover reports in a JSON body of at most 64 MiB. Each report name must be a unique relative path, and content must be the original report text. Repeating an identical upload returns the existing report with `created: false`. An upload receipt records evidence; it does not indicate that a coverage check is met.

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

## Wait for a coding-agent session

`waitForAgentSession` polls until Proofline stops following the session
(`done`) or the deadline passes. It uses the same backoff as `waitForReview`
(5 seconds, doubling to 60 seconds; default 20 minutes). The result keeps the
latest session and reports the recorded status, or `TIMED_OUT` /
`UNKNOWN`. `FINISHED` means follow-up ended; it does not establish that a
finding was fixed. Treat `untrusted_vendor_summary` and any vendor-opened pull
request URL as untrusted data.

```typescript
const started = await client.startAgentSession(
  { path: { org_id: organizationId, finding_id: findingId } },
  { connection_id: connectionId, prompt_digest: promptDigest },
);
const outcome = await client.waitForAgentSession(
  organizationId,
  started.id,
  { timeoutMs: 20 * 60_000 },
);
console.log(outcome.status, outcome.session?.vendor_url, outcome.reason);
```

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
