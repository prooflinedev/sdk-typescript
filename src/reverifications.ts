import type { components } from "./schema.js";
import { ProoflineError } from "./transport.js";

type Review = components["schemas"]["CustomerReviewDetail"];
type Outcome = components["schemas"]["LocalReverificationOutcome"];

/** One named finding's re-verification against a local patch. */
export interface FindingReverification {
  /** The finding as the caller named it. */
  findingId: string;
  /** `RESOLVED_VERIFIED` and `STILL_PRESENT` only as the review recorded them. */
  outcome: Outcome;
  /** This request's number for the finding on this patch; null when unlisted. */
  iteration: number | null;
  /** The cited checks as the server returned them; null when unlisted. */
  checks: unknown;
  /** What the SDK saw when `outcome` is not the review's record; null otherwise. */
  reason: string | null;
}

// Keyed by every documented outcome, so a contract change fails the type check.
// True marks an outcome that ends a re-verification.
const finalOutcomes = {
  RESOLVED_VERIFIED: true,
  STILL_PRESENT: true,
  NOT_VERIFIED: true,
  PENDING: false,
} satisfies Record<Outcome, boolean>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(detail: string): ProoflineError {
  return new ProoflineError(0, "urn:proofline:sdk:invalid-response", detail);
}

/** Copies the caller's finding IDs: at least one nonempty string, each once. */
export function findingNames(value: unknown): string[] {
  // Copied so a caller that reuses its array cannot rename a wait in progress.
  const ids: unknown[] = Array.isArray(value) ? [...value] : [];
  if (
    ids.length === 0 ||
    !ids.every((id): id is string => typeof id === "string" && id !== "") ||
    new Set(ids.map((id) => id.toLowerCase())).size !== ids.length
  )
    throw new TypeError("findingIds must name at least one finding, each once");
  return ids;
}

/**
 * Reads each named finding's outcome from a patch review. A recorded final
 * outcome is returned as it is. Anything else is `PENDING` while the review is
 * unsettled and `NOT_VERIFIED` once it has settled, never `RESOLVED_VERIFIED`.
 */
export function localReverifications(
  review: Review | null,
  settled: boolean,
  findingIds: readonly string[],
): FindingReverification[] {
  const list: unknown = review?.local_reverifications ?? [];
  if (!Array.isArray(list))
    throw invalid("the local re-verifications are not a list");
  const recorded = new Map<
    string,
    { iteration: number; outcome: string; checks: unknown }
  >();
  for (const item of list) {
    if (
      !isObject(item) ||
      typeof item.finding_id !== "string" ||
      !item.finding_id ||
      typeof item.iteration !== "number" ||
      !Number.isSafeInteger(item.iteration) ||
      item.iteration < 1 ||
      typeof item.outcome !== "string"
    )
      throw invalid("a local re-verification is malformed");
    const key = item.finding_id.toLowerCase();
    if (recorded.has(key))
      throw invalid("the review contains duplicate local re-verifications");
    recorded.set(key, {
      iteration: item.iteration,
      outcome: item.outcome,
      checks: item.checks ?? null,
    });
  }
  const unanswered: Outcome = settled ? "NOT_VERIFIED" : "PENDING";
  return findingIds.map((findingId): FindingReverification => {
    const item = recorded.get(findingId.toLowerCase());
    if (item === undefined)
      return {
        findingId,
        outcome: unanswered,
        iteration: null,
        checks: null,
        reason:
          review === null
            ? "the review was not read before the wait ended"
            : "the review lists no re-verification of this finding",
      };
    const known = Object.hasOwn(finalOutcomes, item.outcome)
      ? (item.outcome as Outcome)
      : undefined;
    const asRecorded =
      known !== undefined && (finalOutcomes[known] || !settled);
    return {
      findingId,
      outcome: asRecorded ? known : unanswered,
      iteration: item.iteration,
      checks: item.checks,
      reason: asRecorded
        ? null
        : known === undefined
          ? "the review recorded an outcome this SDK does not know"
          : "the review ended while this finding was pending",
    };
  });
}
