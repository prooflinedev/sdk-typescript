import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { ProoflineClient, ProoflineError, reviewSarif } from "../dist/index.js";
import metadata from "../package.json" with { type: "json" };

const ORG = "0190f3a0-0000-7000-8000-000000000001";
const REVIEW = "0190f3a0-0000-7000-8000-000000000033";
const ASSESSMENT = "0190f3a0-0000-7000-8000-000000000044";
const CODE_ASSESSMENT = "0190f3a0-0000-7000-8000-000000000055";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BASE = "89abcdef0123456789abcdef0123456789abcdef";
const OTHER_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";
const TOKEN = "plp_sarifsynthetictoken";
const PRIVATE_VALUE = "raw-world-evidence-and-operator-diagnostics";
const CLAIM = String.raw`A retry can replay {0} with {{receipt}} from [label](0), array[nested[0]] and C:\orders\receipt.`;
const ESCAPED_CLAIM = String.raw`A retry can replay {{0}} with {{{{receipt}}}} from \[label\](0), array\[nested\[0\]\] and C:\\orders\\receipt.`;
const ENVIRONMENT = String.raw`production {0} [overview](0)\primary`;
const ESCAPED_ENVIRONMENT = String.raw`production {{0}} \[overview\](0)\\primary`;
const LITERAL_REASON = String.raw`CHECK_{0}_[link](0)\broker`;
const ESCAPED_REASON = String.raw`CHECK_{{0}}_\[link\](0)\\broker`;
const FINGERPRINT =
  "5f3c9a7e1b2d4c6a8e0f9b1d3a5c7e9f2b4d6a8c0e1f3a5b7d9c2e4f6a8b0c1d";
const SCHEMA =
  "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json";

const catalog = JSON.parse(
  await readFile(
    new URL("./fixtures/risk-domains.json", import.meta.url),
    "utf8",
  ),
);

// Serves whatever `api.document` holds, as the review API would.
async function serve(t) {
  const api = { document: null, reads: 0 };
  const http = createServer((request, response) => {
    api.reads += 1;
    assert.equal(request.method, "GET");
    assert.equal(
      request.url,
      `/api/v1/organizations/${ORG}/reviews/${api.document.id}`,
    );
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(api.document));
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
  api.client = new ProoflineClient({
    baseUrl: `http://127.0.0.1:${http.address().port}`,
    token: TOKEN,
  });
  return api;
}

// Reads the document through `waitForReview`, so every export is of an
// outcome the SDK itself produced.
async function wait(api, document, options) {
  api.document = document;
  return api.client.waitForReview(ORG, document.id, options);
}

async function exported(api, document, options) {
  const log = reviewSarif(await wait(api, document, options), ORG);
  const text = JSON.stringify(log);
  assert.equal(log.$schema, SCHEMA);
  assert.equal(log.version, "2.1.0");
  assert.ok(!text.includes(TOKEN));
  assert.ok(!text.includes(PRIVATE_VALUE));
  return log.runs[0];
}

function code(path, start, end) {
  return {
    kind: "repository_file",
    label: "verified file read",
    provenance_status: "VERIFIED_REPOSITORY_READ",
    commit_sha: HEAD,
    repository_path: path,
    start_line: start,
    end_line: end,
  };
}

function findingId(number) {
  return `0190f3a0-0000-7000-8000-0000000001${String(number).padStart(2, "0")}`;
}

function finding(number, severity, refs) {
  return {
    id: findingId(number),
    severity,
    risk_domain: "data_integrity",
    claim: CLAIM,
    impact: "The customer can be charged twice.",
    lifecycle_state: "ACTIVE",
    remediation: "Make the order receipt idempotent.",
    evidence_refs: refs,
    evidence_values: PRIVATE_VALUE,
    operator_diagnostics: PRIVATE_VALUE,
  };
}

function review(findings) {
  return {
    id: REVIEW,
    kind: "PULL_REQUEST",
    status: "COMPLETED",
    head_commit_sha: HEAD,
    repository_full_name: "acme/web",
    pull_request_number: 42,
    run_number: 7,
    assessment_count: 1,
    assessments: [
      {
        id: ASSESSMENT,
        environment_display_name: ENVIRONMENT,
        status: "COMPLETED",
        findings,
        checks: { receipt_recorded: true, status: "READY", families: [] },
        reviewer_version: PRIVATE_VALUE,
        world_evidence_values: PRIVATE_VALUE,
      },
    ],
    operator_diagnostics: PRIVATE_VALUE,
  };
}

function codeReview() {
  const document = review([]);
  document.base_commit_sha = BASE;
  document.assessment_count = 0;
  document.assessments = [];
  document.code_assessment = {
    id: CODE_ASSESSMENT,
    status: "COMPLETED",
    base_commit_sha: BASE,
    head_commit_sha: HEAD,
    incompleteness_kind: null,
    findings: [
      {
        ...finding(1, "SERIOUS", [code("src/orders.rs", 10, 14)]),
        risk_domain: "logic",
      },
    ],
    compatible_addition: PRIVATE_VALUE,
  };
  return document;
}

function reasons(run) {
  return run.invocations[0].toolExecutionNotifications.map(
    (notice) => notice.properties.reasonCode,
  );
}

test("SARIF retains identity and filters locations at the recorded head", async (t) => {
  const without = (reference, field) => {
    delete reference[field];
    return reference;
  };
  const references = [
    code("src/orders #100%.rs", 10, 14),
    code("src/orders #100%.rs", 10, 14),
    code("src/\u00e9.rs", 20, null),
    {
      ...code("src/orders.rs", 1, 2),
      commit_sha: "9876543210abcdef0123456789abcdef01234567",
    },
    { ...code("src/orders.rs", 1, 2), commit_sha: "main" },
    without(code("src/orders.rs", 1, 2), "commit_sha"),
    { ...code("src/orders.rs", 1, 2), provenance_status: "UNVERIFIED" },
    without(code("src/orders.rs", 1, 2), "provenance_status"),
    {
      ...code("src/orders.rs", 1, 2),
      kind: "companion_repository_file",
      companion_repository: "acme/contracts",
    },
    { ...code("src/orders.rs", 1, 2), companion_repository: "acme/contracts" },
    ...[
      "",
      "/etc/passwd",
      "../src/orders.rs",
      "src/../orders.rs",
      "src/./orders.rs",
      "src//orders.rs",
      "src\\orders.rs",
      "C:/orders.rs",
      "https://elsewhere.example/orders.rs",
      "src/\u001b[2J.rs",
      "src/\u202eorders.rs",
    ].map((path) => code(path, 1, 2)),
    code("src/orders.rs", 0, 2),
    code("src/orders.rs", 2, 1),
    without(code("src/orders.rs", 1, 2), "start_line"),
    {
      kind: "world_entity",
      label: PRIVATE_VALUE,
      provenance_status: "PINNED_WORLD_ENTITY",
      world_entity_id: PRIVATE_VALUE,
      values: PRIVATE_VALUE,
      url: "https://elsewhere.example/private",
    },
  ];
  const document = review([
    { ...finding(1, "SERIOUS", references), finding_fingerprint: FINGERPRINT },
    finding(2, "WARNING", []),
  ]);
  const api = await serve(t);
  const outcome = await wait(api, document);
  const run = await exported(api, document);

  assert.equal(run.properties.reviewId, REVIEW);
  assert.equal(run.properties.organizationId, ORG);
  assert.equal(run.properties.reviewUrl, outcome.reviewUrl);
  assert.equal(run.properties.headCommitSha, HEAD);
  assert.equal(run.properties.repository, "acme/web");
  assert.equal(run.properties.pullRequestNumber, 42);
  assert.equal(run.properties.runNumber, 7);
  assert.equal(run.properties.outcome, "COMPLETED");
  assert.deepEqual(run.tool.driver, {
    name: "Proofline",
    version: metadata.version,
    rules: catalog.environment.map((id) => ({ id })),
  });
  assert.deepEqual(run.invocations, [
    { executionSuccessful: true, toolExecutionNotifications: [] },
  ]);
  assert.equal(run.results.length, 2);

  const [serious, warning] = run.results;
  assert.deepEqual(serious.message, {
    text: `${ESCAPED_CLAIM}\n\nThe customer can be charged twice.`,
  });
  assert.equal(serious.level, "error");
  assert.equal(serious.ruleId, "data_integrity");
  assert.equal(run.tool.driver.rules[serious.ruleIndex].id, "data_integrity");
  assert.equal(serious.properties.findingId, findingId(1));
  assert.equal(serious.properties.assessmentId, ASSESSMENT);
  assert.equal(serious.properties.lane, "ENV");
  assert.equal(serious.properties.environment, ENVIRONMENT);
  assert.equal(serious.properties.lifecycleState, "ACTIVE");
  assert.equal(serious.properties.locationStatus, "LOCATED");
  assert.equal(
    serious.properties.remediation,
    "Make the order receipt idempotent.",
  );
  // A repeated citation is one location; the first is primary.
  assert.deepEqual(serious.locations, [
    {
      physicalLocation: {
        artifactLocation: {
          uri: "src/orders%20%23100%25.rs",
          uriBaseId: "%SRCROOT%",
        },
        region: { startLine: 10, endLine: 14 },
      },
    },
  ]);
  assert.deepEqual(serious.relatedLocations, [
    {
      physicalLocation: {
        artifactLocation: { uri: "src/%C3%A9.rs", uriBaseId: "%SRCROOT%" },
        region: { startLine: 20, endLine: 20 },
      },
    },
  ]);
  const refs = serious.properties.evidenceReferences;
  assert.deepEqual(
    refs.map((reference) => reference.locationStatus),
    [
      "LOCATED",
      "LOCATED",
      "LOCATED",
      "DIFFERENT_COMMIT",
      "INVALID_COMMIT",
      "COMMIT_UNAVAILABLE",
      "UNVERIFIED_PROVENANCE",
      "UNVERIFIED_PROVENANCE",
      "COMPANION_REPOSITORY",
      "COMPANION_REPOSITORY",
      ...Array(11).fill("INVALID_PATH"),
      ...Array(3).fill("INVALID_REGION"),
      "NON_CODE_REFERENCE",
    ],
  );
  assert.deepEqual(refs[8], {
    kind: "companion_repository_file",
    provenanceStatus: "VERIFIED_REPOSITORY_READ",
    commitSha: HEAD,
    companionRepository: "acme/contracts",
    repositoryPath: "src/orders.rs",
    startLine: 1,
    endLine: 2,
    locationStatus: "COMPANION_REPOSITORY",
  });
  // A reference that is not a file keeps its kind and status, and nothing else.
  assert.deepEqual(refs[24], {
    kind: "world_entity",
    provenanceStatus: "PINNED_WORLD_ENTITY",
    commitSha: null,
    companionRepository: null,
    repositoryPath: null,
    startLine: null,
    endLine: null,
    locationStatus: "NON_CODE_REFERENCE",
  });

  assert.equal(warning.level, "warning");
  assert.deepEqual(warning.locations, []);
  assert.ok(!("relatedLocations" in warning));
  assert.equal(
    warning.properties.locationStatus,
    "NO_VERIFIED_REVIEWED_LOCATION",
  );
  // Only the retained fingerprint links a finding to a later run; the
  // occurrence ID is never emitted as a SARIF identity.
  assert.deepEqual(serious.partialFingerprints, {
    "prooflineFinding/v1": FINGERPRINT,
  });
  assert.ok(!("partialFingerprints" in warning));
  for (const result of run.results)
    for (const field of ["guid", "fingerprints", "correlationGuid"])
      assert.ok(!(field in result));

  // Exporting the same immutable review again yields the same bytes.
  assert.equal(
    JSON.stringify(reviewSarif(await wait(api, document), ORG)),
    JSON.stringify(reviewSarif(outcome, ORG)),
  );
});

test("SARIF keeps partial findings and names every gap as an unsuccessful run", async (t) => {
  const api = await serve(t);
  for (const [status, reviewReason, outcome] of [
    ["COMPLETED", "REVIEW_RESULT_INCOMPLETE", "INCOMPLETE"],
    ["PENDING", "REVIEW_IN_PROGRESS", null],
    ["RUNNING", "REVIEW_IN_PROGRESS", null],
    ["FAILED", "REVIEW_FAILED", "FAILED"],
    ["STOPPED", "REVIEW_STOPPED", "STOPPED"],
    ["SUPERSEDED", "REVIEW_STOPPED", "STOPPED"],
    ["UNRECOGNIZED", "REVIEW_RESULT_INCOMPLETE", "INCOMPLETE"],
  ]) {
    const document = review([
      finding(1, "WARNING", [code("src/orders.rs", 5, null)]),
    ]);
    document.status = status;
    Object.assign(document.assessments[0], {
      status: "INCOMPLETE",
      incompleteness_kind: "WORLD_UNAVAILABLE",
      reason_codes: ["WORLD_UNAVAILABLE", "WORLD_UNAVAILABLE", LITERAL_REASON],
      release_evidence_gap: "RELEASE_EVIDENCE_ABSENT",
    });
    document.assessments[0].checks.receipt_recorded = false;
    // A review that is still running is exported from a wait that timed out.
    const run = await exported(api, document, { timeoutMs: 100 });
    assert.equal(run.properties.reviewStatus, status);
    assert.equal(run.properties.outcome, outcome, status);
    assert.equal(run.invocations[0].executionSuccessful, false, status);
    assert.equal(run.results.length, 1);
    assert.equal(run.results[0].properties.findingId, findingId(1));
    const notifications = run.invocations[0].toolExecutionNotifications;
    // Each reason is named once, sorted, then the review's own state.
    assert.deepEqual(
      reasons(run),
      [
        "CHECK_RECEIPT_ABSENT",
        LITERAL_REASON,
        "RELEASE_EVIDENCE_ABSENT",
        "WORLD_UNAVAILABLE",
        reviewReason,
      ],
      status,
    );
    assert.deepEqual(notifications[1], {
      level: "error",
      message: { text: `${ESCAPED_ENVIRONMENT}: ${ESCAPED_REASON}` },
      properties: { assessmentId: ASSESSMENT, reasonCode: LITERAL_REASON },
    });
    assert.deepEqual(notifications[4], {
      level: "error",
      message: { text: `Review ${REVIEW}: ${reviewReason}` },
      properties: { reasonCode: reviewReason },
    });
    assert.deepEqual(run.properties.assessments, [
      {
        id: ASSESSMENT,
        environment: ENVIRONMENT,
        status: "INCOMPLETE",
        gapReasons: [
          "CHECK_RECEIPT_ABSENT",
          LITERAL_REASON,
          "RELEASE_EVIDENCE_ABSENT",
          "WORLD_UNAVAILABLE",
        ],
      },
    ]);
  }

  const missingAssessment = review([]);
  missingAssessment.assessment_count = 2;
  const noAssessments = review([]);
  noAssessments.assessment_count = 0;
  noAssessments.assessments = [];
  for (const document of [missingAssessment, noAssessments]) {
    const run = await exported(api, document);
    assert.equal(run.invocations[0].executionSuccessful, false);
    assert.equal(reasons(run)[0], "REVIEW_RESULT_INCOMPLETE");
  }
  assert.deepEqual(reasons(await exported(api, noAssessments)), [
    "REVIEW_RESULT_INCOMPLETE",
    "CODE_ASSESSMENT_UNAVAILABLE",
  ]);
});

test("CODE results keep their identity and cannot complete environment assessments", async (t) => {
  const api = await serve(t);
  const complete = codeReview();
  const edit = (change) => {
    const document = structuredClone(complete);
    change(document);
    return document;
  };
  // label, review, outcome, CODE findings exported, executionSuccessful
  const cases = [["completed", complete, "COMPLETED", 1, true]];
  for (const category of catalog.code)
    cases.push([
      category,
      edit((document) => {
        document.code_assessment.findings[0].risk_domain = category;
      }),
      "COMPLETED",
      1,
      true,
    ]);
  cases.push([
    "retained fingerprint",
    edit((document) => {
      document.code_assessment.findings[0].finding_fingerprint = FINGERPRINT;
    }),
    "COMPLETED",
    1,
    true,
  ]);
  for (const status of ["PENDING", "RUNNING", "INCOMPLETE", "EXCLUDED"])
    cases.push([
      status,
      edit((document) => {
        document.code_assessment.status = status;
      }),
      "INCOMPLETE",
      1,
      false,
    ]);
  cases.push([
    "recorded gap",
    edit((document) => {
      document.code_assessment.incompleteness_kind = "EVIDENCE_UNAVAILABLE";
    }),
    "INCOMPLETE",
    1,
    false,
  ]);
  for (const [label, field, value] of [
    ["unknown state", "status", "FUTURE_STATE"],
    ["malformed findings", "findings", {}],
    ["malformed gap", "incompleteness_kind", 42],
    ["missing identity", "id", ""],
    ["missing subject", "head_commit_sha", ""],
    ["other head", "head_commit_sha", OTHER_COMMIT],
    ["other base", "base_commit_sha", OTHER_COMMIT],
  ])
    cases.push([
      label,
      edit((document) => {
        document.code_assessment[field] = value;
      }),
      "INCOMPLETE",
      0,
      false,
    ]);
  for (const [label, value] of [
    ["null code", null],
    ["malformed code", []],
  ])
    cases.push([
      label,
      edit((document) => {
        document.code_assessment = value;
      }),
      "INCOMPLETE",
      0,
      false,
    ]);
  cases.push([
    "missing code",
    edit((document) => {
      delete document.code_assessment;
    }),
    "INCOMPLETE",
    0,
    false,
  ]);
  cases.push([
    "review pending",
    edit((document) => {
      document.status = "PENDING";
    }),
    null,
    1,
    false,
  ]);
  cases.push([
    "missing environment",
    edit((document) => {
      document.assessment_count = 1;
    }),
    "INCOMPLETE",
    1,
    false,
  ]);
  const beside = (findings, change) => {
    const document = review(findings);
    document.code_assessment = structuredClone(complete.code_assessment);
    change(document);
    return document;
  };
  cases.push([
    "environment gap",
    beside([finding(2, "WARNING", [])], (document) => {
      document.assessments[0].checks.receipt_recorded = false;
    }),
    "INCOMPLETE",
    1,
    false,
  ]);
  // Complete environments complete the review, and the partial CODE record
  // beside them still makes the run unsuccessful.
  cases.push([
    "environment precedence",
    beside([], (document) => {
      document.code_assessment.status = "INCOMPLETE";
    }),
    "COMPLETED",
    1,
    false,
  ]);
  // A review's base is null until pinned, and its CODE record still counts.
  cases.push([
    "unpinned review base",
    edit((document) => {
      document.base_commit_sha = null;
    }),
    "COMPLETED",
    1,
    true,
  ]);
  cases.push([
    "other subject beside an environment",
    beside([], (document) => {
      document.code_assessment.head_commit_sha = OTHER_COMMIT;
    }),
    "COMPLETED",
    0,
    false,
  ]);
  // The API publishes this marker in place of a CODE finding's text once the
  // review's protected evidence is missing or has expired.
  const withhold = (document) => {
    const recorded = document.code_assessment.findings[0];
    for (const field of ["risk_domain", "claim", "impact", "remediation"])
      recorded[field] = "[withheld: environment value]";
    recorded.evidence_refs = [];
  };
  cases.push(["withheld code", edit(withhold), "INCOMPLETE", 0, false]);
  cases.push([
    "withheld code beside an environment",
    beside(
      [
        {
          ...finding(2, "WARNING", [code("src/orders.rs", 10, 14)]),
          claim: "The environment drops the order.",
        },
      ],
      withhold,
    ),
    "COMPLETED",
    0,
    false,
  ]);

  for (const [label, document, outcome, count, successful] of cases) {
    const run = await exported(api, document, { timeoutMs: 100 });
    assert.equal(run.properties.outcome, outcome, label);
    assert.equal(run.invocations[0].executionSuccessful, successful, label);
    const found = run.results.filter(
      (result) => result.properties.lane === "CODE",
    );
    assert.equal(found.length, count, label);
    // Every review without a usable CODE record says so, and that record
    // supplies no metadata and no rule.
    assert.equal(
      reasons(run).includes("CODE_ASSESSMENT_UNAVAILABLE"),
      count === 0,
      label,
    );
    assert.equal("codeAssessment" in run.properties, count > 0, label);
    assert.deepEqual(
      run.tool.driver.rules.map((rule) => rule.id),
      [...catalog.environment, ...(count > 0 ? catalog.code : [])],
      label,
    );
    if (outcome === "INCOMPLETE") assert.notEqual(reasons(run).length, 0);
    if (label === "withheld code beside an environment") {
      assert.equal(run.results.length, 1);
      assert.equal(run.results[0].properties.lane, "ENV");
    }
    if (label === "recorded gap") {
      assert.deepEqual(run.properties.codeAssessment.gapReasons, [
        "EVIDENCE_UNAVAILABLE",
      ]);
      assert.deepEqual(run.invocations[0].toolExecutionNotifications[0], {
        level: "error",
        message: { text: "Code-only: EVIDENCE_UNAVAILABLE" },
        properties: {
          assessmentId: CODE_ASSESSMENT,
          reasonCode: "EVIDENCE_UNAVAILABLE",
        },
      });
    }
    if (count === 0) continue;
    const [result] = found;
    const recorded = document.code_assessment.findings[0];
    assert.equal(result.properties.assessmentId, CODE_ASSESSMENT, label);
    assert.ok(!("environment" in result.properties), label);
    assert.equal(result.properties.findingId, recorded.id, label);
    assert.equal(result.ruleId, recorded.risk_domain, label);
    assert.equal(
      run.tool.driver.rules[result.ruleIndex].id,
      recorded.risk_domain,
      label,
    );
    assert.equal(
      result.message.text,
      `Code-only finding\n\n${ESCAPED_CLAIM}\n\nThe customer can be charged twice.`,
      label,
    );
    assert.deepEqual(
      result.locations[0].physicalLocation,
      {
        artifactLocation: { uri: "src/orders.rs", uriBaseId: "%SRCROOT%" },
        region: { startLine: 10, endLine: 14 },
      },
      label,
    );
    assert.deepEqual(
      result.partialFingerprints,
      recorded.finding_fingerprint && {
        "prooflineFinding/v1": recorded.finding_fingerprint,
      },
      label,
    );
    assert.deepEqual(
      run.properties.codeAssessment,
      {
        id: CODE_ASSESSMENT,
        status: document.code_assessment.status,
        baseCommitSha: BASE,
        headCommitSha: HEAD,
        gapReasons: reasons(run).filter(
          (_, index) =>
            run.invocations[0].toolExecutionNotifications[index].properties
              .assessmentId === CODE_ASSESSMENT,
        ),
      },
      label,
    );
  }
});

test("SARIF refuses unpinned or unrecognized records and returns no document", async (t) => {
  const api = await serve(t);
  const records = [];
  for (const head of [null, "main", ` ${HEAD}`])
    records.push([
      { ...review([]), head_commit_sha: head },
      "does not record a full commit SHA",
    ]);
  records.push([
    { ...review([]), kind: "DEPLOYMENT_GATE" },
    "requires a retained pull-request review",
  ]);
  for (const [field, value, expected] of [
    ["severity", "CRITICAL", "unsupported severity CRITICAL"],
    [
      "risk_domain",
      "unrecognized_domain",
      "unsupported risk domain unrecognized_domain",
    ],
    // A CODE category is not an environment risk domain.
    ["risk_domain", "logic", "unsupported risk domain logic"],
  ]) {
    const document = review([
      finding(1, "WARNING", []),
      finding(2, "WARNING", []),
    ]);
    document.assessments[0].findings[1][field] = value;
    records.push([document, `finding ${findingId(2)} has ${expected}`]);
  }
  // Only the exact withheld marker makes a CODE record unavailable.
  const codeDomain = codeReview();
  codeDomain.code_assessment.findings[0].risk_domain = "data_integrity";
  records.push([codeDomain, "unsupported risk domain data_integrity"]);
  for (const [document, expected] of records) {
    const outcome = await wait(api, document);
    assert.throws(
      () => reviewSarif(outcome, ORG),
      (error) => {
        assert.ok(error instanceof ProoflineError);
        assert.equal(error.status, 0);
        assert.equal(error.type, "urn:proofline:sdk:sarif-refused");
        assert.ok(error.detail.includes(expected), error.detail);
        assert.ok(!error.detail.includes(PRIVATE_VALUE));
        return true;
      },
    );
  }

  // Server text in a refusal cannot carry terminal control characters.
  const hostile = review([finding(1, "\u001b[2JCRITICAL\n", [])]);
  assert.throws(
    () => reviewSarif(outcomeOf(hostile), ORG),
    (error) =>
      error.detail.includes("unsupported severity \ufffd[2JCRITICAL ;"),
  );

  const malformed = review([{ ...finding(1, "WARNING", []), claim: 7 }]);
  assert.throws(
    () => reviewSarif(outcomeOf(malformed), ORG),
    (error) => error.type === "urn:proofline:sdk:invalid-response",
  );

  // A wait that ended before any read has nothing to export.
  const unread = await wait(api, review([]), { timeoutMs: 0 });
  assert.equal(unread.review, null);
  assert.throws(() => reviewSarif(unread, ORG), TypeError);
  const read = await wait(api, review([]));
  for (const organization of ["", undefined, 7])
    assert.throws(() => reviewSarif(read, organization), TypeError);
});

function outcomeOf(document) {
  return {
    status: "COMPLETED",
    reviewUrl: `https://proofline.example/orgs/by-id/${ORG}/reviews/${REVIEW}`,
    review: document,
    gaps: [],
    reason: null,
  };
}

test("no shared outcome fixture exports an incomplete review as a successful run", async (t) => {
  const contract = JSON.parse(
    await readFile(
      new URL("./fixtures/review-outcomes.json", import.meta.url),
      "utf8",
    ),
  );
  const api = await serve(t);
  let exportedCount = 0;
  for (const item of contract.cases) {
    const outcome = await wait(api, item.review, { timeoutMs: 100 });
    if (item.review.head_commit_sha == null) {
      assert.throws(
        () => reviewSarif(outcome, ORG),
        (error) => error.type === "urn:proofline:sdk:sarif-refused",
        item.name,
      );
      continue;
    }
    const run = reviewSarif(outcome, ORG).runs[0];
    exportedCount += 1;
    assert.equal(run.properties.outcome, item.outcome, item.name);
    const { executionSuccessful } = run.invocations[0];
    if (executionSuccessful) {
      assert.equal(item.outcome, "COMPLETED", item.name);
      assert.deepEqual(reasons(run), [], item.name);
    }
    if (item.outcome !== "COMPLETED")
      assert.equal(executionSuccessful, false, item.name);
    // Every gap the wait names for an assessment reaches the document.
    for (const gap of item.gaps)
      if (gap.assessment_id !== null)
        for (const reason of gap.reason_codes)
          assert.ok(
            run.invocations[0].toolExecutionNotifications.some(
              (notice) =>
                notice.properties.assessmentId === gap.assessment_id &&
                notice.properties.reasonCode === reason,
            ),
            `${item.name}: ${reason}`,
          );
  }
  assert.ok(exportedCount > 30);
});
