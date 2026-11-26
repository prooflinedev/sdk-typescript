#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo 'Expected one SDK tarball.' >&2
  exit 1
fi

archive="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
compiler="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/node_modules/@typescript/native/bin/tsc"
consumer="$(mktemp -d)"
trap 'rm -rf -- "$consumer"' EXIT

cd "$consumer"
npm install --ignore-scripts --no-audit --no-fund --no-package-lock "$archive"

cat > check.mts <<'EOF'
import { ProoflineClient } from "@proofline/sdk";

if (typeof ProoflineClient.prototype.waitForReview !== "function") {
  throw new Error("Missing SDK export");
}
EOF

node check.mts
node "$compiler" --noEmit --strict --target es2022 --module nodenext check.mts
