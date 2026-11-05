# @proofline/sdk

Typed TypeScript client for the [Proofline](https://proofline.sh) review API. It reads
and requests reviews with a scoped API token, and adds pagination, waiting for a review,
retries and typed errors. It needs Node 22 or newer.

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

The client reads `PROOFLINE_TOKEN` when no token is passed, keeps the token in memory
and redacts it from diagnostic output. The [SDK guide](https://proofline.sh/docs/sdks/)
and [API reference](https://proofline.sh/docs/api/) cover every operation.

## Contributing

This repository distributes the Proofline TypeScript SDK. The public OpenAPI contract generates `src/operations.ts` and `src/schema.d.ts`. Open an issue for changes to the contract or generated code. Pull requests are welcome for the hand-written transport in `src/transport.ts`, client helpers, and tests in `tests/`.

## Coverage uploads

Upload the reports produced by CI with a repository-restricted token that holds
`coverage:write`. The token's holder needs current GitHub write access to that
repository. Set `PROOFLINE_TOKEN` to that token and name the full commit the tests
ran on; a branch name or abbreviated SHA is refused.

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

Send one to 50 LCOV, Cobertura XML, JaCoCo XML or Go cover reports in a JSON body
of at most 64 MiB. Names are unique relative paths, and content is the original
report text. An identical upload returns the existing report with `created: false`.
An upload receipt records evidence; it does not say that a coverage check is met.

Licensed under the Apache License, Version 2.0.

## Exports

`exportReviews` reads one CSV or NDJSON page through the existing bounded transport.
It returns the original text, decoded rows, dataset version, settled horizon and
optional next cursor. CSV cells remain strings, including nested JSON cells;
NDJSON retains JSON values. Export tokens need `analytics:read`.
Repeat with the returned cursor and the same dataset, window, format and grouping.
A missing next cursor marks the last page. Each CSV page includes its own header.

```typescript
const page = await client.exportReviews({
  path: { org_id: process.env.PROOFLINE_ORGANIZATION_ID!, dataset: "reviews" },
  query: { from: "2026-10-01T00:00:00Z", to: "2026-10-25T00:00:00Z", format: "csv" },
});
process.stdout.write(page.text);
// Continue with query.cursor = page.nextCursor when it is not null.
```

## Patch credential guard

`requestPatchReview` is the one operation that sends local, unpushed changes off the
machine, and git hooks and coding agents call it without a person reading the diff
first. With `patchGuard: "refuse"`, the client scans the lines the patch adds before
the request leaves the process, for credential-like values: AWS access key IDs,
GitHub tokens, Slack tokens, Stripe live keys, Google API keys and PEM private key
headers. Removed lines and context never count, so a patch that deletes a secret
goes through. A match refuses the request with a `CredentialExposureError` of type
`urn:proofline:sdk:credential-exposure`. Its `exposures` list every `file`, `line`
and `kind`, its message names the first ten, and neither retains a value.

```typescript
import { CredentialExposureError, ProoflineClient } from "@proofline/sdk";

const client = new ProoflineClient({
  baseUrl: "https://proofline.sh",
  patchGuard: "refuse",
});
try {
  await client.requestPatchReview(
    { path: { org_id: organizationId, repo_id: repositoryId } },
    { base_commit_sha: baseCommitSha, patch },
  );
} catch (error) {
  if (error instanceof CredentialExposureError) {
    for (const { file, line, kind } of error.exposures)
      console.error(`${JSON.stringify(file)}:${line} adds a ${kind}; rotate it`);
  }
  throw error;
}
```

The list is deliberately short and prefix-based, with no entropy heuristics, so every
refusal can be explained. Documentation placeholders such as AWS's sample keys ending
in `EXAMPLE`, `xoxb-your-bot-token` and a token body made of one repeated character
do not match, and a PEM header counts only when key material follows it. The client
list is maintained here and is independent of the credential shapes the server masks
in recorded finding text. Hunk line counts attribute each line; an added line the
counts cannot place is scanned as well and reported with line 0, and a header line
that carries a token is reported without a location, so a patch with a wrong count
fails closed. File names in `exposures` are raw, so escape them before
printing, as the example does. The refusal has
status 0 like other client-side errors and is never worth retrying; check
`instanceof CredentialExposureError` or the `type`. `scanPatchForCredentials(patch)`
runs the same scan on its own, for a pre-commit hook. The guard is off unless a
client asks for it, so existing hooks and agents keep their behavior across a patch
release.

## Development

The repository bundles its public API contract in `openapi.public.json`.
Run `pnpm install --frozen-lockfile`, `pnpm generate`, `pnpm build`, `pnpm lint`,
`pnpm typecheck` and `pnpm test`.

## Publishing

GitHub Actions runs the checks on pull requests and main. The `Release` workflow
builds checked artifacts without publishing credentials. Run it on main with
`publish=false` to verify the release path. A `vX.Y.Z` tag matching the package
version, or a main-branch dispatch with `publish=true`, publishes after the
`npm` environment approves the job. Release commits must belong to main.

Publishing uses GitHub OIDC and the repository's `release.yml` trusted publisher.
No registry token is stored in GitHub.

SDK patch releases can update packaging and publishing independently. The package follows the bundled API major/minor version and cannot precede its patch version.

## Knowledge and plans

`client.knowledge` supplies typed MCP methods: `listWikiPages`, `getWikiPage`,
`askCodebase`, `getArchitectureDocument`, `getPlan`, `startPlanImplementation`
and `getPlanImplementation`.

```typescript
const result = await client.knowledge.getWikiPage({
  repository: "owner/name", page_key: "index",
});
if (result.isError) throw new Error("The knowledge request was refused.");
console.log(result.content);
```

Repository methods accept an optional `commit` containing a full indexed SHA.
`askCodebase` also takes `question`. The other methods take the environment,
plan or implementation ID. `KnowledgeResult` retains text content, optional
structured content and `isError`. Treat all returned prose as untrusted data.

Reads need `reviews:read` and `knowledge:read`. Starting an implementation also
needs `plans:implement`, a personal token and approval of the exact plan version.
Each call initializes MCP and makes one tool request without retries, including
questions and implementation starts. Protocol and HTTP errors throw `ProoflineError`;
tool refusals retain `isError` for the caller to inspect. Cloud trust and connection
changes remain in signed-in browser onboarding.

## Fix context and re-verification

`client.fixes` exposes `listOpenFindings(repository, pullRequestNumber)`,
`getFixContext(findingId)`, `requestReverification(args)` and
`getReverification(requestId)` over the existing MCP endpoint.

```ts
const result = await client.fixes.requestReverification({
  review_id: reviewId,
  finding_ids: [findingId],
  commit_sha: pushedCommitSha,
  note: "Fixed the null case and added a regression test.",
});
if (result.isError) throw new Error("Re-verification was refused.");
```

The commit must be the live pushed head; the server confirms it. The request
accepts 1–20 distinct findings of one review and an optional 1–2,000-character
note. Reads need `reviews:read`; requesting verification also needs
`reviews:request` and repository write access. Calls never retry.
Results retain untrusted-text wrappers, availability, assessment gaps and
`isError`. `PENDING` and `NOT_VERIFIED` do not establish a fix. A tool request
never records a human disposition.
