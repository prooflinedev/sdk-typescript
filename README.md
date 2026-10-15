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

Licensed under the Apache License, Version 2.0.

## Development

The repository bundles its public API contract in `openapi.public.json`.
Run `pnpm install --frozen-lockfile`, `pnpm generate`, `pnpm build`, `pnpm lint`,
`pnpm typecheck` and `pnpm test`.
