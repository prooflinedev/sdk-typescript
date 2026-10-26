import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { inspect } from "node:util";
import { ProoflineClient, ProoflineError, SecretToken } from "../dist/index.js";

const orgId = "00000000-0000-7000-8000-000000000001";
const reviewId = "00000000-0000-7000-8000-000000000002";
const assessmentId = "00000000-0000-7000-8000-000000000003";
const repoId = "00000000-0000-7000-8000-000000000004";
const findingId = "00000000-0000-7000-8000-000000000005";
const token = "plp_customer_canary_3331";
const responseCanary = "private-finding-body-canary-3331";

async function server(t, handler) {
  const calls = [];
  const http = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      userAgent: request.headers["user-agent"],
      contentType: request.headers["content-type"],
      body: Buffer.concat(chunks).toString("utf8"),
      at: performance.now(),
    });
    handler(request, response, calls);
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
  return { baseUrl: `http://127.0.0.1:${http.address().port}`, calls };
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
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

function review(status = "COMPLETED", assessments = [assessment()]) {
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
  };
}

function codeAssessment(status = "COMPLETED") {
  return {
    id: findingId,
    status,
    head_commit_sha: "a".repeat(40),
    base_commit_sha: "b".repeat(40),
    findings: [],
    incompleteness_kind: null,
  };
}

test("all twelve generated methods use the authenticated token surface and preserve server errors", async (t) => {
  const requested = {
    review_id: reviewId,
    run_number: 7,
    existing: true,
    automatic_reviews_paused: true,
  };
  const parameters = {
    path: { org_id: orgId, repo_id: repoId, number: 12 },
  };
  const fixture = await server(t, (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`)
      return json(response, 401, {
        title: "unauthorized",
        status: 401,
        detail: "the token is revoked",
      });
    if (request.url.includes("foreign-org"))
      return json(response, 404, {
        type: "https://proofline.test/problems/not-found",
        status: 200,
        detail: responseCanary,
      });
    return json(
      response,
      200,
      request.url.includes("/reviews?")
        ? {
            items: [],
            truncated: false,
            next_cursor: null,
            filters: { repositories: [], environments: [], authors: [] },
          }
        : request.url.endsWith("/routing")
          ? { status: "NOT_RECORDED" }
          : request.url.endsWith("/review")
            ? requested
            : { id: reviewId },
    );
  });
  const client = new ProoflineClient({
    baseUrl: fixture.baseUrl,
    token: new SecretToken(token),
  });
  await client.listReviews({
    path: { org_id: orgId },
    query: { limit: 2, search: "owner/repo" },
  });
  await client.listPullRequestReviews({
    path: { org_id: orgId, repository: "owner/repo", pull_request_number: 12 },
  });
  await client.getPullRequestReview({
    path: {
      org_id: orgId,
      repository: "owner/repo",
      pull_request_number: 12,
      run_number: 2,
    },
  });
  await client.getDeploymentReview({
    path: { org_id: orgId, public_key: "deploy-key" },
  });
  await client.getReview({ path: { org_id: orgId, review_id: reviewId } });
  assert.equal(
    (
      await client.getReviewRouting({
        path: { org_id: orgId, review_id: reviewId },
      })
    ).status,
    "NOT_RECORDED",
  );
  await client.getAssessment({
    path: { org_id: orgId, review_id: reviewId, assessment_id: assessmentId },
  });
  await client.getFinding({ path: { org_id: orgId, finding_id: findingId } });
  await client.getReviewGuidance({ path: { org_id: orgId, repo_id: repoId } });
  await client.listRepositories({ path: { org_id: orgId } });
  assert.deepEqual(await client.requestReview(parameters), requested);
  await client.rerunReview({ path: { org_id: orgId, review_id: reviewId } });
  assert.deepEqual(
    fixture.calls.map(({ method, url }) => [method, url]),
    [
      [
        "GET",
        `/api/v1/organizations/${orgId}/reviews?limit=2&search=owner%2Frepo`,
      ],
      ["GET", `/api/v1/organizations/${orgId}/reviews/pr/owner%2Frepo/12`],
      [
        "GET",
        `/api/v1/organizations/${orgId}/reviews/pr/owner%2Frepo/12/runs/2`,
      ],
      ["GET", `/api/v1/organizations/${orgId}/reviews/deployments/deploy-key`],
      ["GET", `/api/v1/organizations/${orgId}/reviews/${reviewId}`],
      ["GET", `/api/v1/organizations/${orgId}/reviews/${reviewId}/routing`],
      [
        "GET",
        `/api/v1/organizations/${orgId}/reviews/${reviewId}/assessments/${assessmentId}`,
      ],
      ["GET", `/api/v1/organizations/${orgId}/findings/${findingId}`],
      [
        "GET",
        `/api/v1/organizations/${orgId}/repositories/${repoId}/review-guidance`,
      ],
      ["GET", `/api/v1/organizations/${orgId}/repository-names`],
      [
        "POST",
        `/api/v1/organizations/${orgId}/repositories/${repoId}/pull-requests/12/review`,
      ],
      ["POST", `/api/v1/organizations/${orgId}/reviews/${reviewId}/rerun`],
    ],
  );
  assert(
    fixture.calls.every(
      (call) =>
        call.authorization === `Bearer ${token}` &&
        call.userAgent === "proofline-typescript/1.0.4" &&
        call.contentType === undefined &&
        call.body === "",
    ),
  );
  for (const body of [{}, { mode: "EXISTING_OR_NEW" }, { mode: "FULL" }]) {
    assert.deepEqual(await client.requestReview(parameters, body), requested);
    const call = fixture.calls.at(-1);
    assert.equal(call.method, "POST");
    assert.equal(
      call.url,
      `/api/v1/organizations/${orgId}/repositories/${repoId}/pull-requests/12/review`,
    );
    assert.equal(call.contentType, "application/json");
    assert.equal(call.body, JSON.stringify(body));
    assert.equal(call.authorization, `Bearer ${token}`);
  }
  assert.deepEqual(await client.requestReview(parameters), requested);
  assert.equal(fixture.calls.at(-1).contentType, undefined);
  assert.equal(fixture.calls.at(-1).body, "");
  await assert.rejects(
    client.getReview({ path: { org_id: "foreign-org", review_id: reviewId } }),
    (error) => {
      assert(error instanceof ProoflineError);
      assert.equal(error.status, 404);
      assert.equal(error.detail, responseCanary);
      assert.equal(error.type, "https://proofline.test/problems/not-found");
      for (const value of [
        String(error),
        inspect(error),
        JSON.stringify(error),
        inspect(client),
        inspect(new SecretToken(token)),
      ]) {
        assert(!value.includes(token) && !value.includes(responseCanary));
      }
      return true;
    },
  );
  const revoked = new ProoflineClient({
    baseUrl: fixture.baseUrl,
    token: "revoked-token",
  });
  await assert.rejects(
    revoked.getReview({ path: { org_id: orgId, review_id: reviewId } }),
    (error) => error.status === 401 && error.detail === "the token is revoked",
  );
  const refusalStart = fixture.calls.length;
  await assert.rejects(
    client.requestReview(
      { path: { org_id: "foreign-org", repo_id: repoId, number: 12 } },
      { mode: "FULL" },
    ),
    (error) => error instanceof ProoflineError && error.status === 404,
  );
  assert.equal(fixture.calls.length - refusalStart, 1);
  assert.equal(fixture.calls.at(-1).body, '{"mode":"FULL"}');
});

test("coverage uploads preserve the tested commit, report text and server refusals", async (t) => {
  const body = {
    tested_sha: "c".repeat(40),
    reports: [
      {
        name: "web/lcov.info",
        content: "SF:src/app.ts\nDA:1,1\nend_of_record\n",
      },
      {
        name: "go/coverage.out",
        content: "mode: set\nexample/main.go:1.1,1.2 1 0\n",
      },
    ],
  };
  const parameters = { path: { org_id: orgId, repo_id: repoId } };
  const recorded = {
    report_id: findingId,
    tested_sha: body.tested_sha,
    created: true,
    formats: ["LCOV", "GO_PROFILE"],
    instrumented_lines: 2,
    covered_lines: 1,
  };
  let status = 201;
  const fixture = await server(t, (_request, response) => {
    if (status < 400) {
      return json(response, status, { ...recorded, created: status === 201 });
    }
    return json(
      response,
      status,
      { title: "coverage upload refused", status, detail: responseCanary },
      { "Content-Type": "application/problem+json" },
    );
  });
  const client = new ProoflineClient({ baseUrl: fixture.baseUrl, token });
  for (const resultStatus of [201, 200]) {
    status = resultStatus;
    assert.deepEqual(await client.uploadCoverageReports(parameters, body), {
      ...recorded,
      created: status === 201,
    });
  }
  for (const refusalStatus of [422, 403, 404]) {
    status = refusalStatus;
    const before = fixture.calls.length;
    await assert.rejects(
      client.uploadCoverageReports(parameters, body),
      (error) => {
        assert(error instanceof ProoflineError);
        assert.equal(error.status, status);
        assert.equal(error.detail, responseCanary);
        return true;
      },
    );
    assert.equal(fixture.calls.length - before, 1);
  }
  for (const call of fixture.calls) {
    assert.equal(call.method, "POST");
    assert.equal(
      call.url,
      `/api/v1/organizations/${orgId}/repositories/${repoId}/coverage-reports`,
    );
    assert.equal(call.authorization, `Bearer ${token}`);
    assert.equal(call.contentType, "application/json");
    assert.deepEqual(JSON.parse(call.body), body);
  }
});

test("review reads preserve summaries, withheld prose and exact code identity", async (t) => {
  const summary = {
    head_sha: "a".repeat(40),
    base_sha: "b".repeat(40),
    files: [
      {
        path: "src/new.ts",
        previous_path: "src/old.ts",
        status: "renamed",
        additions: 3,
        deletions: 1,
        depth: "STANDARD",
      },
    ],
    route: "SHORT",
    prose_outcome: "PUBLISHED",
    prose: {
      headline: "[withheld] <script>literal text</script>",
      paragraphs: ["Moves the request handler."],
      notable_paths: ["src/new.ts"],
    },
  };
  let body;
  const fixture = await server(t, (request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    json(response, 200, body);
  });
  const client = new ProoflineClient({ baseUrl: fixture.baseUrl, token });
  for (const value of [undefined, null, summary, { ...summary, prose: null }]) {
    body = {
      ...review(),
      head_commit_sha: "a".repeat(40),
      base_commit_sha: "b".repeat(40),
    };
    if (value !== undefined) body.change_summary = value;
    for (const [method, path] of [
      ["getReview", { org_id: orgId, review_id: reviewId }],
      [
        "getPullRequestReview",
        {
          org_id: orgId,
          repository: "repo/name",
          pull_request_number: 42,
          run_number: 3,
        },
      ],
      ["getDeploymentReview", { org_id: orgId, public_key: "deployment" }],
    ]) {
      const result = await client[method]({ path });
      assert.deepEqual(result.change_summary, value);
      assert.equal(result.head_commit_sha, "a".repeat(40));
      assert.equal(result.base_commit_sha, "b".repeat(40));
      assert.equal(result.publication, "WITHHELD");
      assert.equal(
        Object.hasOwn(result, "change_summary"),
        value !== undefined,
      );
    }
  }
});

test("reads honor bounded Retry-After and mutations make one attempt", async (t) => {
  let forcedHeader;
  const fixture = await server(t, (request, response, calls) => {
    const permanent = request.url.includes("permanent");
    const unavailable = request.url.includes("unavailable");
    if (
      permanent ||
      unavailable ||
      calls.length === 1 ||
      forcedHeader !== undefined ||
      request.method === "POST"
    )
      return json(
        response,
        unavailable ? 503 : 429,
        { detail: responseCanary },
        {
          "Retry-After":
            forcedHeader ??
            (permanent || unavailable || request.method === "POST" ? "0" : "2"),
        },
      );
    return json(response, 200, { id: reviewId });
  });
  const client = new ProoflineClient({ baseUrl: fixture.baseUrl, token });
  await client.getReview({ path: { org_id: orgId, review_id: reviewId } });
  assert(fixture.calls[1].at - fixture.calls[0].at >= 1900);
  for (const [id, status] of [
    ["permanent", 429],
    ["unavailable", 503],
  ]) {
    const before = fixture.calls.length;
    await assert.rejects(
      client.getReview({ path: { org_id: orgId, review_id: id } }),
      (error) => error instanceof ProoflineError && error.status === status,
    );
    assert.equal(fixture.calls.length - before, 4);
    const mutationStart = fixture.calls.length;
    await assert.rejects(
      client.rerunReview({ path: { org_id: orgId, review_id: id } }),
      (error) => error instanceof ProoflineError && error.status === status,
    );
    assert.equal(fixture.calls.length - mutationStart, 1);
    const fullStart = fixture.calls.length;
    await assert.rejects(
      client.requestReview(
        { path: { org_id: orgId, repo_id: id, number: 12 } },
        { mode: "FULL" },
      ),
      (error) => error instanceof ProoflineError && error.status === status,
    );
    assert.equal(fixture.calls.length - fullStart, 1);
    assert.equal(fixture.calls.at(-1).body, '{"mode":"FULL"}');
  }
  for (const date of [
    "Sun, 06 Nov 1994 08:49:37 GMT",
    "Sunday, 06-Nov-94 08:49:37 GMT",
    "Sun Nov  6 08:49:37 1994",
  ]) {
    forcedHeader = date;
    const before = fixture.calls.length;
    await assert.rejects(
      client.getReview({ path: { org_id: orgId, review_id: reviewId } }),
      (error) => error instanceof ProoflineError && error.status === 429,
    );
    assert.equal(fixture.calls.length - before, 4);
  }
  const future = new Date(Date.UTC(new Date().getUTCFullYear() + 40, 10, 6));
  const futureWeekday = new Intl.DateTimeFormat("en", {
    weekday: "long",
    timeZone: "UTC",
  }).format(future);
  for (const header of [
    "-1",
    "1.5",
    "not-a-date",
    "Sun, 32 Nov 1994 08:49:37 GMT",
    "Mon, 06 Nov 1994 08:49:37 GMT",
    "61",
    `${futureWeekday}, 06-Nov-${String(future.getUTCFullYear()).slice(-2)} 00:00:00 GMT`,
  ]) {
    forcedHeader = header;
    const before = fixture.calls.length;
    await assert.rejects(
      client.getReview({ path: { org_id: orgId, review_id: reviewId } }),
      (error) => error instanceof ProoflineError && error.status === 429,
    );
    assert.equal(fixture.calls.length - before, 1);
  }
});

test("waiting retains assessment gaps, unknown states and unresolved checks without inferring from findings", async (t) => {
  let body = review("INCOMPLETE", [
    {
      ...assessment("INCOMPLETE"),
      reason_codes: ["WORLD_UNAVAILABLE"],
      incompleteness_kind: "EVIDENCE_UNAVAILABLE",
      release_evidence_gap: "pinned World evidence is unavailable",
    },
  ]);
  const fixture = await server(t, (_, response) => json(response, 200, body));
  const client = new ProoflineClient({ baseUrl: fixture.baseUrl, token });
  const incomplete = await client.waitForReview(orgId, reviewId);
  const reviewUrl = `${fixture.baseUrl}/orgs/by-id/${orgId}/reviews/${reviewId}`;
  assert.equal(incomplete.status, "INCOMPLETE");
  assert.equal(incomplete.reviewUrl, reviewUrl);
  assert.deepEqual(incomplete.gaps[0].reasonCodes, ["WORLD_UNAVAILABLE"]);
  assert.equal(
    incomplete.gaps[0].releaseEvidenceGap,
    "pinned World evidence is unavailable",
  );
  body = review("COMPLETED");
  const completed = await client.waitForReview(orgId, reviewId);
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.reviewUrl, reviewUrl);
  for (const status of ["FAILED", "STOPPED", "UNKNOWN_PROVIDER_STATE"]) {
    body = review(status);
    const result = await client.waitForReview(orgId, reviewId);
    assert.equal(
      result.status,
      status.startsWith("UNKNOWN") ? "INCOMPLETE" : status,
    );
    assert.equal(result.reviewUrl, reviewUrl);
  }
  body = review("COMPLETED", [assessment("UNKNOWN_ASSESSMENT_STATE")]);
  const unknown = await client.waitForReview(orgId, reviewId);
  assert.equal(unknown.status, "INCOMPLETE");
  assert.deepEqual(unknown.gaps[0].reasonCodes, ["UNKNOWN_ASSESSMENT_STATUS"]);
  for (const outcome of ["UNRESOLVED", "UNAVAILABLE", "FUTURE_OUTCOME"]) {
    body = review("COMPLETED", [
      {
        ...assessment(),
        checks: {
          receipt_recorded: true,
          status: outcome,
          families: [
            {
              name: "Environment reachability",
              outcome,
              lifecycle: "GATING",
              detail: "evidence gap",
              unresolved_reason: "NEEDS_EVIDENCE",
            },
          ],
        },
      },
    ]);
    const result = await client.waitForReview(orgId, reviewId);
    assert.equal(result.status, "INCOMPLETE");
    assert.equal(result.gaps[0].checks[0].outcome, outcome);
  }
  body = review("COMPLETED", [
    { ...assessment(), incompleteness_kind: "EVIDENCE_UNAVAILABLE" },
  ]);
  const kindOnly = await client.waitForReview(orgId, reviewId);
  assert.equal(kindOnly.status, "INCOMPLETE");
  assert.equal(kindOnly.gaps[0].incompletenessKind, "EVIDENCE_UNAVAILABLE");
  body = review("COMPLETED", []);
  assert.equal(
    (await client.waitForReview(orgId, reviewId)).status,
    "INCOMPLETE",
  );
  body = review("COMPLETED", [
    {
      ...assessment(),
      checks: {
        receipt_recorded: true,
        status: "READY",
        families: [
          {
            name: "Unknown evaluator",
            outcome: "READY",
            lifecycle: "FUTURE_LIFECYCLE",
          },
        ],
      },
    },
  ]);
  assert.equal(
    (await client.waitForReview(orgId, reviewId)).status,
    "INCOMPLETE",
  );
  body = review();
  delete body.assessments[0].checks;
  await assert.rejects(
    client.waitForReview(orgId, reviewId),
    (error) =>
      error instanceof ProoflineError &&
      error.type === "urn:proofline:sdk:invalid-response",
  );
  body = review("COMPLETED", [assessment(), assessment()]);
  await assert.rejects(
    client.waitForReview(orgId, reviewId),
    (error) =>
      error instanceof ProoflineError &&
      error.type === "urn:proofline:sdk:invalid-response",
  );
});

test("CODE-only outcomes retain execution gaps while ENV assessments keep precedence", async (t) => {
  let body;
  const logs = [];
  for (const method of ["log", "debug", "info", "warn", "error"]) {
    t.mock.method(console, method, (...args) => logs.push(inspect(args)));
  }
  const fixture = await server(t, (_, response) => json(response, 200, body));
  const client = new ProoflineClient({ baseUrl: fixture.baseUrl, token });
  for (const [parent, codeStatus, kind, expected] of [
    ["COMPLETED", "COMPLETED", null, "COMPLETED"],
    ["INCOMPLETE", "INCOMPLETE", "MODEL_BUDGET_EXHAUSTED", "INCOMPLETE"],
    ["COMPLETED", "INCOMPLETE", "FUTURE_CODE_REASON", "INCOMPLETE"],
    ["COMPLETED", "COMPLETED", "EVIDENCE_UNAVAILABLE", "INCOMPLETE"],
    ["FAILED", "INCOMPLETE", "HYPOTHESES_UNRESOLVED", "FAILED"],
    ["STOPPED", "RUNNING", null, "STOPPED"],
    ["COMPLETED", "PENDING", null, "INCOMPLETE"],
    ["EXCLUDED", "EXCLUDED", "POLICY_EXCLUDED", "INCOMPLETE"],
  ]) {
    body = {
      ...review(parent, []),
      code_assessment: {
        ...codeAssessment(codeStatus),
        incompleteness_kind: kind,
        findings: [{ id: findingId, claim: responseCanary }],
      },
    };
    const result = await client.waitForReview(orgId, reviewId);
    assert.equal(result.status, expected);
    assert.equal(
      result.review.code_assessment.findings[0].claim,
      responseCanary,
    );
    if (result.gaps.length) {
      assert.equal(result.gaps[0].assessmentId, findingId);
      assert.equal(result.gaps[0].status, codeStatus);
      assert.equal(result.gaps[0].incompletenessKind, kind);
      assert.deepEqual(result.gaps[0].checks, []);
      if (kind) assert.deepEqual(result.gaps[0].reasonCodes, []);
    } else {
      assert.equal(expected, "COMPLETED");
    }
  }
  for (const code of [
    undefined,
    null,
    { status: "COMPLETED" },
    codeAssessment("FUTURE_STATE"),
    { ...codeAssessment("INCOMPLETE"), incompleteness_kind: "POLICY_EXCLUDED" },
  ]) {
    body = { ...review(), code_assessment: code };
    const result = await client.waitForReview(orgId, reviewId);
    assert.equal(result.status, "COMPLETED");
    assert.deepEqual(result.gaps, []);
  }
  body = {
    ...review("COMPLETED", [
      { ...assessment("INCOMPLETE"), reason_codes: ["WORLD_UNAVAILABLE"] },
    ]),
    code_assessment: codeAssessment(),
  };
  const incomplete = await client.waitForReview(orgId, reviewId);
  assert.equal(incomplete.status, "INCOMPLETE");
  assert.deepEqual(incomplete.gaps[0].reasonCodes, ["WORLD_UNAVAILABLE"]);
  for (const assessments of [[], [assessment()]]) {
    body = {
      ...review("COMPLETED", assessments),
      assessment_count: assessments.length + 1,
      code_assessment: codeAssessment(),
    };
    assert.equal(
      (await client.waitForReview(orgId, reviewId)).status,
      "INCOMPLETE",
    );
  }
  body = {
    ...review("RUNNING", []),
    code_assessment: codeAssessment("RUNNING"),
  };
  const timedOut = await client.waitForReview(orgId, reviewId, {
    timeoutMs: 80,
  });
  assert.equal(timedOut.status, "TIMED_OUT");
  assert.equal(timedOut.review.code_assessment.status, "RUNNING");
  assert.equal(timedOut.gaps[0].assessmentId, findingId);
  assert.equal(
    timedOut.reviewUrl,
    `${fixture.baseUrl}/orgs/by-id/${orgId}/reviews/${reviewId}`,
  );
  assert.ok(!logs.join("\n").includes(token));
  assert.ok(!logs.join("\n").includes(responseCanary));
});

test("absent or unusable CODE-only results never complete", async (t) => {
  let body;
  const fixture = await server(t, (_, response) => json(response, 200, body));
  const client = new ProoflineClient({ baseUrl: fixture.baseUrl, token });
  for (const code of [
    undefined,
    null,
    [],
    {},
    { status: "COMPLETED" },
    codeAssessment("FUTURE_STATE"),
    { ...codeAssessment(), id: 42 },
    { ...codeAssessment(), findings: null },
    { ...codeAssessment(), incompleteness_kind: 42 },
  ]) {
    body = { ...review("COMPLETED", []), code_assessment: code };
    const result = await client.waitForReview(orgId, reviewId);
    assert.equal(result.status, "INCOMPLETE");
    assert.ok(result.reason);
  }
});

test("the wait timeout includes an in-flight request and returns the retained review URL", async (t) => {
  let mode = "pending";
  const fixture = await server(t, (_, response) => {
    if (mode === "pending") return json(response, 200, review("RUNNING"));
    if (mode === "disconnected") return response.destroy();
    if (mode === "partial" || mode === "forbidden") {
      response.writeHead(mode === "forbidden" ? 403 : 200, {
        "Content-Type": "application/json",
      });
      response.write('{"id":');
    }
  });
  const client = new ProoflineClient({ baseUrl: fixture.baseUrl, token });
  const reviewUrl = `${fixture.baseUrl}/orgs/by-id/${orgId}/reviews/${reviewId}`;
  const zero = await client.waitForReview(orgId, reviewId, { timeoutMs: 0 });
  assert.equal(zero.status, "TIMED_OUT");
  assert.equal(zero.review, null);
  assert.equal(zero.reviewUrl, reviewUrl);
  assert.equal(fixture.calls.length, 0);
  const result = await client.waitForReview(orgId, reviewId, { timeoutMs: 80 });
  assert.equal(result.status, "TIMED_OUT");
  assert.equal(result.review.status, "RUNNING");
  assert.equal(result.reviewUrl, reviewUrl);
  mode = "no-headers";
  const started = performance.now();
  const transportTimeout = await client.waitForReview(orgId, reviewId, {
    timeoutMs: 80,
  });
  assert.equal(transportTimeout.status, "TIMED_OUT");
  assert.equal(transportTimeout.review, null);
  assert.equal(transportTimeout.reviewUrl, reviewUrl);
  assert(performance.now() - started < 1000);
  mode = "partial";
  const partialTimeout = await client.waitForReview(orgId, reviewId, {
    timeoutMs: 80,
  });
  assert.equal(partialTimeout.status, "TIMED_OUT");
  assert.equal(partialTimeout.reviewUrl, reviewUrl);
  mode = "forbidden";
  await assert.rejects(
    client.waitForReview(orgId, reviewId, { timeoutMs: 80 }),
    (error) => error instanceof ProoflineError && error.status === 403,
  );

  // Keep the observed clock before the deadline while native abort timers expire.
  const observed = performance.now();
  const clock = t.mock.method(performance, "now", () => observed);
  try {
    for (const nextMode of ["no-headers", "partial"]) {
      mode = nextMode;
      const timedOut = await client.waitForReview(orgId, reviewId, {
        timeoutMs: 80,
      });
      assert.equal(timedOut.status, "TIMED_OUT");
      assert.equal(timedOut.review, null);
      assert.equal(timedOut.reviewUrl, reviewUrl);
    }

    const boundedClient = new ProoflineClient({
      baseUrl: fixture.baseUrl,
      token,
      requestTimeoutMs: 20,
    });
    for (const nextMode of ["no-headers", "partial"]) {
      mode = nextMode;
      await assert.rejects(
        boundedClient.waitForReview(orgId, reviewId, { timeoutMs: 80 }),
        (error) =>
          error instanceof ProoflineError &&
          error.status === 0 &&
          error.type === "urn:proofline:sdk:transport",
      );
    }

    mode = "disconnected";
    await assert.rejects(
      client.waitForReview(orgId, reviewId, { timeoutMs: 1_000 }),
      (error) =>
        error instanceof ProoflineError &&
        error.status === 0 &&
        error.type === "urn:proofline:sdk:transport",
    );
    mode = "forbidden";
    await assert.rejects(
      client.waitForReview(orgId, reviewId, { timeoutMs: 80 }),
      (error) => error instanceof ProoflineError && error.status === 403,
    );
  } finally {
    clock.mock.restore();
  }
});

test("pagination keeps filters and refuses cycles, incomplete metadata and resource bounds", async (t) => {
  let mode = "normal";
  const fixture = await server(t, (request, response) => {
    if (mode === "malformed") return json(response, 200, null);
    const cursor = new URL(request.url, "http://127.0.0.1").searchParams.get(
      "cursor",
    );
    const more = mode !== "normal" || cursor === null;
    return json(response, 200, {
      items: [{ id: cursor ? "second" : "first" }],
      truncated: more,
      next_cursor: mode === "missing" ? null : more ? "next" : null,
      filters: { repositories: [], environments: [], authors: [] },
    });
  });
  const client = new ProoflineClient({ baseUrl: fixture.baseUrl, token });
  const parameters = { path: { org_id: orgId }, query: { repository: repoId } };
  const items = await Array.fromAsync(client.iterReviews(parameters));
  assert.deepEqual(
    items.map((item) => item.id),
    ["first", "second"],
  );
  assert(
    fixture.calls.every(({ url }) => url.includes(`repository=${repoId}`)),
  );
  mode = "cycle";
  await assert.rejects(
    Array.fromAsync(client.iterReviews(parameters)),
    (error) => error.type === "urn:proofline:sdk:invalid-response",
  );
  mode = "missing";
  await assert.rejects(
    Array.fromAsync(client.iterReviews(parameters)),
    (error) => error.type === "urn:proofline:sdk:invalid-response",
  );
  mode = "normal";
  await assert.rejects(
    Array.fromAsync(client.iterReviews(parameters, { maxPages: 1 })),
    (error) => error.type === "urn:proofline:sdk:invalid-response",
  );
  await assert.rejects(
    Array.fromAsync(client.iterReviews(parameters, { maxItems: 1 })),
    (error) => error.type === "urn:proofline:sdk:invalid-response",
  );
  mode = "malformed";
  await assert.rejects(
    Array.fromAsync(client.iterReviews(parameters)),
    (error) =>
      error instanceof ProoflineError &&
      error.type === "urn:proofline:sdk:invalid-response",
  );
});

test("credentials remain on the configured origin and malformed responses carry no raw body", async (t) => {
  for (const baseUrl of [
    "http://customer.example",
    "http://127.0.0.1.customer.example",
    "https://user:password@customer.example",
    "https://customer.example/?token=secret",
    "https://customer.example/path",
  ]) {
    assert.throws(() => new ProoflineClient({ baseUrl, token }), TypeError);
  }
  const target = await server(t, (_, response) =>
    json(response, 200, { id: reviewId }),
  );
  let mode = "redirect";
  const fixture = await server(t, (_, response) => {
    if (mode === "redirect")
      return json(response, 302, {}, { Location: target.baseUrl });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(responseCanary);
  });
  const client = new ProoflineClient({ baseUrl: fixture.baseUrl, token });
  await assert.rejects(
    client.getReview({ path: { org_id: orgId, review_id: reviewId } }),
    (error) => error.status === 302,
  );
  assert.equal(target.calls.length, 0);
  mode = "malformed";
  await assert.rejects(
    client.getReview({ path: { org_id: orgId, review_id: reviewId } }),
    (error) =>
      !inspect(error).includes(responseCanary) &&
      error instanceof ProoflineError &&
      error.type === "urn:proofline:sdk:invalid-response",
  );
  await assert.rejects(
    client.getReview({ path: { org_id: "..", review_id: reviewId } }),
    TypeError,
  );
});

test("exports preserve CSV cells, opaque cursors and tenant authorization failures", async (t) => {
  const { baseUrl, calls } = await server(t, (request, response) => {
    if (request.url.includes("cursor=refused"))
      return json(response, 404, { detail: "not found" });
    const csv = request.url.includes("format=csv");
    response.writeHead(200, {
      "content-type": csv ? "text/csv" : "application/x-ndjson",
      "x-proofline-export-version": "1",
      "x-proofline-export-settled-until": "2026-10-25T00:00:00Z",
      "x-proofline-export-next-cursor": "opaque/+cursor",
    });
    response.end(
      csv
        ? 'dataset_version,claim\r\n1,"comma, quote "" and\nnewline"\r\n'
        : '{"dataset_version":1,"claim":"hello"}\n',
    );
  });
  const client = new ProoflineClient({ baseUrl, token });
  const parameters = {
    path: { org_id: orgId, dataset: "findings" },
    query: {
      from: "2026-10-01T00:00:00Z",
      to: "2026-10-25T00:00:00Z",
      format: "csv",
    },
  };
  const page = await client.exportReviews(parameters);
  assert.equal(page.rows[0].claim, 'comma, quote " and\nnewline');
  assert.equal(page.nextCursor, "opaque/+cursor");
  const next = await client.exportReviews({
    ...parameters,
    query: { ...parameters.query, format: "ndjson", cursor: page.nextCursor },
  });
  assert.equal(next.rows[0].dataset_version, 1);
  assert.match(calls[1].url, /cursor=opaque%2F%2Bcursor/);
  assert.equal(calls[0].authorization, `Bearer ${token}`);
  await assert.rejects(
    client.exportReviews({
      ...parameters,
      query: { ...parameters.query, cursor: "refused" },
    }),
    (error) => error instanceof ProoflineError && error.status === 404,
  );
});

test("knowledge negotiates MCP and preserves scoped refusals without retry", async (t) => {
  let refusal = false;
  let wrongId = false;
  const { baseUrl, calls } = await server(t, (request, response, seen) => {
    const body = JSON.parse(seen.at(-1).body);
    assert.equal(request.url, "/mcp");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (body.method === "initialize") {
      json(response, 200, {
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-11-25" },
      });
    } else if (body.method === "notifications/initialized") {
      assert.equal(request.headers["mcp-protocol-version"], "2025-11-25");
      response.writeHead(202);
      response.end();
    } else {
      assert.equal(body.params.name, "get_wiki_page");
      assert.deepEqual(body.params.arguments, {
        repository: "owner/name",
        page_key: "index",
        commit: "a".repeat(40),
      });
      if (refusal) json(response, 503, { detail: "unavailable" });
      else
        json(response, 200, {
          jsonrpc: "2.0",
          id: wrongId ? 99 : 2,
          result: {
            isError: true,
            content: [{ type: "text", text: "RESOURCE_NOT_FOUND" }],
          },
        });
    }
  });
  const client = new ProoflineClient({ baseUrl, token });
  const args = {
    repository: "owner/name",
    page_key: "index",
    commit: "a".repeat(40),
  };
  assert.equal((await client.knowledge.getWikiPage(args)).isError, true);
  wrongId = true;
  await assert.rejects(client.knowledge.getWikiPage(args), ProoflineError);
  refusal = true;
  await assert.rejects(client.knowledge.getWikiPage(args), ProoflineError);
  assert.equal(calls.length, 9);
});

test("fix helpers preserve unavailable context and never retry a verification request", async (t) => {
  const observed = [];
  let refuse = false;
  const result = {
    content: [{ type: "text", text: "untrusted source" }],
    structuredContent: { status: "UNAVAILABLE", items: null },
  };
  const { baseUrl } = await server(t, (request, response, seen) => {
    const body = JSON.parse(seen.at(-1).body);
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (body.method === "initialize")
      return json(response, 200, {
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-11-25" },
      });
    if (body.method === "notifications/initialized") {
      response.writeHead(202);
      return response.end();
    }
    observed.push(body.params);
    if (refuse)
      return json(
        response,
        503,
        { detail: "unavailable" },
        { "Retry-After": "0" },
      );
    return json(response, 200, { jsonrpc: "2.0", id: 2, result });
  });
  const client = new ProoflineClient({ baseUrl, token });
  assert.deepEqual(
    await client.fixes.listOpenFindings("owner/name", 7),
    result,
  );
  assert.deepEqual(await client.fixes.getFixContext(reviewId), result);
  const args = {
    review_id: reviewId,
    finding_ids: [reviewId],
    commit_sha: "a".repeat(40),
    note: "fixed code",
  };
  assert.deepEqual(await client.fixes.requestReverification(args), result);
  assert.deepEqual(await client.fixes.getReverification(reviewId), result);
  assert.deepEqual(observed, [
    {
      name: "list_open_findings",
      arguments: { repository: "owner/name", pull_request_number: 7 },
    },
    { name: "get_fix_context", arguments: { finding_id: reviewId } },
    { name: "request_reverification", arguments: args },
    { name: "get_reverification", arguments: { request_id: reviewId } },
  ]);
  refuse = true;
  await assert.rejects(
    client.fixes.requestReverification(args),
    ProoflineError,
  );
  assert.equal(observed.length, 5);
});
