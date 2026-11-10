import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { inspect } from "node:util";
import { ProoflineClient, ProoflineError } from "../dist/index.js";

const orgId = "00000000-0000-7000-8000-000000000001";
const reviewId = "00000000-0000-7000-8000-000000000002";
const token = "plp_customer_canary_7717";
const review = { path: { org_id: orgId, review_id: reviewId } };

async function server(t, handler) {
  const calls = [];
  const http = createServer((request, response) => {
    calls.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
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

function running() {
  return {
    id: reviewId,
    public_key: "review-7717",
    kind: "PULL_REQUEST",
    status: "RUNNING",
    assessment_count: 0,
    environment_display_names: [],
    finding_count: 0,
    trigger_origin: "MANUAL",
    publication: "WITHHELD",
    created_at: "2026-11-06T12:00:00Z",
    stoppable: false,
    related_reviews: [],
    subjects: [],
    assessments: [],
    actions: {
      promote_findings: false,
      rerun: false,
      publish: false,
      stop: false,
      validate_findings: false,
    },
  };
}

test("a custom fetch carries every request and keeps the configured credentials", async (t) => {
  const fixture = await server(t, (_, response) =>
    json(response, 200, { id: reviewId }),
  );
  const seen = [];
  const client = new ProoflineClient({
    baseUrl: fixture.baseUrl,
    token,
    fetch: (input, init) => {
      seen.push({ url: String(input), method: init.method });
      return fetch(input, init);
    },
  });
  await client.getReview(review);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "GET");
  assert.equal(
    seen[0].url,
    `${fixture.baseUrl}/api/v1/organizations/${orgId}/reviews/${reviewId}`,
  );
  assert.equal(fixture.calls[0].authorization, `Bearer ${token}`);
  for (const value of [null, "fetch", {}])
    assert.throws(
      () =>
        new ProoflineClient({ baseUrl: fixture.baseUrl, token, fetch: value }),
      TypeError,
    );
});

test("a custom fetch that throws surfaces as a transport error without its message", async () => {
  let attempts = 0;
  const client = new ProoflineClient({
    baseUrl: "https://proofline.example",
    token,
    fetch: async () => {
      attempts += 1;
      throw new Error(`proxy refused ${token}`);
    },
  });
  await assert.rejects(client.getReview(review), (error) => {
    assert.equal(attempts, 1);
    assert(error instanceof ProoflineError);
    assert.equal(error.type, "urn:proofline:sdk:transport");
    assert(!inspect(error).includes(token));
    return true;
  });
});

test("maxRetries bounds read retries and never retries mutations", async (t) => {
  const fixture = await server(t, (_, response) =>
    json(response, 429, { detail: "slow down" }, { "Retry-After": "0" }),
  );
  for (const [maxRetries, attempts] of [
    [undefined, 4],
    [0, 1],
    [5, 6],
  ]) {
    const client = new ProoflineClient({
      baseUrl: fixture.baseUrl,
      token,
      ...(maxRetries === undefined ? {} : { maxRetries }),
    });
    const before = fixture.calls.length;
    await assert.rejects(
      client.getReview(review),
      (error) => error instanceof ProoflineError && error.status === 429,
    );
    assert.equal(fixture.calls.length - before, attempts);
    const mutation = fixture.calls.length;
    await assert.rejects(client.rerunReview(review));
    assert.equal(fixture.calls.length - mutation, 1);
  }
  for (const maxRetries of [-1, 11, 1.5, Number.NaN, "3"])
    assert.throws(
      () =>
        new ProoflineClient({ baseUrl: fixture.baseUrl, token, maxRetries }),
      TypeError,
    );
});

test("hooks observe each attempt in order without exposing the token", async (t) => {
  const fixture = await server(t, (_, response, calls) =>
    calls.length === 1
      ? json(response, 503, { detail: "busy" }, { "Retry-After": "0" })
      : json(response, 200, { id: reviewId }),
  );
  const events = [];
  const client = new ProoflineClient({
    baseUrl: fixture.baseUrl,
    token,
    hooks: {
      onRequest: (event) => events.push(["request", event]),
      onResponse: (event) => events.push(["response", event]),
      onRetry: (event) => events.push(["retry", event]),
    },
  });
  await client.getReview(review);
  const url = `${fixture.baseUrl}/api/v1/organizations/${orgId}/reviews/${reviewId}`;
  assert.deepEqual(
    events.map(([kind, event]) => [kind, event.attempt, event.status]),
    [
      ["request", 0, undefined],
      ["response", 0, 503],
      ["retry", 0, 503],
      ["request", 1, undefined],
      ["response", 1, 200],
    ],
  );
  for (const [, event] of events) {
    assert.equal(event.method, "GET");
    assert.equal(event.url, url);
  }
  assert.equal(events[2][1].delayMs, 0);
  assert(events[4][1].durationMs >= 0);
  assert(!JSON.stringify(events).includes(token));
  assert(!inspect(events, { depth: 10 }).includes(token));
});

test("a failing hook never changes the request outcome", async (t) => {
  const fixture = await server(t, (_, response) =>
    json(response, 200, { id: reviewId }),
  );
  const client = new ProoflineClient({
    baseUrl: fixture.baseUrl,
    token,
    hooks: {
      onRequest: () => {
        throw new Error("logger offline");
      },
      onResponse: async () => {
        throw new Error("telemetry offline");
      },
    },
  });
  const result = await client.getReview(review);
  assert.equal(result.id, reviewId);
  assert.equal(fixture.calls.length, 1);
  for (const hooks of [null, { onRequest: "log" }])
    assert.throws(
      () => new ProoflineClient({ baseUrl: fixture.baseUrl, token, hooks }),
      TypeError,
    );
});

test("an AbortSignal stops a review wait between polls, in flight, and before it starts", async (t) => {
  let hang = false;
  const fixture = await server(t, (_, response) => {
    if (!hang) json(response, 200, running());
  });
  const client = new ProoflineClient({ baseUrl: fixture.baseUrl, token });

  const between = new AbortController();
  const started = performance.now();
  setTimeout(() => between.abort(new Error("cancelled by CI")), 100);
  await assert.rejects(
    client.waitForReview(orgId, reviewId, { signal: between.signal }),
    { message: "cancelled by CI" },
  );
  assert(performance.now() - started < 2000);
  assert.equal(fixture.calls.length, 1);

  hang = true;
  const inFlight = new AbortController();
  setTimeout(() => inFlight.abort(), 100);
  await assert.rejects(
    client.waitForReview(orgId, reviewId, { signal: inFlight.signal }),
    { name: "AbortError" },
  );

  const before = fixture.calls.length;
  await assert.rejects(
    client.waitForReview(orgId, reviewId, {
      signal: AbortSignal.abort(new Error("already gone")),
    }),
    { message: "already gone" },
  );
  assert.equal(fixture.calls.length, before);
  await assert.rejects(
    client.waitForReview(orgId, reviewId, { signal: "stop" }),
    TypeError,
  );
});
