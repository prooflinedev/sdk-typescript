// Reads one commit's recorded deploy checks as `proofline ci deploy` does. A
// result is "no regression observed", never a claim about the deploy, and
// anything Proofline did not establish stays not established.
import type { components } from "./schema.js";
import { ProoflineError } from "./transport.js";

export type CommitDeploy = components["schemas"]["CommitDeploy"];
export type DeployCheckpoint = components["schemas"]["DeployCheckpoint"];

/** What one deploy's checks through `until` say. */
export type DeployReading =
  | "REGRESSED"
  | "WAITING"
  | "SUPERSEDED"
  | "UNVERIFIED"
  | "NOT_ESTABLISHED"
  | "NO_REGRESSION";

export interface DeployVerdictOptions {
  /** The check to read through; the checks before it count too. Defaults to `LANDING`. */
  until?: DeployCheckpoint;
  /** Which deploys to read. Defaults to every deploy of the commit. */
  select?: (deploy: CommitDeploy) => boolean;
}

export interface DeployVerdict {
  /**
   * `NO_REGRESSION` only when every selected deploy recorded `HEALTHY` with
   * no gap for each check through `until`. `WAITING` when no deploy is
   * selected or one has not recorded the `until` check: read again later.
   */
  status: "NO_REGRESSION" | "REGRESSED" | "NOT_ESTABLISHED" | "WAITING";
  until: DeployCheckpoint;
  /** Each selected deploy, as the server returned it, with its reading. */
  deploys: { deploy: CommitDeploy; reading: DeployReading }[];
}

const CHECKPOINTS: readonly DeployCheckpoint[] = [
  "LANDING",
  "MINUTES_20",
  "HOUR_1",
  "DAY_1",
];

// Keyed by every documented state, so a contract change fails the type check.
// A state a newer server adds is not one whose checks this SDK can read.
const STATES = {
  VERIFIED: true,
  VERIFIED_UNTIL_SUPERSEDED: true,
  SUPERSEDED: true,
  INCOMPLETE: true,
  UNRECORDED: true,
  NOT_YET_DUE: true,
  UNVERIFIED: true,
  FAILED: true,
  INACTIVE: true,
} satisfies Record<CommitDeploy["state"], true>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function wellFormed(deploy: unknown): deploy is CommitDeploy {
  return (
    isObject(deploy) &&
    typeof deploy.state === "string" &&
    typeof deploy.regressed === "boolean" &&
    Array.isArray(deploy.gaps) &&
    Array.isArray(deploy.checkpoints) &&
    deploy.checkpoints.every(isObject) &&
    // A repeated checkpoint leaves no single result to read.
    new Set(deploy.checkpoints.map((check) => check.checkpoint)).size ===
      deploy.checkpoints.length
  );
}

// A failure or recorded regression decides first. A deploy that can no longer
// record the named check is settled without it. Otherwise every check through
// the named one must be HEALTHY and name no gap.
function judge(deploy: CommitDeploy, until: DeployCheckpoint): DeployReading {
  const state: string = deploy.state;
  if (
    state === "FAILED" ||
    deploy.regressed ||
    deploy.checkpoints.some((check) => check.result === "REGRESSED")
  )
    return "REGRESSED";
  if (state === "UNVERIFIED") return "UNVERIFIED";
  if (!Object.hasOwn(STATES, state)) return "NOT_ESTABLISHED";
  const through = CHECKPOINTS.slice(0, CHECKPOINTS.indexOf(until) + 1).map(
    (name) => deploy.checkpoints.find((check) => check.checkpoint === name),
  );
  if (through.some((check) => check?.result === "SUPERSEDED"))
    return "SUPERSEDED";
  if ((through.at(-1)?.result ?? null) === null) return "WAITING";
  return through.every((check) => {
    // Older servers name only deploy-wide gaps, which then count for each check.
    const gaps: unknown = check?.gaps ?? deploy.gaps;
    return (
      check?.result === "HEALTHY" && Array.isArray(gaps) && gaps.length === 0
    );
  })
    ? "NO_REGRESSION"
    : "NOT_ESTABLISHED";
}

/**
 * Reads the response of `getCommitDeployVerifications` as `proofline ci
 * deploy` does. It sends nothing and waits for nothing. A commit with no
 * recorded deploy, a gap and a result this SDK does not know are never
 * `NO_REGRESSION`.
 */
export function judgeDeployVerifications(
  verifications: components["schemas"]["CommitDeployVerifications"],
  options: DeployVerdictOptions = {},
): DeployVerdict {
  const until = options.until ?? "LANDING";
  if (!CHECKPOINTS.includes(until))
    throw new TypeError(`until must be one of ${CHECKPOINTS.join(", ")}`);
  const all: unknown = isObject(verifications) ? verifications.deploys : null;
  if (
    !Array.isArray(all) ||
    !all.every(wellFormed) ||
    // `recorded: false` says the ledger holds no deploy of the commit.
    typeof verifications.recorded !== "boolean" ||
    (!verifications.recorded && all.length > 0)
  )
    throw new ProoflineError(
      0,
      "urn:proofline:sdk:invalid-response",
      "the deploy verifications are malformed",
    );
  const deploys = all
    .filter(options.select ?? (() => true))
    .map((deploy) => ({ deploy, reading: judge(deploy, until) }));
  const readings = deploys.map((item) => item.reading);
  // A regression ends the reading at once: nothing later can undo it.
  const status = readings.includes("REGRESSED")
    ? "REGRESSED"
    : readings.length === 0 || readings.includes("WAITING")
      ? "WAITING"
      : readings.every((reading) => reading === "NO_REGRESSION")
        ? "NO_REGRESSION"
        : "NOT_ESTABLISHED";
  return { status, until, deploys };
}
