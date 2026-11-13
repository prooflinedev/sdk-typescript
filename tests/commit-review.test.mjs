import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { ProoflineClient, ProoflineError } from "../dist/index.js";

const orgId = "00000000-0000-7000-8000-000000000001";
const reviewId = "00000000-0000-7000-8000-000000000002";
const assessmentId = "00000000-0000-7000-8000-000000000003";
const repoId = "00000000-0000-7000-8000-000000000004";
const token = "plp_customer_canary_3331";
const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const listPath = `/api/v1/organizations/${orgId}/reviews`;

async function server(t, handler) {
  const calls = [];
  const http = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    calls.push({ method: request.method, path: url.pathname, url });
    handler(url, response, calls);
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
  const baseUrl = `http://127.0.0.1:${http.address().port}`;
  return {
    baseUrl,
    calls,
    client: new ProoflineClient({ baseUrl, token }),
    reviewUrl: `${baseUrl}/orgs/by-id/${orgId}/reviews/${reviewId}`,
  };
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function summary(overrides = {}) {
  return {
    id: reviewId,
    public_key: "review-3331",
    kind: "PULL_REQUEST",
    status: "RUNNING",
    assessment_count: 1,
    environment_display_names: ["production"],
    finding_count: 0,
    trigger_origin: "AUTOMATIC",
    publication: "PUBLISHED",
    created_at: "2026-09-30T12:00:00Z",
    head_commit_sha: sha,
    repository_full_name: "acme/web",
    ...overrides,
  };
}

function page(items) {
  return {
    items,
    truncated: false,
    next_cursor: null,
    filters: { repositories: [], environments: [], authors: [] },
  };
}

function detail(status = "COMPLETED", head = sha) {
  return {
    ...summary({ status, head_commit_sha: head }),
    stoppable: false,
    related_reviews: [],
    subjects: [],
    assessments: [
      {
        id: assessmentId,
        environment_display_name: "production",
        status: status === "COMPLETED" ? "COMPLETED" : "RUNNING",
        domains: [],
        findings: [],
        release_evidence_gap: null,
        checks: { receipt_recorded: true, status: "READY", families: [] },
      },
    ],
    actions: {
      promote_findings: false,
      rerun: false,
      publish: false,
      stop: false,
      validate_findings: false,
    },
  };
}

test("a commit that is not a full SHA is refused before any request", async (t) => {
  const fixture = await server(t, (_, response) =>
    json(response, 200, page([])),
  );
  for (const value of [
    "main",
    "a".repeat(7),
    "a".repeat(41),
    `${"a".repeat(39)}g`,
    "",
    undefined,
  ]) {
    await assert.rejects(
      fixture.client.findCommitReview(orgId, value),
      TypeError,
    );
    await assert.rejects(
      fixture.client.waitForCommitReview(orgId, value),
      TypeError,
    );
  }
  for (const options of [
    { timeoutMs: -1 },
    { timeoutMs: Number.NaN },
    { discoveryTimeoutMs: -1 },
    { discoveryTimeoutMs: Number.POSITIVE_INFINITY },
  ]) {
    await assert.rejects(
      fixture.client.waitForCommitReview(orgId, sha, options),
      TypeError,
    );
  }
  assert.equal(fixture.calls.length, 0);
});

test("finding a commit review searches the exact SHA and keeps exact head matches only", async (t) => {
  let items = [];
  const fixture = await server(t, (_, response) =>
    json(response, 200, page(items)),
  );
  assert.equal(await fixture.client.findCommitReview(orgId, sha), null);
  assert.equal(fixture.calls[0].path, listPath);
  assert.equal(fixture.calls[0].url.searchParams.get("search"), sha);
  assert.equal(fixture.calls[0].url.searchParams.has("repository"), false);

  // A text search can return reviews that only mention the SHA.
  items = [
    summary({ id: "mention", head_commit_sha: otherSha }),
    summary({ id: "patch", head_commit_sha: null }),
  ];
  assert.equal(await fixture.client.findCommitReview(orgId, sha), null);

  // Uppercase input is normalized, and the newest exact match is returned.
  items = [
    summary({ id: "mention", head_commit_sha: otherSha }),
    summary({ id: "newest", head_commit_sha: sha.toUpperCase() }),
    summary({ id: "older" }),
  ];
  const found = await fixture.client.findCommitReview(
    orgId,
    sha.toUpperCase(),
    {
      repositoryId: repoId,
    },
  );
  assert.equal(found.id, "newest");
  const last = fixture.calls.at(-1).url.searchParams;
  assert.equal(last.get("search"), sha);
  assert.equal(last.get("repository"), repoId);
});

test("a commit reviewed in several repositories is refused until one is named", async (t) => {
  const fixture = await server(t, (url, response) => {
    const items = [
      summary({ id: "web", repository_full_name: "acme/web" }),
      summary({ id: "fork", repository_full_name: "acme/web-fork" }),
    ];
    json(
      response,
      200,
      page(url.searchParams.has("repository") ? items.slice(0, 1) : items),
    );
  });
  const ambiguous = (error) =>
    error instanceof ProoflineError &&
    error.status === 0 &&
    error.type === "urn:proofline:sdk:ambiguous-commit";
  await assert.rejects(fixture.client.findCommitReview(orgId, sha), ambiguous);
  await assert.rejects(
    fixture.client.waitForCommitReview(orgId, sha, { timeoutMs: 500 }),
    ambiguous,
  );
  const named = await fixture.client.findCommitReview(orgId, sha, {
    repositoryId: repoId,
  });
  assert.equal(named.id, "web");
});

test("malformed review pages and server refusals are not read as an absent review", async (t) => {
  let mode = "null";
  const fixture = await server(t, (_, response) => {
    if (mode === "forbidden")
      return json(response, 403, { title: "forbidden", status: 403 });
    if (mode === "null") return json(response, 200, null);
    if (mode === "no-items") return json(response, 200, { truncated: false });
    return json(response, 200, page([{ head_commit_sha: sha }]));
  });
  for (const next of ["null", "no-items", "no-identity"]) {
    mode = next;
    for (const call of [
      () => fixture.client.findCommitReview(orgId, sha),
      () => fixture.client.waitForCommitReview(orgId, sha, { timeoutMs: 500 }),
    ]) {
      await assert.rejects(
        call(),
        (error) =>
          error instanceof ProoflineError &&
          error.type === "urn:proofline:sdk:invalid-response",
      );
    }
  }
  mode = "forbidden";
  await assert.rejects(
    fixture.client.waitForCommitReview(orgId, sha, { timeoutMs: 500 }),
    (error) => error instanceof ProoflineError && error.status === 403,
  );
});

test("waiting follows a commit from no review to its finished review", async (t) => {
  const fixture = await server(t, (url, response, calls) => {
    if (url.pathname !== listPath) return json(response, 200, detail());
    // The review does not exist on the first poll.
    const polls = calls.filter((call) => call.path === listPath).length;
    json(response, 200, page(polls < 2 ? [] : [summary()]));
  });
  const result = await fixture.client.waitForCommitReview(
    orgId,
    sha.toUpperCase(),
    { repositoryId: repoId },
  );
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.commitSha, sha);
  assert.equal(result.reviewId, reviewId);
  assert.equal(result.reviewUrl, fixture.reviewUrl);
  assert.equal(result.review.head_commit_sha, sha);
  assert.deepEqual(result.gaps, []);
  assert.equal(result.reason, null);
  assert.deepEqual(
    fixture.calls.map((call) => call.path),
    [listPath, listPath, `${listPath}/${reviewId}`],
  );
  assert(
    fixture.calls
      .slice(0, 2)
      .every(
        (call) =>
          call.url.searchParams.get("search") === sha &&
          call.url.searchParams.get("repository") === repoId,
      ),
  );
});

test("a commit with no review times out without a review identity", async (t) => {
  let mode = "empty";
  const fixture = await server(t, (_, response) => {
    if (mode === "empty") json(response, 200, page([]));
    // "silent" never answers, so the deadline expires in flight.
  });
  const zero = await fixture.client.waitForCommitReview(orgId, sha, {
    timeoutMs: 0,
  });
  assert.equal(zero.status, "TIMED_OUT");
  assert.equal(fixture.calls.length, 0);

  const started = performance.now();
  const discovery = await fixture.client.waitForCommitReview(orgId, sha, {
    discoveryTimeoutMs: 60,
  });
  assert(performance.now() - started < 1_000);
  assert.deepEqual(discovery, {
    status: "TIMED_OUT",
    commitSha: sha,
    reviewId: null,
    reviewUrl: null,
    review: null,
    gaps: [],
    reason: "no review of the commit appeared before discoveryTimeoutMs",
  });

  const whole = await fixture.client.waitForCommitReview(orgId, sha, {
    timeoutMs: 60,
  });
  assert.equal(whole.reviewId, null);
  assert.equal(
    whole.reason,
    "no review of the commit appeared before timeoutMs",
  );

  mode = "silent";
  const inFlight = await fixture.client.waitForCommitReview(orgId, sha, {
    timeoutMs: 80,
  });
  assert.equal(inFlight.status, "TIMED_OUT");
  assert.equal(inFlight.reviewId, null);
});

test("a review still running at the deadline keeps its identity and address", async (t) => {
  const fixture = await server(t, (url, response) =>
    json(
      response,
      200,
      url.pathname === listPath ? page([summary()]) : detail("RUNNING"),
    ),
  );
  const result = await fixture.client.waitForCommitReview(orgId, sha, {
    timeoutMs: 150,
    // Discovery ended, so its shorter bound no longer applies.
    discoveryTimeoutMs: 100,
  });
  assert.equal(result.status, "TIMED_OUT");
  assert.equal(result.reviewId, reviewId);
  assert.equal(result.reviewUrl, fixture.reviewUrl);
  assert.equal(result.review.status, "RUNNING");
  assert.equal(result.reason, "the review did not finish before timeoutMs");
});

test("a review pinned to another commit is refused", async (t) => {
  let head = otherSha;
  const fixture = await server(t, (url, response) =>
    json(
      response,
      200,
      url.pathname === listPath ? page([summary()]) : detail("COMPLETED", head),
    ),
  );
  for (const next of [otherSha, null]) {
    head = next;
    await assert.rejects(
      fixture.client.waitForCommitReview(orgId, sha, { timeoutMs: 500 }),
      (error) =>
        error instanceof ProoflineError &&
        error.type === "urn:proofline:sdk:invalid-response",
    );
  }
});
