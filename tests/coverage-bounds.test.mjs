import assert from "node:assert/strict";
import { once } from "node:events";
import fs, {
  mkdtemp,
  open,
  rename,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProoflineClient } from "../dist/index.js";

const limit = 30 * 1024 * 1024;
const sha = "a".repeat(40);
const parameters = { path: { org_id: "organization", repo_id: "repository" } };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "proofline-coverage-bounds-"));
  const bodies = [];
  const http = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      bodies.push(Buffer.concat(chunks));
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ created: true, tested_sha: sha }));
    } catch {
      response.destroy();
    }
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(async () => {
    await new Promise((resolve) => {
      http.close(resolve);
      http.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true });
  });
  const client = new ProoflineClient({
    baseUrl: `http://127.0.0.1:${http.address().port}`,
    token: "coverage-bounds-test-token",
  });
  return { root, bodies, client };
}

test("a report growing after preflight is refused before decoding its oversized tail", async (t) => {
  const { root, bodies, client } = await fixture(t);
  const report = join(root, "growing.info");
  await writeFile(report, "SF:source.ts\n");
  const originalStat = fs.stat;
  let grew = false;
  // Deterministically reproduce a writer growing the file after the size was
  // observed. The report itself and every byte subsequently read are real.
  t.mock.method(fs, "stat", async (...args) => {
    const snapshot = await originalStat(...args);
    if (args[0] === report && !grew) {
      grew = true;
      await truncate(report, limit + 1);
      const handle = await open(report, "r+");
      try {
        await handle.write(Buffer.from([0xff]), 0, 1, limit);
      } finally {
        await handle.close();
      }
    }
    return snapshot;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(
    client.uploadCoverageFiles(parameters, {
      tested_sha: sha,
      root,
      files: ["growing.info"],
    }),
    (error) => error instanceof TypeError && /30 MiB/.test(error.message),
  );
  assert.equal(grew, true);
  assert.equal(bodies.length, 0);
  // This also verifies that a refused read leaves no open file handle on Windows.
  await rename(report, join(root, "closed.info"));
});

test("JSON expansion exhausts the budget before reading later malformed reports", async (t) => {
  const { root, bodies, client } = await fixture(t);
  // Each NUL is one byte on disk and six bytes in a JSON string.
  await writeFile(join(root, "escaped.info"), Buffer.alloc(6 * 1024 * 1024));
  await writeFile(join(root, "invalid.info"), Buffer.from([0xff]));
  await assert.rejects(
    client.uploadCoverageFiles(parameters, {
      tested_sha: sha,
      root,
      files: ["escaped.info", "invalid.info"],
    }),
    (error) => error instanceof TypeError && /30 MiB/.test(error.message),
  );
  assert.equal(bodies.length, 0);
});

test("the encoded byte budget is shared across reports", async (t) => {
  const { root, bodies, client } = await fixture(t);
  await writeFile(join(root, "first.info"), Buffer.alloc(3 * 1024 * 1024));
  await writeFile(join(root, "second.info"), Buffer.alloc(3 * 1024 * 1024));
  await writeFile(join(root, "invalid.info"), Buffer.from([0xff]));
  await assert.rejects(
    client.uploadCoverageFiles(parameters, {
      tested_sha: sha,
      root,
      files: ["first.info", "second.info", "invalid.info"],
    }),
    (error) => error instanceof TypeError && /30 MiB/.test(error.message),
  );
  assert.equal(bodies.length, 0);
});

test("chunked reads preserve BOM, split Unicode, quotes, escapes and CRLF", async (t) => {
  const { root, bodies, client } = await fixture(t);
  // With 64 KiB reads, the four-byte character straddles the first boundary.
  const content = `\uFEFF${"a".repeat(65_531)}\u{1F680}\r\n"\\\u0000\u001f`;
  await writeFile(join(root, "unicode.info"), content);
  const second = "\uFEFFSF:second.ts\r\nend_of_record\r\n";
  await writeFile(join(root, "second.info"), second);
  await client.uploadCoverageFiles(parameters, {
    tested_sha: sha,
    root,
    files: ["unicode.info", "second.info"],
  });
  assert.equal(bodies.length, 1);
  assert.deepEqual(JSON.parse(bodies[0].toString("utf8")), {
    tested_sha: sha,
    reports: [
      { name: "unicode.info", content },
      { name: "second.info", content: second },
    ],
  });
});

test("an incomplete UTF-8 character cannot continue into the next report", async (t) => {
  const { root, bodies, client } = await fixture(t);
  await writeFile(join(root, "first.info"), Buffer.from([0xe2]));
  await writeFile(join(root, "second.info"), Buffer.from([0x82, 0xac]));
  await assert.rejects(
    client.uploadCoverageFiles(parameters, {
      tested_sha: sha,
      root,
      files: ["first.info", "second.info"],
    }),
    (error) =>
      error instanceof TypeError &&
      /first.info is not UTF-8/.test(error.message),
  );
  assert.equal(bodies.length, 0);
  await rename(join(root, "first.info"), join(root, "closed.info"));
});

test("the exact encoded body limit is accepted and one more byte is refused", async (t) => {
  const { root, bodies, client } = await fixture(t);
  const name = "boundary.info";
  const overhead = Buffer.byteLength(
    JSON.stringify({ tested_sha: sha, reports: [{ name, content: "" }] }),
  );
  const report = join(root, name);
  await writeFile(report, "x".repeat(limit - overhead));
  await client.uploadCoverageFiles(parameters, {
    tested_sha: sha,
    root,
    files: [name],
  });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].length, limit);
  const handle = await open(report, "a");
  try {
    await handle.write("x");
  } finally {
    await handle.close();
  }
  await assert.rejects(
    client.uploadCoverageFiles(parameters, {
      tested_sha: sha,
      root,
      files: [name],
    }),
    (error) => error instanceof TypeError && /30 MiB/.test(error.message),
  );
  assert.equal(bodies.length, 1);
});
