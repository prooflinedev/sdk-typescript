import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProoflineClient } from "../dist/index.js";

const firstOrg = "00000000-0000-4000-8000-000000000001";
const secondOrg = "00000000-0000-4000-8000-000000000002";
const firstRepo = "00000000-0000-4000-8000-000000000003";
const secondRepo = "00000000-0000-4000-8000-000000000004";
const firstSha = "a".repeat(40);
const secondSha = "b".repeat(40);
const firstContent = "SF:src/first.ts\nDA:1,1\nend_of_record\n";
const secondContent = "SF:src/second.ts\nDA:2,0\nend_of_record\n";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "proofline-coverage-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "first.info"), firstContent);
  await writeFile(join(root, "second.info"), secondContent);
  const requests = [];
  const http = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      url: request.url,
      rawBody: Buffer.concat(chunks).toString("utf8"),
    });
    response.writeHead(201, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        report_id: "00000000-0000-4000-8000-000000000005",
        created: true,
        tested_sha: firstSha,
        formats: ["LCOV"],
        instrumented_lines: 1,
        covered_lines: 1,
      }),
    );
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
    token: "synthetic-coverage-token",
  });
  return {
    root,
    requests,
    client,
    baseUrl: `http://127.0.0.1:${http.address().port}`,
  };
}

function expected(org, repo, sha, name, content) {
  return {
    url: `/api/v1/organizations/${org}/repositories/${repo}/coverage-reports`,
    body: { tested_sha: sha, reports: [{ name, content }] },
  };
}

function parsedRequests(requests) {
  // Parse in the awaited test so a malformed request produces a direct failure.
  return requests.map(({ url, rawBody }) => ({
    url,
    body: JSON.parse(rawBody),
  }));
}

for (const replacePath of [false, true]) {
  test(`concurrent coverage uploads retain their own target and commit (replace path: ${replacePath})`, async (t) => {
    const { root, requests, client } = await fixture(t);
    const parameters = { path: { org_id: firstOrg, repo_id: firstRepo } };
    const upload = { root, tested_sha: firstSha, files: ["first.info"] };
    const first = client.uploadCoverageFiles(parameters, upload);

    // The first call has reached its first disk await. Reuse the objects for
    // another repository while that upload is still pending, without sleeps.
    if (replacePath) {
      parameters.path = { org_id: secondOrg, repo_id: secondRepo };
    } else {
      parameters.path.org_id = secondOrg;
      parameters.path.repo_id = secondRepo;
    }
    upload.tested_sha = secondSha;
    upload.files[0] = "second.info";
    const second = client.uploadCoverageFiles(parameters, upload);
    await Promise.all([first, second]);

    assert.equal(requests.length, 2);
    const parsed = parsedRequests(requests);
    const byReport = (name) =>
      parsed.find((request) => request.body.reports[0].name === name);
    assert.deepEqual(
      byReport("first.info"),
      expected(firstOrg, firstRepo, firstSha, "first.info", firstContent),
    );
    assert.deepEqual(
      byReport("second.info"),
      expected(secondOrg, secondRepo, secondSha, "second.info", secondContent),
    );
    assert.equal(upload.tested_sha, secondSha);
    assert.equal(parameters.path.repo_id, secondRepo);
  });
}

test("coverage uploads send the SHA that passed validation", async (t) => {
  const { root, requests, client } = await fixture(t);
  const parameters = { path: { org_id: firstOrg, repo_id: firstRepo } };
  const upload = { root, tested_sha: firstSha, files: ["first.info"] };
  const pending = client.uploadCoverageFiles(parameters, upload);
  upload.tested_sha = "main";
  await pending;
  assert.deepEqual(parsedRequests(requests), [
    expected(firstOrg, firstRepo, firstSha, "first.info", firstContent),
  ]);
});

test("coverage fixture responds even when the captured request is malformed", async (t) => {
  const { baseUrl, requests } = await fixture(t);
  for (const rawBody of ["{", '{"reports":[]}']) {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rawBody,
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).tested_sha, firstSha);
    assert.equal(requests.at(-1).rawBody, rawBody);
  }
});
