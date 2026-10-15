import { type ListReviewsParameters, Operations } from "./operations.js";
import type { components } from "./schema.js";
import { type ClientOptions, sleep, Transport } from "./transport.js";

export type * from "./operations.js";
export type { components, operations, paths } from "./schema.js";
export type { ClientOptions } from "./transport.js";
export { ProoflineError, SecretToken } from "./transport.js";

export type Review = components["schemas"]["CustomerReviewDetail"];
export type Assessment = components["schemas"]["CustomerAssessment"];
type CodeAssessment = components["schemas"]["CustomerCodeAssessment"];
export type ReviewStatus =
  | "COMPLETED"
  | "INCOMPLETE"
  | "FAILED"
  | "STOPPED"
  | "TIMED_OUT";

export interface AssessmentGaps {
  assessmentId: string;
  status: string;
  incompletenessKind: string | null;
  reasonCodes: string[];
  releaseEvidenceGap: string | null;
  checks: {
    name: string;
    outcome: string;
    detail: string | null;
    unresolvedReason: string | null;
  }[];
}

export interface ReviewOutcome {
  status: ReviewStatus;
  reviewUrl: string;
  review: Review | null;
  gaps: AssessmentGaps[];
  reason: string | null;
}

export interface WaitOptions {
  timeoutMs?: number;
}

export class ProoflineClient extends Operations {
  readonly #transport: Transport;

  constructor(options: ClientOptions) {
    const transport = new Transport(options);
    super((method, path, parameters, body) =>
      transport.request(method, path, parameters, undefined, body),
    );
    this.#transport = transport;
  }

  async *iterReviews(
    parameters: ListReviewsParameters,
    options: { maxPages?: number; maxItems?: number } = {},
  ): AsyncGenerator<components["schemas"]["ReviewSummary"]> {
    const maxPages = integerLimit(options.maxPages ?? 100, "maxPages");
    const maxItems = integerLimit(options.maxItems ?? 10_000, "maxItems");
    const seen = new Set<string>();
    let count = 0;
    let cursor = parameters.query?.cursor;
    for (let index = 0; index < maxPages; index += 1) {
      const query = {
        ...parameters.query,
        ...(cursor === undefined ? {} : { cursor }),
      };
      const page = await this.listReviews({ ...parameters, query });
      if (
        !isObject(page) ||
        !Array.isArray(page.items) ||
        typeof page.truncated !== "boolean" ||
        (page.next_cursor !== undefined &&
          page.next_cursor !== null &&
          typeof page.next_cursor !== "string")
      )
        throw protocol("the review page has no typed collection metadata");
      for (const item of page.items) {
        if (count >= maxItems)
          throw protocol("the review collection exceeds maxItems");
        count += 1;
        yield item;
      }
      if (!page.truncated) {
        if (page.next_cursor)
          throw protocol(
            "the review page has an unexpected continuation cursor",
          );
        return;
      }
      if (
        !page.next_cursor ||
        page.next_cursor === cursor ||
        seen.has(page.next_cursor)
      )
        throw protocol("the review collection has no advancing cursor");
      seen.add(page.next_cursor);
      cursor = page.next_cursor;
    }
    throw protocol("the review collection exceeds maxPages");
  }

  async waitForReview(
    orgId: string,
    reviewId: string,
    options: WaitOptions = {},
  ): Promise<ReviewOutcome> {
    const timeout = options.timeoutMs ?? 20 * 60_000;
    if (!Number.isFinite(timeout) || timeout < 0)
      throw new TypeError("timeoutMs must be finite and nonnegative");
    const deadline = performance.now() + timeout;
    const url = this.#transport.reviewUrl(orgId, reviewId);
    let review: Review | null = null;
    let interval = 5_000;
    for (;;) {
      if (performance.now() >= deadline)
        return outcome(
          "TIMED_OUT",
          url,
          review,
          "the review did not finish before timeoutMs",
        );
      try {
        review = await this.#transport.request<Review>(
          "GET",
          "/api/v1/organizations/{org_id}/reviews/{review_id}",
          { path: { org_id: orgId, review_id: reviewId } },
          deadline,
        );
      } catch (error) {
        if (
          error instanceof ProoflineError &&
          error.type === "urn:proofline:sdk:timeout"
        )
          return outcome(
            "TIMED_OUT",
            url,
            review,
            "the review did not finish before timeoutMs",
          );
        if (
          error instanceof ProoflineError &&
          error.status === 0 &&
          performance.now() >= deadline
        )
          return outcome(
            "TIMED_OUT",
            url,
            review,
            "the review did not finish before timeoutMs",
          );
        throw error;
      }
      validateReview(review, reviewId);
      const status = terminal(review);
      if (status !== null)
        return outcome(
          status,
          url,
          review,
          status === "INCOMPLETE"
            ? review.assessment_count === 0 && review.assessments.length === 0
              ? "the code assessment is unavailable or incomplete"
              : review.status !== "INCOMPLETE"
                ? "one or more assessment results are unavailable or unknown"
                : null
            : null,
        );
      await sleep(
        Math.min(interval, Math.max(0, deadline - performance.now())),
      );
      interval = Math.min(interval * 2, 60_000);
    }
  }
}

import { ProoflineError } from "./transport.js";

function protocol(detail: string): ProoflineError {
  return new ProoflineError(0, "urn:proofline:sdk:invalid-response", detail);
}

function integerLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${name} must be a positive integer`);
  return value;
}

const COMPLETE_CHECKS = new Set(["READY", "BLOCKED", "NOT_APPLICABLE"]);
const COMPLETE_LIFECYCLES = new Set([
  "GATING",
  "SHADOW",
  "QUARANTINED",
  "RETIRED",
]);
const KNOWN_ASSESSMENTS = new Set([
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "INCOMPLETE",
  "FAILED",
  "SUPERSEDED",
  "STOPPED",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateReview(
  value: unknown,
  reviewId: string,
): asserts value is Review {
  if (
    !isObject(value) ||
    value.id !== reviewId ||
    typeof value.status !== "string" ||
    !Number.isSafeInteger(value.assessment_count) ||
    Number(value.assessment_count) < 0 ||
    !Array.isArray(value.assessments)
  ) {
    throw protocol(
      "the review response has no valid identity or assessment envelope",
    );
  }
  const assessmentIds = new Set<string>();
  for (const assessment of value.assessments) {
    if (
      !isObject(assessment) ||
      typeof assessment.id !== "string" ||
      typeof assessment.status !== "string" ||
      !isObject(assessment.checks) ||
      typeof assessment.checks.status !== "string" ||
      typeof assessment.checks.receipt_recorded !== "boolean" ||
      !Array.isArray(assessment.checks.families)
    ) {
      throw protocol("an assessment has no typed check disclosure");
    }
    if (assessmentIds.has(assessment.id))
      throw protocol("the review contains duplicate assessment identities");
    assessmentIds.add(assessment.id);
    for (const field of ["incompleteness_kind", "release_evidence_gap"]) {
      if (
        assessment[field] !== null &&
        assessment[field] !== undefined &&
        typeof assessment[field] !== "string"
      )
        throw protocol("an assessment gap is malformed");
    }
    if (
      assessment.reason_codes !== undefined &&
      assessment.reason_codes !== null &&
      (!Array.isArray(assessment.reason_codes) ||
        !assessment.reason_codes.every(
          (reason: unknown) => typeof reason === "string",
        ))
    )
      throw protocol("an assessment reason code is malformed");
    for (const check of assessment.checks.families) {
      if (
        !isObject(check) ||
        typeof check.name !== "string" ||
        typeof check.outcome !== "string" ||
        typeof check.lifecycle !== "string"
      )
        throw protocol("a check result is malformed");
      for (const field of ["detail", "unresolved_reason"]) {
        if (
          check[field] !== null &&
          check[field] !== undefined &&
          typeof check[field] !== "string"
        )
          throw protocol("a check gap is malformed");
      }
    }
  }
}

function checkGap(assessment: Assessment): boolean {
  return (
    !assessment.checks.receipt_recorded ||
    !COMPLETE_CHECKS.has(assessment.checks.status) ||
    assessment.checks.families.some(
      (check) =>
        !COMPLETE_CHECKS.has(check.outcome) ||
        !COMPLETE_LIFECYCLES.has(check.lifecycle),
    )
  );
}

function terminal(review: Review): ReviewStatus | null {
  if (review.status === "PENDING" || review.status === "RUNNING") return null;
  if (
    review.status === "FAILED" ||
    review.status === "STOPPED" ||
    review.status === "INCOMPLETE"
  )
    return review.status;
  if (
    review.status !== "COMPLETED" ||
    review.assessment_count !== review.assessments.length
  )
    return "INCOMPLETE";
  if (review.assessments.length === 0) {
    const code = codeAssessment(review);
    return code?.status === "COMPLETED" && !code.incompleteness_kind
      ? "COMPLETED"
      : "INCOMPLETE";
  }
  return review.assessments.every(
    (assessment) =>
      assessment.status === "COMPLETED" &&
      !checkGap(assessment) &&
      !assessment.reason_codes?.length &&
      !assessment.release_evidence_gap &&
      !assessment.incompleteness_kind,
  )
    ? "COMPLETED"
    : "INCOMPLETE";
}

function codeAssessment(review: Review): CodeAssessment | null {
  // A CODE result cannot replace a missing ENV result or its check receipts.
  if (review.assessment_count !== 0 || review.assessments.length !== 0)
    return null;
  const code = review.code_assessment;
  if (
    !isObject(code) ||
    typeof code.id !== "string" ||
    !code.id ||
    typeof code.base_commit_sha !== "string" ||
    !code.base_commit_sha ||
    typeof code.head_commit_sha !== "string" ||
    !code.head_commit_sha ||
    !Array.isArray(code.findings) ||
    !["PENDING", "RUNNING", "COMPLETED", "INCOMPLETE", "EXCLUDED"].includes(
      code.status,
    ) ||
    (code.incompleteness_kind !== null &&
      code.incompleteness_kind !== undefined &&
      typeof code.incompleteness_kind !== "string")
  )
    return null;
  return code;
}

function outcome(
  status: ReviewStatus,
  reviewUrl: string,
  review: Review | null,
  reason: string | null,
): ReviewOutcome {
  const gaps = (review?.assessments ?? [])
    .filter(
      (assessment) =>
        assessment.status !== "COMPLETED" ||
        checkGap(assessment) ||
        assessment.reason_codes?.length ||
        assessment.incompleteness_kind ||
        assessment.release_evidence_gap,
    )
    .map((assessment) => ({
      assessmentId: assessment.id,
      status: assessment.status,
      incompletenessKind: assessment.incompleteness_kind ?? null,
      reasonCodes: assessment.reason_codes?.length
        ? assessment.reason_codes
        : [
            !KNOWN_ASSESSMENTS.has(assessment.status)
              ? "UNKNOWN_ASSESSMENT_STATUS"
              : "ASSESSMENT_RESULT_UNAVAILABLE",
          ],
      releaseEvidenceGap: assessment.release_evidence_gap ?? null,
      checks: assessment.checks.families
        .filter(
          (check) =>
            !COMPLETE_CHECKS.has(check.outcome) ||
            !COMPLETE_LIFECYCLES.has(check.lifecycle),
        )
        .map((check) => ({
          name: check.name,
          outcome: check.outcome,
          detail: check.detail ?? null,
          unresolvedReason: check.unresolved_reason ?? null,
        })),
    }));
  const code = review && codeAssessment(review);
  if (code && (code.status !== "COMPLETED" || code.incompleteness_kind)) {
    gaps.push({
      assessmentId: code.id,
      status: code.status,
      incompletenessKind: code.incompleteness_kind ?? null,
      reasonCodes: code.incompleteness_kind
        ? []
        : ["CODE_ASSESSMENT_STATE_UNAVAILABLE"],
      releaseEvidenceGap: null,
      checks: [],
    });
  }
  return { status, reviewUrl, review, gaps, reason };
}
