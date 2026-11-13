import { FixesClient } from "./fixes.js";

export type { ReverificationRequest } from "./fixes.js";

import { McpClient } from "./mcp.js";

export type { McpTarget } from "./mcp.js";

import { KnowledgeClient } from "./knowledge.js";

export type { KnowledgeResult, RepositoryKnowledge } from "./knowledge.js";

import {
  decodeExport,
  type ExportPage,
  type ExportParameters,
} from "./exports.js";

export type { ExportPage, ExportParameters } from "./exports.js";

import { type ListReviewsParameters, Operations } from "./operations.js";
import type { components } from "./schema.js";
import { type ClientOptions, sleep, Transport } from "./transport.js";

export type * from "./operations.js";
export type { components, operations, paths } from "./schema.js";
export type {
  ClientOptions,
  ProblemFields,
  RunNowRefusal,
} from "./transport.js";
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
  /** Empty when no assessment identity is available for this gap. */
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

export interface CommitReviewOptions {
  /** Proofline ID of the repository that has the commit. Required when several repositories have it. */
  repositoryId?: string;
}

export interface CommitWaitOptions extends WaitOptions, CommitReviewOptions {
  /** How long to look for a review of the commit before giving up. Defaults to two minutes. */
  discoveryTimeoutMs?: number;
}

/** A review outcome addressed by the commit the review is pinned to. */
export interface CommitReviewOutcome extends Omit<ReviewOutcome, "reviewUrl"> {
  /** The full lowercase commit SHA the caller named. */
  commitSha: string;
  /** Null when no review of the commit appeared; that is not a review result. */
  reviewId: string | null;
  reviewUrl: string | null;
}

export class ProoflineClient extends Operations {
  readonly #transport: Transport;
  readonly mcp: McpClient;
  readonly knowledge: KnowledgeClient;
  readonly fixes: FixesClient;

  constructor(options: ClientOptions) {
    const transport = new Transport(options);
    super((method, path, parameters, body) =>
      transport.request(method, path, parameters, undefined, body),
    );
    this.#transport = transport;
    this.mcp = new McpClient(transport);
    this.knowledge = new KnowledgeClient(transport);
    this.fixes = new FixesClient(transport);
  }

  async exportReviews(parameters: ExportParameters): Promise<ExportPage> {
    const format = parameters.query.format ?? "ndjson";
    if (format !== "csv" && format !== "ndjson")
      throw new TypeError("export format must be csv or ndjson");
    return this.#transport.request(
      "GET",
      "/api/v1/organizations/{org_id}/exports/{dataset}",
      parameters,
      undefined,
      undefined,
      (text, headers) => decodeExport(text, headers, format),
      format === "csv" ? "text/csv" : "application/x-ndjson",
    );
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

  /**
   * Returns the latest review pinned to an exact head commit, or null when
   * none exists yet. A missing review says nothing about the commit.
   */
  async findCommitReview(
    orgId: string,
    commitSha: string,
    options: CommitReviewOptions = {},
  ): Promise<components["schemas"]["ReviewSummary"] | null> {
    return this.#commitReview(orgId, fullSha(commitSha), options.repositoryId);
  }

  /**
   * Waits for the review of an exact head commit: first for the review to
   * appear, then for it to finish. One `timeoutMs` bounds both phases.
   */
  async waitForCommitReview(
    orgId: string,
    commitSha: string,
    options: CommitWaitOptions = {},
  ): Promise<CommitReviewOutcome> {
    const sha = fullSha(commitSha);
    const timeout = options.timeoutMs ?? 20 * 60_000;
    const discovery = options.discoveryTimeoutMs ?? 2 * 60_000;
    if (!Number.isFinite(timeout) || timeout < 0)
      throw new TypeError("timeoutMs must be finite and nonnegative");
    if (!Number.isFinite(discovery) || discovery < 0)
      throw new TypeError("discoveryTimeoutMs must be finite and nonnegative");
    const started = performance.now();
    const deadline = started + timeout;
    const discoveryDeadline = Math.min(deadline, started + discovery);
    const absent = (): CommitReviewOutcome => ({
      status: "TIMED_OUT",
      commitSha: sha,
      reviewId: null,
      reviewUrl: null,
      review: null,
      gaps: [],
      reason:
        discoveryDeadline < deadline
          ? "no review of the commit appeared before discoveryTimeoutMs"
          : "no review of the commit appeared before timeoutMs",
    });
    let interval = 2_000;
    let found: components["schemas"]["ReviewSummary"] | null = null;
    for (;;) {
      if (performance.now() >= discoveryDeadline) return absent();
      try {
        found = await this.#commitReview(
          orgId,
          sha,
          options.repositoryId,
          discoveryDeadline,
        );
      } catch (error) {
        if (expired(error, discoveryDeadline)) return absent();
        throw error;
      }
      if (found !== null) break;
      await sleep(
        Math.min(interval, Math.max(0, discoveryDeadline - performance.now())),
      );
      interval = Math.min(interval * 2, 30_000);
    }
    const result = await this.waitForReview(orgId, found.id, {
      timeoutMs: Math.max(0, deadline - performance.now()),
    });
    if (
      result.review !== null &&
      result.review.head_commit_sha?.toLowerCase() !== sha
    )
      throw protocol("the review is not pinned to the requested commit");
    return { ...result, commitSha: sha, reviewId: found.id };
  }

  async #commitReview(
    orgId: string,
    sha: string,
    repositoryId: string | undefined,
    deadline?: number,
  ): Promise<components["schemas"]["ReviewSummary"] | null> {
    const page = await this.#transport.request<unknown>(
      "GET",
      "/api/v1/organizations/{org_id}/reviews",
      {
        path: { org_id: orgId },
        // A search equal to a full head SHA lists the latest run at that commit.
        query: { search: sha, repository: repositoryId },
      },
      deadline,
    );
    if (!isObject(page) || !Array.isArray(page.items))
      throw protocol("the review page has no typed collection metadata");
    // The server may fall back to a text search; keep exact head matches only.
    const matches: components["schemas"]["ReviewSummary"][] = [];
    for (const item of page.items) {
      if (!isObject(item) || typeof item.id !== "string" || !item.id)
        throw protocol("a review summary has no identity");
      if (
        typeof item.head_commit_sha === "string" &&
        item.head_commit_sha.toLowerCase() === sha
      )
        matches.push(item as components["schemas"]["ReviewSummary"]);
    }
    if (
      new Set(matches.map((match) => match.repository_full_name ?? "")).size > 1
    )
      throw new ProoflineError(
        0,
        "urn:proofline:sdk:ambiguous-commit",
        "more than one repository has a review of this commit; name repositoryId",
      );
    // Reviews arrive newest first.
    return matches[0] ?? null;
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

function fullSha(value: string): string {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{40}$/.test(value))
    throw new TypeError("commitSha must be a full 40-character commit SHA");
  return value.toLowerCase();
}

function expired(error: unknown, deadline: number): boolean {
  return (
    error instanceof ProoflineError &&
    (error.type === "urn:proofline:sdk:timeout" ||
      (error.status === 0 &&
        error.type === "urn:proofline:sdk:transport" &&
        performance.now() >= deadline))
  );
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
  "EXCLUDED",
]);
const WITHHELD_MARKER = "[withheld: environment value]";

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
  if (review.status === "SUPERSEDED") return "STOPPED";
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
  if (
    (typeof review.head_commit_sha === "string" &&
      review.head_commit_sha.toLowerCase() !==
        code.head_commit_sha.toLowerCase()) ||
    (typeof review.base_commit_sha === "string" &&
      review.base_commit_sha.toLowerCase() !==
        code.base_commit_sha.toLowerCase()) ||
    code.findings.some((finding) => finding.risk_domain === WITHHELD_MARKER)
  )
    return null;
  return code;
}

function assessmentReasons(assessment: Assessment): string[] {
  const reasons = [...(assessment.reason_codes ?? [])];
  if (assessment.incompleteness_kind)
    reasons.push(assessment.incompleteness_kind);
  if (assessment.release_evidence_gap)
    reasons.push(assessment.release_evidence_gap);
  if (checkGap(assessment))
    reasons.push(
      assessment.checks.receipt_recorded
        ? "CHECKS_UNRESOLVED"
        : "CHECK_RECEIPT_ABSENT",
    );
  if (!reasons.length)
    reasons.push(
      KNOWN_ASSESSMENTS.has(assessment.status)
        ? "ASSESSMENT_RESULT_UNAVAILABLE"
        : "UNKNOWN_ASSESSMENT_STATUS",
    );
  return reasons;
}

function outcome(
  status: ReviewStatus,
  reviewUrl: string,
  review: Review | null,
  reason: string | null,
): ReviewOutcome {
  const gaps: AssessmentGaps[] = (review?.assessments ?? [])
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
      reasonCodes: assessmentReasons(assessment),
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
        ? [code.incompleteness_kind]
        : ["CODE_ASSESSMENT_STATE_UNAVAILABLE"],
      releaseEvidenceGap: null,
      checks: [],
    });
  }
  if (
    review &&
    review.assessment_count === 0 &&
    !review.assessments.length &&
    !code
  ) {
    gaps.push({
      assessmentId: "",
      status: "UNKNOWN",
      incompletenessKind: null,
      reasonCodes: ["CODE_ASSESSMENT_UNAVAILABLE"],
      releaseEvidenceGap: null,
      checks: [],
    });
  }
  if (review && review.assessment_count !== review.assessments.length) {
    gaps.push({
      assessmentId: "",
      status: "UNKNOWN",
      incompletenessKind: null,
      reasonCodes: ["ASSESSMENT_HISTORY_UNAVAILABLE"],
      releaseEvidenceGap: null,
      checks: [],
    });
  }
  if (
    review &&
    !gaps.length &&
    ![
      "PENDING",
      "RUNNING",
      "COMPLETED",
      "FAILED",
      "STOPPED",
      "SUPERSEDED",
    ].includes(review.status)
  ) {
    gaps.push({
      assessmentId: "",
      status: review.status,
      incompletenessKind: null,
      reasonCodes: ["REVIEW_STATE_UNAVAILABLE"],
      releaseEvidenceGap: null,
      checks: [],
    });
  }
  return { status, reviewUrl, review, gaps, reason };
}
