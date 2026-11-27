import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evidenceSourceLinks } from "../dist/index.js";

const commit = "0123456789abcdef0123456789abcdef01234567";
const otherCommit = "fedcba9876543210fedcba9876543210fedcba98";

function file(fields = {}) {
  return {
    kind: "repository_file",
    label: "src/app.ts:10-14",
    provenance_status: "VERIFIED_REPOSITORY_READ",
    commit_sha: commit,
    repository_path: "src/app.ts",
    start_line: 10,
    end_line: 14,
    companion_repository: null,
    file_sha256: null,
    url: null,
    ...fields,
  };
}

function companionFile(fields = {}) {
  return file({
    kind: "companion_repository_file",
    label: "infra/main.tf:3",
    companion_repository: "acme/infra",
    repository_path: "infra/main.tf",
    start_line: 3,
    end_line: null,
    ...fields,
  });
}

function linkOf(evidence, repositories = { repository: "acme/app" }) {
  const links = evidenceSourceLinks(
    { evidence_refs: [evidence] },
    repositories,
  );
  assert.equal(links.length, 1);
  assert.equal(links[0].evidence, evidence);
  return links[0];
}

function reasonOf(evidence, repositories) {
  const link = linkOf(evidence, repositories);
  assert.equal(link.url, null);
  return link.reason;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test("review repository evidence links at its own commit and cited lines", () => {
  const evidence = file();
  assert.deepEqual(linkOf(evidence), {
    evidence,
    url: `https://github.com/acme/app/blob/${commit}/src/app.ts#L10-L14`,
    reason: null,
    repository: "acme/app",
    commitSha: commit,
    path: "src/app.ts",
    lines: { start: 10, end: 14 },
  });
  for (const [lines, anchor, range] of [
    [{ start_line: 7, end_line: null }, "#L7", { start: 7, end: 7 }],
    [{ start_line: 7, end_line: undefined }, "#L7", { start: 7, end: 7 }],
    [{ start_line: 7, end_line: 7 }, "#L7", { start: 7, end: 7 }],
    [{ start_line: null, end_line: null }, "", null],
    [{ start_line: undefined, end_line: undefined }, "", null],
  ]) {
    const link = linkOf(file(lines));
    assert.equal(
      link.url,
      `https://github.com/acme/app/blob/${commit}/src/app.ts${anchor}`,
    );
    assert.deepEqual(link.lines, range);
  }
  const upper = linkOf(file({ commit_sha: commit.toUpperCase() }));
  assert.equal(upper.commitSha, commit);
  assert.ok(upper.url.includes(`/blob/${commit}/`));
});

test("companion evidence links only into a listed companion repository", () => {
  const evidence = companionFile();
  assert.deepEqual(linkOf(evidence, { companions: ["Acme/Infra"] }), {
    evidence,
    url: `https://github.com/Acme/Infra/blob/${commit}/infra/main.tf#L3`,
    reason: null,
    repository: "Acme/Infra",
    commitSha: commit,
    path: "infra/main.tf",
    lines: { start: 3, end: 3 },
  });
  // The first spelling of a repeated companion wins.
  assert.equal(
    linkOf(evidence, { companions: ["acme/infra", "ACME/INFRA"] }).repository,
    "acme/infra",
  );
  // A companion reference never falls back to the review repository, and a
  // review reference never links into a companion.
  assert.equal(
    reasonOf(evidence, { repository: "acme/infra" }),
    "REPOSITORY_NOT_MAPPED",
  );
  assert.equal(
    reasonOf(evidence, { repository: "acme/infra", companions: ["acme/web"] }),
    "REPOSITORY_NOT_MAPPED",
  );
  assert.equal(
    reasonOf(file(), { companions: ["acme/app"] }),
    "REPOSITORY_NOT_MAPPED",
  );
  const mapping = { repository: "acme/app", companions: ["acme/infra"] };
  for (const recorded of [null, undefined, ""])
    assert.equal(
      reasonOf(companionFile({ companion_repository: recorded }), mapping),
      "REPOSITORY_MISSING",
    );
  for (const recorded of [
    "acme",
    "acme/infra/extra",
    "https://github.com/acme/infra",
    "acme/..",
    "../infra",
    " acme/infra",
    "acme/in fra",
    42,
  ])
    assert.equal(
      reasonOf(companionFile({ companion_repository: recorded }), mapping),
      "REPOSITORY_INVALID",
    );
  // A review reference that also names a companion has no single repository.
  assert.equal(
    reasonOf(file({ companion_repository: "acme/infra" }), mapping),
    "REPOSITORY_AMBIGUOUS",
  );
  assert.equal(
    linkOf(file({ companion_repository: "" }), mapping).repository,
    "acme/app",
  );
});

test("links never fall back to the review head, a branch or the evidence url", () => {
  const branchUrl = "https://github.com/acme/app/blob/main/src/app.ts#L10";
  const repositories = {
    repository: "acme/app",
    // Unknown options are ignored; the helper has no commit input at all.
    head_commit_sha: otherCommit,
    current_head_commit_sha: otherCommit,
    branch: "main",
  };
  const withoutCommit = file({ url: branchUrl });
  delete withoutCommit.commit_sha;
  for (const evidence of [
    file({ commit_sha: null, url: branchUrl }),
    file({ commit_sha: "", url: branchUrl }),
    withoutCommit,
  ])
    assert.equal(reasonOf(evidence, repositories), "COMMIT_MISSING");
  for (const sha of [
    "main",
    "refs/heads/main",
    "HEAD",
    commit.slice(0, 7),
    `${commit}0`,
    `${commit}${commit.slice(0, 24)}`,
    "0".repeat(40),
    ` ${commit}`,
    `${commit.slice(0, 39)}g`,
    123,
  ])
    assert.equal(
      reasonOf(file({ commit_sha: sha, url: branchUrl }), repositories),
      "COMMIT_INVALID",
    );
  const link = linkOf(
    file({
      url: `https://github.com/evil/fork/blob/${otherCommit}/src/app.ts`,
    }),
    repositories,
  );
  assert.equal(
    link.url,
    `https://github.com/acme/app/blob/${commit}/src/app.ts#L10-L14`,
  );
});

test("repository paths are percent-encoded per segment", () => {
  for (const [path, encoded] of [
    ["docs/My File #1?.md", "docs/My%20File%20%231%3F.md"],
    ["src/100%.ts", "src/100%25.ts"],
    ["src/%2e%2e/x.ts", "src/%252e%252e/x.ts"],
    ["app/(group)/[id]/page.tsx", "app/%28group%29/%5Bid%5D/page.tsx"],
    ["it's*!.txt", "it%27s%2A%21.txt"],
    ["lib/naïve/日本.ts", "lib/na%C3%AFve/%E6%97%A5%E6%9C%AC.ts"],
    ["scripts/a\\b.sh", "scripts/a%5Cb.sh"],
    ["a/b&c=d;e+f.ts", "a/b%26c%3Dd%3Be%2Bf.ts"],
    [".github/workflows/ci.yml", ".github/workflows/ci.yml"],
    ["src/..config/x.ts", "src/..config/x.ts"],
  ]) {
    const link = linkOf(
      file({ repository_path: path, start_line: null, end_line: null }),
    );
    assert.equal(
      link.url,
      `https://github.com/acme/app/blob/${commit}/${encoded}`,
    );
    assert.equal(link.path, path);
  }
  for (const path of [
    "/etc/passwd",
    "src/",
    "src//app.ts",
    "./src/app.ts",
    "src/../secrets.ts",
    "..",
    ".",
    "/",
    "src/\0.ts",
    "src/\uD800.ts",
    42,
    ["src", "app.ts"],
  ])
    assert.equal(
      reasonOf(file({ repository_path: path })),
      "PATH_INVALID",
      String(path),
    );
  for (const path of [null, undefined, ""])
    assert.equal(reasonOf(file({ repository_path: path })), "PATH_MISSING");
});

test("line anchors require 1-based ordered integers", () => {
  for (const lines of [
    { start_line: 0, end_line: null },
    { start_line: -1, end_line: null },
    { start_line: 1.5, end_line: null },
    { start_line: "10", end_line: null },
    { start_line: Number.NaN, end_line: null },
    { start_line: Number.POSITIVE_INFINITY, end_line: null },
    { start_line: 2 ** 32, end_line: null },
    { start_line: null, end_line: 5 },
    { start_line: undefined, end_line: 5 },
    { start_line: 10, end_line: 9 },
    { start_line: 10, end_line: "12" },
    { start_line: 10, end_line: 0 },
  ])
    assert.equal(reasonOf(file(lines)), "LINES_INVALID", JSON.stringify(lines));
  assert.equal(
    linkOf(file({ start_line: 1, end_line: 2 ** 32 - 1 })).url,
    `https://github.com/acme/app/blob/${commit}/src/app.ts#L1-L4294967295`,
  );
});

test("Markdown line citations open in GitHub's source view", () => {
  for (const path of [
    "README.md",
    "docs/Policy.MARKDOWN",
    "docs/runbook.mdown",
    "docs/setup.mkdn",
  ])
    assert.equal(
      linkOf(file({ repository_path: path })).url,
      `https://github.com/acme/app/blob/${commit}/${path}?plain=1#L10-L14`,
    );
  assert.equal(
    linkOf(
      file({ repository_path: "README.md", start_line: null, end_line: null }),
    ).url,
    `https://github.com/acme/app/blob/${commit}/README.md`,
  );
});

test("unsupported and unverified references keep their place in source order", () => {
  const unverified = file({ provenance_status: "PROVIDER_REFERENCE" });
  const noProvenance = file();
  delete noProvenance.provenance_status;
  const references = [
    {
      kind: "commit",
      label: commit.slice(0, 7),
      provenance_status: "PROVIDER_REFERENCE",
      commit_sha: commit,
      url: `https://github.com/acme/app/commit/${commit}`,
    },
    file({ label: "first" }),
    {
      kind: "workflow_run",
      label: "CI run",
      provenance_status: "PROVIDER_REFERENCE",
      workflow_run_id: 99,
      workflow_attempt: 1,
      url: "https://github.com/acme/app/actions/runs/99",
    },
    {
      kind: "text",
      label: "note",
      provenance_status: "LEGACY_UNSTRUCTURED",
      legacy_text: "see src/app.ts on main",
    },
    file({ kind: "repository_file_at_commit" }),
    file({ kind: "Repository_File" }),
    file({ kind: "repository_symbol" }),
    unverified,
    noProvenance,
    file({ provenance_status: "verified_repository_read" }),
    companionFile({ label: "last" }),
  ];
  const links = evidenceSourceLinks(
    { evidence_refs: references },
    { repository: "acme/app", companions: ["acme/infra"] },
  );
  assert.equal(links.length, references.length);
  links.forEach((link, index) => {
    assert.equal(link.evidence, references[index]);
  });
  assert.deepEqual(
    links.map((link) => link.reason),
    [
      "UNSUPPORTED_KIND",
      null,
      "UNSUPPORTED_KIND",
      "UNSUPPORTED_KIND",
      "UNSUPPORTED_KIND",
      "UNSUPPORTED_KIND",
      "UNSUPPORTED_KIND",
      "PROVENANCE_UNVERIFIED",
      "PROVENANCE_UNVERIFIED",
      "PROVENANCE_UNVERIFIED",
      null,
    ],
  );
  assert.deepEqual(
    links.map((link) => link.url),
    [
      null,
      `https://github.com/acme/app/blob/${commit}/src/app.ts#L10-L14`,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      `https://github.com/acme/infra/blob/${commit}/infra/main.tf#L3`,
    ],
  );
});

test("evidence defects are reported before an unmapped repository", () => {
  for (const repositories of [
    {},
    { repository: null },
    { repository: undefined },
    { companions: [] },
  ]) {
    assert.equal(reasonOf(file(), repositories), "REPOSITORY_NOT_MAPPED");
    assert.equal(
      reasonOf(companionFile(), repositories),
      "REPOSITORY_NOT_MAPPED",
    );
    assert.equal(
      reasonOf(file({ provenance_status: "RECORDED_READ" }), repositories),
      "PROVENANCE_UNVERIFIED",
    );
    assert.equal(
      reasonOf(companionFile({ companion_repository: null }), repositories),
      "REPOSITORY_MISSING",
    );
    assert.equal(
      reasonOf(companionFile({ companion_repository: "infra" }), repositories),
      "REPOSITORY_INVALID",
    );
    assert.equal(
      reasonOf(file({ companion_repository: "acme/infra" }), repositories),
      "REPOSITORY_AMBIGUOUS",
    );
    assert.equal(
      reasonOf(file({ commit_sha: null }), repositories),
      "COMMIT_MISSING",
    );
    assert.equal(
      reasonOf(file({ commit_sha: "main" }), repositories),
      "COMMIT_INVALID",
    );
    assert.equal(
      reasonOf(file({ repository_path: null }), repositories),
      "PATH_MISSING",
    );
    assert.equal(
      reasonOf(file({ repository_path: "../x" }), repositories),
      "PATH_INVALID",
    );
    assert.equal(
      reasonOf(file({ start_line: 0 }), repositories),
      "LINES_INVALID",
    );
  }
  // With several defects, the earliest check names the reason.
  assert.equal(
    reasonOf(
      file({
        provenance_status: "PROVIDER_REFERENCE",
        commit_sha: null,
        repository_path: null,
      }),
    ),
    "PROVENANCE_UNVERIFIED",
  );
  assert.equal(
    reasonOf(
      file({ commit_sha: "main", repository_path: "/x", start_line: 0 }),
    ),
    "COMMIT_INVALID",
  );
  assert.equal(
    reasonOf(file({ repository_path: "/x", start_line: 0 })),
    "PATH_INVALID",
  );
});

test("links are computed without requests or changes to the finding", async (t) => {
  const fetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("evidence links must not make requests");
  };
  t.after(() => {
    globalThis.fetch = fetch;
  });
  const finding = deepFreeze({
    id: "00000000-0000-7000-8000-000000000005",
    claim: "claim",
    impact: "impact",
    severity: "SERIOUS",
    risk_domain: "data",
    lifecycle_state: "NEW",
    comment_reactions: [],
    rule_refs: [],
    symbols: [],
    evidence_refs: [
      file(),
      companionFile(),
      { kind: "text", label: "x", provenance_status: "LEGACY_UNSTRUCTURED" },
    ],
    supporting_evidence: {
      explanation: null,
      evidence_refs: [file({ repository_path: "src/support.ts" })],
    },
  });
  const repositories = deepFreeze({
    repository: "acme/app",
    companions: ["acme/infra"],
  });
  const first = evidenceSourceLinks(finding, repositories);
  assert.deepEqual(evidenceSourceLinks(finding, repositories), first);
  assert.deepEqual(
    first.map((link) => link.reason),
    [null, null, "UNSUPPORTED_KIND"],
  );
  assert.equal(first[1].evidence, finding.evidence_refs[1]);
  const support = evidenceSourceLinks(
    finding.supporting_evidence,
    repositories,
  );
  assert.equal(
    support[0].url,
    `https://github.com/acme/app/blob/${commit}/src/support.ts#L10-L14`,
  );
  assert.deepEqual(evidenceSourceLinks({ evidence_refs: [] }, {}), []);
});

test("GitHub Enterprise Server origins link on their own host", () => {
  for (const [origin, base] of [
    ["https://github.com", "https://github.com"],
    ["https://github.com/", "https://github.com"],
    ["https://GHE.example.com/", "https://ghe.example.com"],
    ["https://ghe.example.com:8443", "https://ghe.example.com:8443"],
    ["https://ghe.example.com:443", "https://ghe.example.com"],
  ])
    assert.equal(
      linkOf(file({ start_line: null, end_line: null }), {
        repository: "acme/app",
        githubOrigin: origin,
      }).url,
      `${base}/acme/app/blob/${commit}/src/app.ts`,
    );
});

test("invalid caller input throws TypeError before any link", () => {
  const finding = { evidence_refs: [] };
  for (const repository of [
    "acme",
    "acme/app/extra",
    "https://github.com/acme/app",
    "acme/..",
    "acme/.",
    "-acme/app",
    "ac.me/app",
    " acme/app",
    "acme/app ",
    "",
    42,
  ])
    assert.throws(() => evidenceSourceLinks(finding, { repository }), {
      name: "TypeError",
      message: "repository must be a GitHub owner/name",
    });
  assert.throws(
    () => evidenceSourceLinks(finding, { companions: ["acme/infra", "infra"] }),
    { name: "TypeError", message: "companions[1] must be a GitHub owner/name" },
  );
  assert.throws(
    () => evidenceSourceLinks(finding, { companions: "acme/infra" }),
    { name: "TypeError", message: /companions must be an array/ },
  );
  for (const githubOrigin of [
    "http://github.com",
    "https://github.com/acme",
    "https://github.com/acme/..",
    "https:github.com",
    "https://github.com\\",
    "https://git\thub.com",
    "https://github.com\u001d",
    "https://@github.com",
    "https://user:secret-canary@github.com",
    "https://github.com?",
    "https://github.com?tab=1",
    "https://github.com#",
    "https://github.com#top",
    "github.com",
    "",
    42,
    null,
  ])
    assert.throws(
      () =>
        evidenceSourceLinks(finding, { repository: "acme/app", githubOrigin }),
      (error) =>
        error instanceof TypeError &&
        error.message ===
          "githubOrigin must be an HTTPS origin such as https://github.com",
    );
  for (const value of [
    null,
    undefined,
    {},
    { evidence_refs: "src/app.ts" },
    { evidence_refs: null },
  ])
    assert.throws(() => evidenceSourceLinks(value, {}), {
      name: "TypeError",
      message: "finding.evidence_refs must be an array",
    });
  for (const entry of [null, "src/app.ts", [file()]])
    assert.throws(
      () => evidenceSourceLinks({ evidence_refs: [file(), entry] }, {}),
      {
        name: "TypeError",
        message: "each evidence reference must be an object",
      },
    );
});

test("public evidence link types narrow and name every reason", async (t) => {
  // Mirrors the README example against the built declarations.
  const work = await mkdtemp(join(tmpdir(), "sdk-evidence-types-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const fixture = join(work, "consumer.mts");
  await writeFile(
    fixture,
    `
import {
  evidenceSourceLinks,
  type EvidenceLinkUnavailableReason,
  type EvidenceRepositories,
  type EvidenceSourceLink,
  type LinkedEvidence,
  type ProoflineClient,
  type UnlinkedEvidence,
} from ${JSON.stringify(entry)};

function explain(reason: EvidenceLinkUnavailableReason): string {
  switch (reason) {
    case "UNSUPPORTED_KIND":
    case "PROVENANCE_UNVERIFIED":
    case "REPOSITORY_MISSING":
    case "REPOSITORY_INVALID":
    case "REPOSITORY_AMBIGUOUS":
    case "COMMIT_MISSING":
    case "COMMIT_INVALID":
    case "PATH_MISSING":
    case "PATH_INVALID":
    case "LINES_INVALID":
    case "REPOSITORY_NOT_MAPPED":
      return reason;
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}

export async function render(client: ProoflineClient, organizationId: string, reviewId: string, configuredGithubOrigin: string): Promise<string[]> {
  const review = await client.getReview({ path: { org_id: organizationId, review_id: reviewId } });
  // The README's untyped literal must satisfy the published options type.
  const repositories = {
    githubOrigin: review.repository_url
      ? new URL(review.repository_url).origin
      : configuredGithubOrigin,
    repository: review.repository_full_name,
    companions: review.subjects
      .filter((subject) => subject.role === "COMPANION")
      .flatMap((subject) => (subject.repository_full_name ? [subject.repository_full_name] : [])),
  };
  const typed: EvidenceRepositories = repositories;
  const output: string[] = [String(evidenceSourceLinks({ evidence_refs: [] }, typed).length)];
  for (const finding of review.code_assessment?.findings ?? []) {
    for (const link of evidenceSourceLinks(finding, repositories)) {
      if (link.url !== null) {
        const linked: LinkedEvidence = link;
        output.push(\`\${linked.url} \${linked.repository} \${linked.commitSha} \${linked.path} \${linked.lines?.end ?? ""}\`);
      } else {
        const unlinked: UnlinkedEvidence = link;
        output.push(\`\${unlinked.evidence.label} \${explain(unlinked.reason)}\`);
      }
    }
    if (finding.supporting_evidence) {
      const support: EvidenceSourceLink[] = evidenceSourceLinks(finding.supporting_evidence, {
        repository: review.repository_full_name,
        githubOrigin: "https://ghe.example.com",
      });
      output.push(String(support.length));
    }
  }
  return output;
}
`,
  );
  execFileSync(process.execPath, [
    fileURLToPath(
      new URL("../node_modules/typescript/lib/tsc.js", import.meta.url),
    ),
    "--noEmit",
    "--strict",
    "--exactOptionalPropertyTypes",
    "--target",
    "ES2022",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    fixture,
  ]);
});
