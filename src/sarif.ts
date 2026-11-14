// A closed SARIF 2.1.0 projection of one retained pull-request review. It
// follows the CLI's `--sarif` document and never copies the raw API document.

import type { ReviewOutcome } from "./index.js";
import type { components } from "./schema.js";
import { ProoflineError, VERSION } from "./transport.js";

type Finding = components["schemas"]["CustomerFinding"];
type EvidenceRef = components["schemas"]["CustomerEvidenceRef"];
type CodeAssessment = components["schemas"]["CustomerCodeAssessment"];

const SCHEMA =
  "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json";
// The public environment risk-domain catalog, in the CLI's rule order.
const DOMAINS = [
  "artifact_identity",
  "deployment_workflow",
  "runtime_configuration",
  "network_reachability",
  "iam_permissions",
  "datastore_compatibility",
  "resource_capacity",
  "rollout_topology",
  "runtime_architecture",
  "environment_binding",
  "dependency_reachability",
  "data_integrity",
  "external_side_effects",
  "application_security",
  "scalability",
  "availability_resilience",
  "observability",
  "source_coverage",
];
// The CODE categories, listed after the environment domains when a usable
// CODE record exists.
const CODE_DOMAINS = [
  "logic",
  "edge_case",
  "error_handling",
  "state_transition",
  "concurrency",
  "resource_lifecycle",
  "credential_exposure",
  "authorization",
  "injection",
  "test_quality",
  "api_contract",
  "prompt_instruction",
  "doc_drift",
  "ci_workflow",
  "maintainability",
  "test_marker",
  "removed_assertion",
  "debug_residue",
  "committed_secret",
];
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const UINT32_MAX = 0xffff_ffff;

export type SarifLevel = "error" | "warning";

/** Why an evidence reference is or is not a location at the reviewed head. */
export type SarifLocationStatus =
  | "LOCATED"
  | "NO_VERIFIED_REVIEWED_LOCATION"
  | "NON_CODE_REFERENCE"
  | "COMPANION_REPOSITORY"
  | "UNVERIFIED_PROVENANCE"
  | "COMMIT_UNAVAILABLE"
  | "INVALID_COMMIT"
  | "DIFFERENT_COMMIT"
  | "INVALID_PATH"
  | "INVALID_REGION";

export interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string; uriBaseId: "%SRCROOT%" };
    region: { startLine: number; endLine: number };
  };
}

export interface SarifEvidenceReference {
  kind: string;
  provenanceStatus: string | null;
  commitSha: string | null;
  companionRepository: string | null;
  repositoryPath: string | null;
  startLine: number | null;
  endLine: number | null;
  locationStatus: SarifLocationStatus;
}

export interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: SarifLevel;
  message: { text: string };
  /** The first verified location at the reviewed head, or empty. */
  locations: SarifLocation[];
  /** The retained fingerprint that correlates a finding across runs. */
  partialFingerprints?: { "prooflineFinding/v1": string };
  /** Later distinct verified locations. Absent when there are none. */
  relatedLocations?: SarifLocation[];
  properties: {
    findingId: string;
    assessmentId: string;
    lane: "ENV" | "CODE";
    environment?: string;
    lifecycleState: string;
    locationStatus: SarifLocationStatus;
    remediation?: string;
    evidenceReferences: SarifEvidenceReference[];
  };
}

export interface SarifNotification {
  level: SarifLevel;
  message: { text: string };
  properties: { assessmentId?: string; reasonCode: string };
}

export interface SarifRun {
  tool: {
    driver: { name: "Proofline"; version: string; rules: { id: string }[] };
  };
  invocations: [
    {
      /** True only for a complete review with no notification. */
      executionSuccessful: boolean;
      toolExecutionNotifications: SarifNotification[];
    },
  ];
  results: SarifResult[];
  properties: {
    reviewId: string;
    organizationId: string;
    reviewUrl: string;
    headCommitSha: string;
    repository: string | null;
    pullRequestNumber: number | null;
    runNumber: number | null;
    reviewStatus: string;
    /** Null while the review has not finished. */
    outcome: "COMPLETED" | "INCOMPLETE" | "FAILED" | "STOPPED" | null;
    assessmentCount: number;
    assessments: {
      id: string;
      environment: string;
      status: string;
      gapReasons: string[];
    }[];
    codeAssessment?: {
      id: string;
      status: string;
      baseCommitSha: string;
      headCommitSha: string;
      gapReasons: string[];
    };
  };
}

export interface SarifLog {
  $schema: string;
  version: "2.1.0";
  runs: [SarifRun];
}

function refused(detail: string): ProoflineError {
  return new ProoflineError(0, "urn:proofline:sdk:sarif-refused", detail);
}

function control(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

// Refusals quote server text, so control characters never reach a terminal.
function oneLine(value: unknown): string {
  let text = "";
  for (const character of String(value)) {
    const code = character.codePointAt(0) ?? 0;
    text +=
      character === "\n" || character === "\t"
        ? " "
        : control(code)
          ? "�"
          : character;
  }
  return text;
}

// SARIF 3.11.5 and 3.11.6 read braces and embedded links even in plain text.
function literal(raw: string): { text: string } {
  return {
    text: raw.replace(/[{}\\[\]]/g, (character) =>
      character === "{" ? "{{" : character === "}" ? "}}" : `\\${character}`,
    ),
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function line(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= UINT32_MAX
    ? value
    : null;
}

function validPath(path: string): boolean {
  if (path.split("/").some((part) => ["", ".", ".."].includes(part)))
    return false;
  for (const character of path) {
    const code = character.codePointAt(0) ?? 0;
    if (
      control(code) ||
      character === "\\" ||
      character === ":" ||
      // Bidirectional controls can make a path display as another path.
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    )
      return false;
  }
  return true;
}

function pathUri(path: string): string {
  let uri = "";
  for (const byte of new TextEncoder().encode(path)) {
    const character = String.fromCharCode(byte);
    uri += /[A-Za-z0-9\-._~/]/.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return uri;
}

function codeLocation(
  reference: EvidenceRef,
  head: string,
): SarifLocationStatus | { path: string; start: number; end: number } {
  if (
    reference.kind === "companion_repository_file" ||
    (reference.companion_repository !== null &&
      reference.companion_repository !== undefined)
  )
    return "COMPANION_REPOSITORY";
  if (reference.kind !== "repository_file") return "NON_CODE_REFERENCE";
  if (reference.provenance_status !== "VERIFIED_REPOSITORY_READ")
    return "UNVERIFIED_PROVENANCE";
  const commit = text(reference.commit_sha);
  if (commit === null) return "COMMIT_UNAVAILABLE";
  if (!COMMIT.test(commit)) return "INVALID_COMMIT";
  if (commit.toLowerCase() !== head) return "DIFFERENT_COMMIT";
  const path = text(reference.repository_path);
  if (path === null || !validPath(path)) return "INVALID_PATH";
  const start = line(reference.start_line);
  if (start === null || start === 0) return "INVALID_REGION";
  const end =
    reference.end_line === null || reference.end_line === undefined
      ? start
      : line(reference.end_line);
  if (end === null || end < start) return "INVALID_REGION";
  return { path, start, end };
}

function findingResult(
  finding: Finding,
  source: { assessmentId: string; environment: string | null },
  head: string,
): SarifResult {
  if (
    typeof finding !== "object" ||
    finding === null ||
    typeof finding.id !== "string" ||
    typeof finding.claim !== "string" ||
    typeof finding.impact !== "string" ||
    typeof finding.lifecycle_state !== "string" ||
    !Array.isArray(finding.evidence_refs)
  )
    throw new ProoflineError(
      0,
      "urn:proofline:sdk:invalid-response",
      "a finding has no typed identity, text or evidence",
    );
  const level =
    finding.severity === "SERIOUS"
      ? "error"
      : finding.severity === "WARNING"
        ? "warning"
        : null;
  if (level === null)
    throw refused(
      `finding ${oneLine(finding.id)} has unsupported severity ${oneLine(finding.severity)}; SARIF export refused`,
    );
  const code = source.environment === null;
  const domains = code ? CODE_DOMAINS : DOMAINS;
  const domainIndex = domains.indexOf(finding.risk_domain);
  if (domainIndex < 0)
    throw refused(
      `finding ${oneLine(finding.id)} has unsupported risk domain ${oneLine(finding.risk_domain)}; SARIF export refused`,
    );
  const locations: SarifLocation[] = [];
  const seen = new Set<string>();
  const evidenceReferences = finding.evidence_refs.map((reference) => {
    const located = codeLocation(reference, head);
    if (typeof located !== "string") {
      const key = JSON.stringify([located.path, located.start, located.end]);
      if (!seen.has(key)) {
        seen.add(key);
        locations.push({
          physicalLocation: {
            artifactLocation: {
              uri: pathUri(located.path),
              uriBaseId: "%SRCROOT%",
            },
            region: { startLine: located.start, endLine: located.end },
          },
        });
      }
    }
    return {
      kind: String(reference.kind),
      provenanceStatus: text(reference.provenance_status),
      commitSha: text(reference.commit_sha),
      companionRepository: text(reference.companion_repository),
      repositoryPath: text(reference.repository_path),
      startLine: line(reference.start_line),
      endLine: line(reference.end_line),
      locationStatus: typeof located === "string" ? located : "LOCATED",
    } satisfies SarifEvidenceReference;
  });
  // A supporting citation does not claim that the fix changes that file, so
  // only the first verified citation is the primary location.
  const related = locations.splice(1);
  const remediation = text(finding.remediation);
  const fingerprint = text(finding.finding_fingerprint);
  return {
    ruleId: finding.risk_domain,
    ruleIndex: (code ? DOMAINS.length : 0) + domainIndex,
    level,
    message: literal(
      `${code ? "Code-only finding\n\n" : ""}${finding.claim}\n\n${finding.impact}`,
    ),
    locations,
    ...(fingerprint === null
      ? {}
      : { partialFingerprints: { "prooflineFinding/v1": fingerprint } }),
    ...(related.length ? { relatedLocations: related } : {}),
    properties: {
      // SARIF's guid cannot hold the recorded UUIDv7, so the occurrence ID
      // stays data instead of a fingerprint or correlation ID.
      findingId: finding.id,
      assessmentId: source.assessmentId,
      lane: code ? "CODE" : "ENV",
      ...(source.environment === null
        ? {}
        : { environment: source.environment }),
      lifecycleState: finding.lifecycle_state,
      locationStatus: locations.length
        ? "LOCATED"
        : "NO_VERIFIED_REVIEWED_LOCATION",
      ...(remediation === null ? {} : { remediation }),
      evidenceReferences,
    },
  };
}

function recorded(findings: unknown): Finding[] {
  if (!Array.isArray(findings))
    throw new ProoflineError(
      0,
      "urn:proofline:sdk:invalid-response",
      "an assessment has no finding list",
    );
  return findings;
}

function codeGap(code: CodeAssessment): string | null {
  if (code.incompleteness_kind) return code.incompleteness_kind;
  return code.status === "COMPLETED"
    ? null
    : "CODE_ASSESSMENT_STATE_UNAVAILABLE";
}

/**
 * Projects a review outcome with its usable CODE record, or null when the
 * review has none.
 */
export function sarifLog(
  outcome: ReviewOutcome,
  organizationId: string,
  code: CodeAssessment | null,
): SarifLog {
  if (typeof organizationId !== "string" || !organizationId)
    throw new TypeError("organizationId must be a nonempty string");
  const review = outcome.review;
  if (review === null)
    throw new TypeError("the outcome retains no review to export");
  if (review.kind !== "PULL_REQUEST")
    throw refused(
      `review ${oneLine(review.id)} has kind ${oneLine(review.kind)}; SARIF export requires a retained pull-request review`,
    );
  if (
    typeof review.head_commit_sha !== "string" ||
    !COMMIT.test(review.head_commit_sha)
  )
    throw refused(
      `review ${oneLine(review.id)} does not record a full commit SHA; SARIF export requires an immutable pull-request head`,
    );
  const head = review.head_commit_sha.toLowerCase();
  const results: SarifResult[] = [];
  const notifications: SarifNotification[] = [];
  const notify = (
    subject: string,
    reasonCode: string,
    assessmentId?: string,
  ) => {
    notifications.push({
      level: "error",
      message: literal(`${subject}: ${reasonCode}`),
      properties: {
        ...(assessmentId === undefined ? {} : { assessmentId }),
        reasonCode,
      },
    });
  };
  let codeAssessment: SarifRun["properties"]["codeAssessment"];
  if (code !== null) {
    for (const finding of recorded(code.findings))
      results.push(
        findingResult(
          finding,
          { assessmentId: code.id, environment: null },
          head,
        ),
      );
    const gap = codeGap(code);
    if (gap !== null) notify("Code-only", gap, code.id);
    codeAssessment = {
      id: code.id,
      status: code.status,
      baseCommitSha: code.base_commit_sha,
      headCommitSha: code.head_commit_sha,
      gapReasons: gap === null ? [] : [gap],
    };
  }
  const assessments = review.assessments.map((assessment) => {
    for (const finding of recorded(assessment.findings))
      results.push(
        findingResult(
          finding,
          {
            assessmentId: assessment.id,
            environment: assessment.environment_display_name,
          },
          head,
        ),
      );
    // The wait already named this assessment's gaps; none is derived here.
    const gapReasons = [
      ...new Set(
        outcome.gaps
          .filter((gap) => gap.assessmentId === assessment.id)
          .flatMap((gap) => gap.reasonCodes),
      ),
    ].sort();
    for (const reason of gapReasons)
      notify(assessment.environment_display_name, reason, assessment.id);
    return {
      id: assessment.id,
      environment: assessment.environment_display_name,
      status: assessment.status,
      gapReasons,
    };
  });
  if (outcome.status !== "COMPLETED")
    notify(
      `Review ${review.id}`,
      outcome.status === "TIMED_OUT"
        ? "REVIEW_IN_PROGRESS"
        : outcome.status === "FAILED"
          ? "REVIEW_FAILED"
          : outcome.status === "STOPPED"
            ? "REVIEW_STOPPED"
            : "REVIEW_RESULT_INCOMPLETE",
    );
  if (
    code === null &&
    ((review.code_assessment !== null &&
      review.code_assessment !== undefined) ||
      (review.assessment_count === 0 && review.assessments.length === 0))
  )
    notify("Code-only", "CODE_ASSESSMENT_UNAVAILABLE");
  return {
    $schema: SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Proofline",
            // The exporting SDK's version. The public review document does
            // not expose the reviewer's version.
            version: VERSION,
            rules: [...DOMAINS, ...(code === null ? [] : CODE_DOMAINS)].map(
              (id) => ({ id }),
            ),
          },
        },
        invocations: [
          {
            executionSuccessful:
              outcome.status === "COMPLETED" && notifications.length === 0,
            toolExecutionNotifications: notifications,
          },
        ],
        results,
        // The public API supplies no provider-qualified repository URI, so
        // the recorded SHA stays a property and no provenance is invented.
        properties: {
          reviewId: review.id,
          organizationId,
          reviewUrl: outcome.reviewUrl,
          headCommitSha: head,
          repository: review.repository_full_name ?? null,
          pullRequestNumber: review.pull_request_number ?? null,
          runNumber: review.run_number ?? null,
          reviewStatus: review.status,
          outcome: outcome.status === "TIMED_OUT" ? null : outcome.status,
          assessmentCount: review.assessment_count,
          assessments,
          ...(codeAssessment === undefined ? {} : { codeAssessment }),
        },
      },
    ],
  };
}
