import { ProoflineError } from "./transport.js";

export type CredentialKind =
  | "aws_access_key_id"
  | "github_token"
  | "slack_token"
  | "stripe_live_key"
  | "google_api_key"
  | "private_key";

/** Where a patch adds a credential-like value. The value itself is never retained. */
export interface CredentialExposure {
  file: string;
  line: number;
  kind: CredentialKind;
}

// High-precision prefixes only. No entropy heuristics: a refusal must be explainable.
// The first capture is the token body; a body made of one repeated character is a
// placeholder, not a credential. AWS's documented sample keys end in EXAMPLE, Slack
// tokens carry numeric segments after the prefix, and a PEM header counts only when
// key material follows it, so documentation placeholders and code that merely
// mentions a header do not match.
const PATTERNS: readonly [CredentialKind, RegExp][] = [
  [
    "aws_access_key_id",
    /\b(?:AKIA|ASIA)(?![0-9A-Z]{9}EXAMPLE\b)([0-9A-Z]{16})\b/,
  ],
  [
    "github_token",
    /\b(?:gh[pousr]_([A-Za-z0-9]{36,})|github_pat_([A-Za-z0-9_]{22,}))\b/,
  ],
  ["slack_token", /\bxox[abprs]-\d+-([0-9A-Za-z-]{10,})/],
  ["stripe_live_key", /\b[sr]k_live_([0-9A-Za-z]{16,})\b/],
  ["google_api_key", /\bAIza([0-9A-Za-z_-]{35})(?![0-9A-Za-z_-])/],
  [
    "private_key",
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:\s*$|\\n|\s*[A-Za-z0-9+/=]{20,})/,
  ],
];

function credentialKind(text: string): CredentialKind | undefined {
  for (const [kind, pattern] of PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const body = match.slice(1).find((group) => group !== undefined);
    if (body === undefined || !/^(.)\1*$/.test(body)) return kind;
  }
  return undefined;
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
};

// Git quotes paths with unusual bytes the way C does: "caf\303\251.env".
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"') || path.length < 2)
    return path;
  const bytes: number[] = [];
  const text = Array.from(path.slice(1, -1));
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? "";
    if (char !== "\\") {
      bytes.push(...new TextEncoder().encode(char));
      continue;
    }
    const next = text[i + 1] ?? "";
    const octal = /^[0-7]{1,3}/.exec(text.slice(i + 1, i + 4).join(""))?.[0];
    if (octal) {
      bytes.push(Number.parseInt(octal, 8));
      i += octal.length;
    } else if (next === "\\" || next === '"' || next in ESCAPES) {
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
      i += 1;
    } else {
      bytes.push(92); // Not an escape git writes: keep the backslash as it is.
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

// The new-side path of a `+++ ` header: unquoted, without a timestamp, and without
// the one-letter prefix git adds (b/, or w/ and i/ with diff.mnemonicPrefix) when
// the `diff --git` line shows that this patch carries prefixes.
function newPath(header: string, prefixed: boolean): string {
  const raw = header.slice(4);
  const path = unquote(
    raw.startsWith('"')
      ? raw.slice(0, raw.lastIndexOf('"') + 1)
      : (raw.split("\t")[0] ?? ""),
  );
  if (path === "/dev/null") return "";
  return prefixed ? path.replace(/^[a-z]\//, "") : path;
}

// Git pairs prefixes: a/ with b/, or with diff.mnemonicPrefix c/, i/ or o/ with i/ or w/.
const PREFIXED = /^diff --git "?(?:a\/.+ "?b\/|[cio]\/.+ "?[iw]\/)/;

/**
 * Lists credential-like values on the lines a unified diff adds, with their
 * file and new line number. Removed lines and context never count: they are
 * already in the repository, and a patch that deletes a secret must go through.
 *
 * Hunk line counts attribute lines, so content that happens to start with
 * `+++ ` or `--- ` inside a hunk is scanned like any other line. The scan fails
 * closed: a line that cannot belong to the hunk ends it, every `+` line outside
 * a counted hunk is scanned too and reported with line 0, and a `+++ ` header
 * is scanned as well and reported without a location.
 */
export function scanPatchForCredentials(patch: string): CredentialExposure[] {
  const exposures: CredentialExposure[] = [];
  let file = "";
  let prefixed = false;
  let gitHeader = false;
  let line = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let previous = "";
  for (const text of patch.split(/\r?\n/)) {
    let counted = oldLeft > 0 || newLeft > 0;
    if (counted && !/^[-+ \\]/.test(text) && text !== "") {
      // Not a hunk line: the hunk header overstated its counts, so the hunk ends here.
      oldLeft = 0;
      newLeft = 0;
      counted = false;
    }
    if (counted && text.startsWith("-")) {
      oldLeft -= 1;
    } else if (counted && !text.startsWith("+") && !text.startsWith("\\")) {
      line += 1;
      oldLeft -= 1;
      newLeft -= 1;
    } else if (text.startsWith("diff --git ")) {
      file = "";
      prefixed = PREFIXED.test(text);
      gitHeader = true;
    } else if (
      !counted &&
      text.startsWith("+++ ") &&
      previous.startsWith("--- ")
    ) {
      if (!gitHeader) prefixed = false;
      gitHeader = false;
      const kind = credentialKind(text);
      // A header that carries a token is reported without a location: the
      // path itself would be the value, whether it is a file name or content
      // that a wrong count pushed outside its hunk.
      if (kind) exposures.push({ file: "", line: 0, kind });
      else file = newPath(text, prefixed);
    } else if (text.startsWith("+")) {
      const kind = credentialKind(text);
      if (kind) exposures.push({ file, line: counted ? line : 0, kind });
      if (counted) {
        line += 1;
        newLeft -= 1;
      }
    } else {
      const hunk = HUNK_HEADER.exec(text);
      if (hunk) {
        oldLeft = Number(hunk[1] ?? 1);
        line = Number(hunk[2]);
        newLeft = Number(hunk[3] ?? 1);
      }
    }
    previous = text;
  }
  return exposures;
}

const LISTED_EXPOSURES = 10;

// A file name with control or non-ASCII characters is shown quoted, so a
// terminal that prints the message never receives a raw escape sequence.
function label(file: string): string {
  if (!file) return "?";
  return /^[\x20-\x7e]+$/.test(file) ? file : JSON.stringify(file);
}

function describe(exposures: readonly CredentialExposure[]): string {
  const listed = exposures
    .slice(0, LISTED_EXPOSURES)
    .map(({ file, line, kind }) => `${label(file)}:${line || "?"} (${kind})`)
    .join(", ");
  const more = exposures.length - LISTED_EXPOSURES;
  return `the patch adds ${exposures.length} credential-like value${
    exposures.length === 1 ? "" : "s"
  } at ${listed}${more > 0 ? ` and ${more} more` : ""}; nothing was sent`;
}

/** A patch review was refused before any request left the process. */
export class CredentialExposureError extends ProoflineError {
  readonly exposures: readonly CredentialExposure[];

  constructor(exposures: readonly CredentialExposure[]) {
    if (exposures.length === 0)
      throw new TypeError(
        "a credential exposure error names at least one exposure",
      );
    const retained = Object.freeze(
      exposures.map(({ file, line, kind }) =>
        Object.freeze({ file, line, kind }),
      ),
    );
    const detail = describe(retained);
    super(0, "urn:proofline:sdk:credential-exposure", detail);
    this.name = "CredentialExposureError";
    this.message = `patch review refused: ${detail}`;
    this.exposures = retained;
  }

  override toJSON(): {
    status: number;
    exposures: readonly CredentialExposure[];
  } {
    return { status: this.status, exposures: this.exposures };
  }
}

/** Refuses a patch review body whose added lines carry credentials. */
export function refuseExposedPatch(body: object | undefined): void {
  const patch = (body as { patch?: unknown } | undefined)?.patch;
  if (typeof patch !== "string") return;
  const exposures = scanPatchForCredentials(patch);
  if (exposures.length > 0) throw new CredentialExposureError(exposures);
}
