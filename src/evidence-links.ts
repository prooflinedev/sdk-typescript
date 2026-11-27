import type { components } from "./schema.js";

type EvidenceRef = components["schemas"]["CustomerEvidenceRef"];

/**
 * Why a reference has no source link. Checks run in this order, so the first
 * defect is the one reported, and `REPOSITORY_NOT_MAPPED` means the reference
 * would link once its repository is supplied:
 *
 * - `UNSUPPORTED_KIND`: not a `repository_file` or `companion_repository_file`
 *   reference, including kinds added to the contract later.
 * - `PROVENANCE_UNVERIFIED`: `provenance_status` is not `VERIFIED_REPOSITORY_READ`.
 * - `REPOSITORY_MISSING`: a companion reference records no `companion_repository`.
 * - `REPOSITORY_INVALID`: the recorded `companion_repository` is not an `owner/name`.
 * - `REPOSITORY_AMBIGUOUS`: a `repository_file` reference also names a
 *   `companion_repository`, so its repository is not known.
 * - `COMMIT_MISSING`: the reference records no `commit_sha`.
 * - `COMMIT_INVALID`: the recorded commit is not a full 40-character SHA, such as
 *   an abbreviated SHA or a branch name.
 * - `PATH_MISSING`: the reference records no `repository_path`.
 * - `PATH_INVALID`: the path is absolute, names a directory, or has an empty,
 *   `.` or `..` segment, a NUL, or text that cannot be encoded.
 * - `LINES_INVALID`: the cited lines are not 1-based integers with
 *   `start_line <= end_line`, or name an end without a start.
 * - `REPOSITORY_NOT_MAPPED`: the caller supplied no repository for this reference.
 */
export type EvidenceLinkUnavailableReason =
  | "UNSUPPORTED_KIND"
  | "PROVENANCE_UNVERIFIED"
  | "REPOSITORY_MISSING"
  | "REPOSITORY_INVALID"
  | "REPOSITORY_AMBIGUOUS"
  | "COMMIT_MISSING"
  | "COMMIT_INVALID"
  | "PATH_MISSING"
  | "PATH_INVALID"
  | "LINES_INVALID"
  | "REPOSITORY_NOT_MAPPED";

/** The repositories the caller allows links into. Nothing is inferred from evidence labels or URLs. */
export interface EvidenceRepositories {
  /**
   * The review's repository as `owner/name`, usually `review.repository_full_name`.
   * `repository_file` references link only into it. Null or absent leaves them unlinked.
   */
  repository?: string | null | undefined;
  /**
   * Companion repositories as `owner/name`, usually the `repository_full_name` of the
   * review's `COMPANION` subjects. A `companion_repository_file` reference links only
   * when its recorded `companion_repository` matches one, ignoring case, and the
   * link uses the spelling given here.
   */
  companions?: readonly string[] | undefined;
  /** The GitHub web origin. Defaults to `https://github.com`; pass a GitHub Enterprise Server origin to link there. */
  githubOrigin?: string | undefined;
}

/** A reference linked at its own recorded commit. */
export interface LinkedEvidence {
  /** The reference as recorded, the same object the finding holds. */
  evidence: EvidenceRef;
  /**
   * `{origin}/{owner}/{name}/blob/{commitSha}/{path}`, each path segment percent-encoded,
   * with a line fragment when the reference cites lines. Markdown line links
   * use GitHub's plain-text view.
   */
  url: string;
  reason: null;
  /** The caller-supplied `owner/name` the link points into. */
  repository: string;
  /** The reference's own full commit SHA, lowercased. */
  commitSha: string;
  /** The recorded repository path, unencoded. */
  path: string;
  /** The cited lines, with `start === end` for one line. Null when the reference cites none. */
  lines: { start: number; end: number } | null;
}

/** A reference preserved without a link, with the first reason it has none. */
export interface UnlinkedEvidence {
  /** The reference as recorded, the same object the finding holds. */
  evidence: EvidenceRef;
  url: null;
  reason: EvidenceLinkUnavailableReason;
}

export type EvidenceSourceLink = LinkedEvidence | UnlinkedEvidence;

const VERIFIED_READ = "VERIFIED_REPOSITORY_READ";
const FULL_SHA = /^[0-9a-f]{40}$/i;
// Git's all-zero object name stands for "no commit".
const NULL_SHA = "0".repeat(40);
// Owner and name are restricted to characters that need no URL encoding.
const OWNER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9_.-]+$/;
const HTTPS_ORIGIN = /^https:\/\/[^/?#@\\\s\p{Cc}]+\/?$/iu;
const MARKDOWN_PATH = /\.(?:markdown|mdown|mkdn|md)$/i;

/**
 * Returns one entry per `finding.evidence_refs` item, in recorded order. A
 * repository-file reference links to GitHub at its own recorded full commit SHA
 * and path; every other reference, and one that cannot be linked, is kept with a
 * typed reason. The reference's own `url`, the review's head, the pull request's
 * current head and branch names are never used. Any object with `evidence_refs`
 * works, such as a finding's `supporting_evidence`.
 *
 * Makes no request and never changes its arguments. Throws `TypeError` for an
 * invalid repository, companion or origin, or when `evidence_refs` is not an
 * array of objects.
 */
export function evidenceSourceLinks(
  finding: { readonly evidence_refs: readonly EvidenceRef[] },
  repositories: EvidenceRepositories,
): EvidenceSourceLink[] {
  const origin = githubOrigin(repositories.githubOrigin);
  const review =
    repositories.repository === null || repositories.repository === undefined
      ? null
      : ownerName(repositories.repository, "repository");
  const companions = new Map<string, string>();
  const listed = repositories.companions ?? [];
  if (!Array.isArray(listed))
    throw new TypeError("companions must be an array of owner/name strings");
  listed.forEach((companion: unknown, index) => {
    const name = ownerName(companion, `companions[${index}]`);
    const key = name.toLowerCase();
    if (!companions.has(key)) companions.set(key, name);
  });
  const references: unknown = isObject(finding)
    ? finding.evidence_refs
    : undefined;
  if (!Array.isArray(references))
    throw new TypeError("finding.evidence_refs must be an array");
  return references.map((evidence: unknown) => {
    if (!isObject(evidence))
      throw new TypeError("each evidence reference must be an object");
    return link(evidence as EvidenceRef, origin, review, companions);
  });
}

function link(
  evidence: EvidenceRef,
  origin: string,
  review: string | null,
  companions: ReadonlyMap<string, string>,
): EvidenceSourceLink {
  const unlinked = (
    reason: EvidenceLinkUnavailableReason,
  ): UnlinkedEvidence => ({
    evidence,
    url: null,
    reason,
  });
  const companion = evidence.kind === "companion_repository_file";
  if (!companion && evidence.kind !== "repository_file")
    return unlinked("UNSUPPORTED_KIND");
  if (evidence.provenance_status !== VERIFIED_READ)
    return unlinked("PROVENANCE_UNVERIFIED");

  const recorded: unknown = evidence.companion_repository;
  let companionKey: string | null = null;
  if (companion) {
    if (absent(recorded)) return unlinked("REPOSITORY_MISSING");
    if (!isOwnerName(recorded)) return unlinked("REPOSITORY_INVALID");
    companionKey = recorded.toLowerCase();
  } else if (!absent(recorded)) return unlinked("REPOSITORY_AMBIGUOUS");

  const sha: unknown = evidence.commit_sha;
  if (absent(sha)) return unlinked("COMMIT_MISSING");
  if (typeof sha !== "string" || !FULL_SHA.test(sha) || sha === NULL_SHA)
    return unlinked("COMMIT_INVALID");

  const path: unknown = evidence.repository_path;
  if (absent(path)) return unlinked("PATH_MISSING");
  const encodedPath = encodePath(path);
  if (typeof path !== "string" || encodedPath === null)
    return unlinked("PATH_INVALID");

  const lines = lineRange(evidence.start_line, evidence.end_line);
  if (lines === false) return unlinked("LINES_INVALID");

  // Checked last, so every earlier reason is a defect of the evidence itself.
  const repository =
    companionKey === null ? review : companions.get(companionKey);
  if (repository === undefined || repository === null)
    return unlinked("REPOSITORY_NOT_MAPPED");

  const commitSha = sha.toLowerCase();
  const anchor =
    lines === null
      ? ""
      : lines.start === lines.end
        ? `#L${lines.start}`
        : `#L${lines.start}-L${lines.end}`;
  const view = anchor && MARKDOWN_PATH.test(path) ? "?plain=1" : "";
  return {
    evidence,
    url: `${origin}/${repository}/blob/${commitSha}/${encodedPath}${view}${anchor}`,
    reason: null,
    repository,
    commitSha,
    path,
    lines,
  };
}

function absent(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOwnerName(value: unknown): value is string {
  if (typeof value !== "string" || !OWNER_NAME.test(value)) return false;
  const name = value.slice(value.indexOf("/") + 1);
  return name !== "." && name !== "..";
}

function ownerName(value: unknown, option: string): string {
  if (!isOwnerName(value))
    throw new TypeError(`${option} must be a GitHub owner/name`);
  return value;
}

function githubOrigin(value: unknown): string {
  if (value === undefined) return "https://github.com";
  // Check literal syntax before URL parsing can normalize inputs like `/repo/..`.
  if (typeof value === "string" && HTTPS_ORIGIN.test(value)) {
    try {
      return new URL(value).origin;
    } catch {
      // Refused below without echoing the value, which may hold credentials.
    }
  }
  throw new TypeError(
    "githubOrigin must be an HTTPS origin such as https://github.com",
  );
}

// Encodes each segment so the path cannot add a query, fragment or segment, and
// so the link survives Markdown and shells: RFC 3986 unreserved characters only.
function encodePath(path: unknown): string | null {
  if (typeof path !== "string" || path.includes("\0")) return null;
  const segments = path.split("/");
  if (segments.some((segment) => ["", ".", ".."].includes(segment)))
    return null;
  try {
    return segments
      .map((segment) =>
        encodeURIComponent(segment).replace(
          /[!'()*]/g,
          (character) =>
            `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
        ),
      )
      .join("/");
  } catch {
    // A lone UTF-16 surrogate has no UTF-8 encoding.
    return null;
  }
}

function lineNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 0xffff_ffff
  );
}

function lineRange(
  start: unknown,
  end: unknown,
): { start: number; end: number } | null | false {
  const noEnd = end === null || end === undefined;
  if (start === null || start === undefined) return noEnd ? null : false;
  if (!lineNumber(start)) return false;
  if (noEnd) return { start, end: start };
  if (!lineNumber(end) || end < start) return false;
  return { start, end };
}
