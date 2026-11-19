import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { gateReview, ProoflineClient } from "../dist/index.js";

const orgId = "00000000-0000-7000-8000-000000000001";
const reviewId = "00000000-0000-7000-8000-000000000002";
const assessmentId = "00000000-0000-7000-8000-000000000003";
const codeId = "00000000-0000-7000-8000-000000000005";
const token = "plp_customer_canary_3331";

// Serves whatever `body` holds, so each case reads a real `ReviewOutcome`.
async function reader(t) {
  const state = { body: null };
  const http = createServer((_, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(state.body));
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        http.close(resolve);
        http.closeAllConnections();
      }),
  );
  const client = new ProoflineClient({
    baseUrl: `http://127.0.0.1:${http.address().port}`,
    token,
  });
  return async (body, options) => {
    state.body = body;
    return client.waitForReview(orgId, reviewId, options);
  };
}

function counts(openFindings = 0, seriousFindings = 0) {
  return {
    open_findings: openFindings,
    serious_findings: seriousFindings,
    accepted_risks: 0,
    not_assessed: [],
  };
}

function assessment(status = "COMPLETED") {
  return {
    id: assessmentId,
    environment_display_name: "production",
    status,
    domains: [],
    findings: [],
    release_evidence_gap: null,
    checks: { receipt_recorded: true, status: "READY", families: [] },
  };
}

function review(
  status = "COMPLETED",
  extra = {},
  assessments = [assessment()],
) {
  return {
    id: reviewId,
    public_key: "review-3331",
    kind: "PULL_REQUEST",
    status,
    assessment_count: assessments.length,
    environment_display_names: ["production"],
    finding_count: 0,
    trigger_origin: "MANUAL",
    publication: "WITHHELD",
    created_at: "2026-09-30T12:00:00Z",
    stoppable: false,
    related_reviews: [],
    subjects: [],
    assessments,
    actions: {
      promote_findings: false,
      rerun: false,
      publish: false,
      stop: false,
      validate_findings: false,
    },
    head_commit_sha: "a".repeat(40),
    base_commit_sha: "b".repeat(40),
    ...extra,
  };
}

function codeAssessment(findings, status = "COMPLETED", extra = {}) {
  return {
    id: codeId,
    status,
    head_commit_sha: "a".repeat(40),
    base_commit_sha: "b".repeat(40),
    incompleteness_kind: null,
    findings,
    ...extra,
  };
}

function codeFinding(severity, lifecycleState = "NEW") {
  return {
    id: codeId,
    claim: "claim",
    impact: "impact",
    risk_domain: "code",
    severity,
    lifecycle_state: lifecycleState,
    comment_reactions: [],
    evidence_refs: [],
    rule_refs: [],
    symbols: [],
  };
}

test("completeness decides before the open-finding counts", async (t) => {
  const read = await reader(t);
  const serious = { open_items: counts(1, 1) };
  assert.equal(
    gateReview(await read(review("COMPLETED", serious)), { failOn: "SERIOUS" }),
    "REACHED",
  );
  const incomplete = await read(
    review("COMPLETED", serious, [assessment("INCOMPLETE")]),
  );
  assert.equal(incomplete.status, "INCOMPLETE");
  assert.equal(gateReview(incomplete, { failOn: "SERIOUS" }), "NOT_COMPLETE");
  for (const status of ["INCOMPLETE", "FAILED", "STOPPED", "SUPERSEDED"]) {
    const result = await read(review(status, serious));
    assert.equal(
      gateReview(result, { failOn: "SERIOUS" }),
      "NOT_COMPLETE",
      status,
    );
  }
  // A gap decides before the missing counts do.
  const gap = await read(
    review("COMPLETED", { open_items: null }, [assessment("INCOMPLETE")]),
  );
  assert.equal(gateReview(gap, { failOn: "WARNING" }), "NOT_COMPLETE");
  // A wait that ran out has no finished review to measure.
  const timedOut = await read(review("RUNNING", serious), { timeoutMs: 50 });
  assert.equal(timedOut.status, "TIMED_OUT");
  assert.equal(gateReview(timedOut, { failOn: "WARNING" }), "UNAVAILABLE");
});

test("a completed review is measured by the server's open-finding counts", async (t) => {
  const read = await reader(t);
  for (const [openItems, failOn, expected] of [
    [counts(1, 1), "WARNING", "REACHED"],
    [counts(1, 1), "SERIOUS", "REACHED"],
    [counts(1, 0), "WARNING", "REACHED"],
    [counts(1, 0), "SERIOUS", "NOT_REACHED"],
    [counts(0, 0), "WARNING", "NOT_REACHED"],
    [counts(0, 0), "SERIOUS", "NOT_REACHED"],
    // A threshold that cannot be measured is never NOT_REACHED.
    [undefined, "WARNING", "UNAVAILABLE"],
    [null, "SERIOUS", "UNAVAILABLE"],
    [{ open_findings: 0 }, "WARNING", "UNAVAILABLE"],
    [counts("0", 0), "WARNING", "UNAVAILABLE"],
    [counts(0, -1), "SERIOUS", "UNAVAILABLE"],
    [counts(0.5, 0), "WARNING", "UNAVAILABLE"],
    [counts(false, 0), "WARNING", "UNAVAILABLE"],
    [[], "WARNING", "UNAVAILABLE"],
  ]) {
    const result = await read(review("COMPLETED", { open_items: openItems }));
    assert.equal(result.status, "COMPLETED");
    assert.equal(
      gateReview(result, { failOn }),
      expected,
      `${JSON.stringify(openItems)} ${failOn}`,
    );
  }
});

test("complete CODE findings of the review's own commits reach by lifecycle and severity", async (t) => {
  const read = await reader(t);
  for (const [severity, lifecycle, failOn, expected] of [
    ["SERIOUS", "NEW", "SERIOUS", "REACHED"],
    ["SERIOUS", "UNCHANGED", "WARNING", "REACHED"],
    ["WARNING", "NEW", "WARNING", "REACHED"],
    ["WARNING", "NEW", "SERIOUS", "NOT_REACHED"],
    ["SERIOUS", "RESOLVED", "SERIOUS", "NOT_REACHED"],
    // A severity a newer server sends is never read as below a threshold.
    ["CRITICAL", "NEW", "SERIOUS", "REACHED"],
    ["NOTE", "NEW", "SERIOUS", "REACHED"],
  ]) {
    const code = codeAssessment([codeFinding(severity, lifecycle)]);
    const case_ = `${severity} ${lifecycle} ${failOn}`;
    // Code-only review.
    const codeOnly = await read(
      review("COMPLETED", { code_assessment: code, open_items: counts() }, []),
    );
    assert.equal(codeOnly.status, "COMPLETED", case_);
    assert.equal(gateReview(codeOnly, { failOn }), expected, case_);
    // Beside complete environments, as the CLI measures it.
    const beside = await read(
      review("COMPLETED", { code_assessment: code, open_items: counts() }),
    );
    assert.equal(gateReview(beside, { failOn }), expected, case_);
  }
});

test("partial or foreign CODE records supply no findings", async (t) => {
  const read = await reader(t);
  const serious = [codeFinding("SERIOUS")];
  for (const code of [
    codeAssessment(serious, "INCOMPLETE", {
      incompleteness_kind: "MODEL_BUDGET_EXHAUSTED",
    }),
    codeAssessment(serious, "COMPLETED", {
      incompleteness_kind: "EVIDENCE_UNAVAILABLE",
    }),
    codeAssessment(serious, "RUNNING"),
    codeAssessment(serious, "COMPLETED", { head_commit_sha: "c".repeat(40) }),
    codeAssessment(serious, "COMPLETED", { base_commit_sha: "c".repeat(40) }),
  ]) {
    const result = await read(
      review("COMPLETED", { code_assessment: code, open_items: counts() }),
    );
    assert.equal(result.status, "COMPLETED");
    assert.equal(gateReview(result, { failOn: "WARNING" }), "NOT_REACHED");
  }
  // A code-only review with such a record is not complete.
  const codeOnly = await read(
    review(
      "COMPLETED",
      {
        code_assessment: codeAssessment(serious, "RUNNING"),
        open_items: counts(),
      },
      [],
    ),
  );
  assert.equal(gateReview(codeOnly, { failOn: "WARNING" }), "NOT_COMPLETE");
});

test("an invalid threshold throws instead of measuring", async (t) => {
  const read = await reader(t);
  const result = await read(review("COMPLETED", { open_items: counts() }));
  for (const options of [
    { failOn: "warning" },
    { failOn: "CRITICAL" },
    { failOn: undefined },
    {},
    undefined,
  ]) {
    assert.throws(() => gateReview(result, options), TypeError);
  }
});
