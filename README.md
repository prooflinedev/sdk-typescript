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
