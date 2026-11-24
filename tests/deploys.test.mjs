import assert from "node:assert/strict";
import test from "node:test";
import { judgeDeployVerifications, ProoflineError } from "../dist/index.js";

const CHECKPOINTS = ["LANDING", "MINUTES_20", "HOUR_1", "DAY_1"];

/** A deploy whose checks recorded `results` in order, the rest not yet. */
function deploy(results = [], gaps = [], fields = {}) {
  return {
    environment_id: "00000000-0000-7000-8000-0000000000e0",
    github_environment: "production",
    deployment_task: "deploy",
    state: "NOT_YET_DUE",
    regressed: results.includes("REGRESSED"),
    checkpoints: CHECKPOINTS.map((checkpoint, index) => ({
      checkpoint,
      result: results[index] ?? null,
      due_at: "2026-11-21T00:00:00Z",
    })),
    gaps,
    deploy_url: "https://console.proofline.example/deploys/1",
    ...fields,
  };
}

function recorded(...deploys) {
  return { recorded: deploys.length > 0, deploys };
}

const healthy = deploy(["HEALTHY", "HEALTHY", "HEALTHY"]);
const gap = deploy(["HEALTHY", "HEALTHY", "HEALTHY"], ["SIGNAL_NO_DATA"]);
// A current server names each check's own gaps: here only the 20-minute one.
const laterGap = {
  ...gap,
  checkpoints: gap.checkpoints.map((check, index) => ({
    ...check,
    gaps: index === 1 ? ["SIGNAL_NO_DATA"] : [],
  })),
};

test("each recorded result reads as proofline ci deploy reads it", () => {
  for (const [name, until, body, status, reading] of [
    ["healthy", "LANDING", healthy, "NO_REGRESSION"],
    ["healthy at the hour check", "HOUR_1", healthy, "NO_REGRESSION"],
    ["regressed at landing", "LANDING", deploy(["REGRESSED"]), "REGRESSED"],
    [
      "regressed after the named check",
      "LANDING",
      deploy(["HEALTHY", "REGRESSED"]),
      "REGRESSED",
    ],
    [
      "regressed by a later check alone",
      "LANDING",
      deploy(["HEALTHY", "REGRESSED"], [], { regressed: false }),
      "REGRESSED",
    ],
    [
      "regressed by the deploy's flag alone",
      "LANDING",
      { ...healthy, regressed: true },
      "REGRESSED",
    ],
    [
      "failed after landing",
      "LANDING",
      { ...healthy, state: "FAILED" },
      "REGRESSED",
    ],
    ["deploy-wide gap from an older server", "LANDING", gap, "NOT_ESTABLISHED"],
    [
      "gap first seen after the named check",
      "LANDING",
      laterGap,
      "NO_REGRESSION",
    ],
    ["gap at the named check", "MINUTES_20", laterGap, "NOT_ESTABLISHED"],
    ["gap before the named check", "HOUR_1", laterGap, "NOT_ESTABLISHED"],
    [
      "incomplete",
      "LANDING",
      deploy(["INCOMPLETE"], ["SIGNAL_NO_DATA"]),
      "NOT_ESTABLISHED",
    ],
    [
      "superseded",
      "LANDING",
      deploy(["SUPERSEDED"]),
      "NOT_ESTABLISHED",
      "SUPERSEDED",
    ],
    [
      "superseded before the named check",
      "HOUR_1",
      deploy(["HEALTHY", "SUPERSEDED"]),
      "NOT_ESTABLISHED",
      "SUPERSEDED",
    ],
    [
      "unverified",
      "LANDING",
      deploy([], [], { state: "UNVERIFIED", checkpoints: [] }),
      "NOT_ESTABLISHED",
      "UNVERIFIED",
    ],
    ["check not recorded yet", "LANDING", deploy(), "WAITING"],
    [
      "named check not recorded after healthy earlier ones",
      "HOUR_1",
      deploy(["HEALTHY", "HEALTHY"]),
      "WAITING",
    ],
    [
      "no checkpoints yet",
      "LANDING",
      deploy([], [], { checkpoints: [] }),
      "WAITING",
    ],
  ]) {
    const verdict = judgeDeployVerifications(recorded(body), { until });
    assert.equal(verdict.status, status, name);
    assert.equal(verdict.until, until, name);
    assert.deepEqual(
      verdict.deploys,
      [{ deploy: body, reading: reading ?? status }],
      name,
    );
  }
  assert.equal(judgeDeployVerifications(recorded(healthy)).until, "LANDING");
});

test("what this SDK does not know is never NO_REGRESSION", () => {
  const check = (fields) => ({
    ...healthy,
    checkpoints: [{ ...healthy.checkpoints[0], ...fields }],
  });
  for (const [name, until, body] of [
    ["an unknown result", "LANDING", deploy(["PROBABLY_FINE"])],
    [
      "an unknown result before the named check",
      "MINUTES_20",
      deploy(["LIKELY", "HEALTHY"]),
    ],
    ["an unknown state", "LANDING", { ...healthy, state: "ARCHIVED" }],
    ["an unknown state later", "HOUR_1", { ...healthy, state: "ARCHIVED" }],
    ["a result that is not text", "LANDING", check({ result: true })],
    ["checkpoint gaps that are not a list", "LANDING", check({ gaps: "none" })],
    ["a gap that is not text", "LANDING", { ...healthy, gaps: [0] }],
    [
      "a missing earlier checkpoint",
      "MINUTES_20",
      { ...healthy, checkpoints: healthy.checkpoints.slice(1) },
    ],
  ]) {
    const verdict = judgeDeployVerifications(recorded(body), { until });
    assert.equal(verdict.status, "NOT_ESTABLISHED", name);
  }
});

test("no deploy, and no selected deploy, is WAITING and never a result", () => {
  for (const [name, body, options] of [
    ["no deploy recorded", recorded(), {}],
    ["recorded with an empty list", { recorded: true, deploys: [] }, {}],
    ["nothing selected", recorded(healthy), { select: () => false }],
  ]) {
    const verdict = judgeDeployVerifications(body, options);
    assert.equal(verdict.status, "WAITING", name);
    assert.deepEqual(verdict.deploys, [], name);
  }
});

test("every selected deploy counts, and a regression decides at once", () => {
  const staging = deploy(["REGRESSED"], [], { github_environment: "staging" });
  const pending = deploy([], [], { deployment_task: "deploy:web" });
  const production = (item) => item.github_environment === "production";
  for (const [deploys, select, status, readings] of [
    [
      [healthy, staging],
      undefined,
      "REGRESSED",
      ["NO_REGRESSION", "REGRESSED"],
    ],
    [[healthy, staging], production, "NO_REGRESSION", ["NO_REGRESSION"]],
    [[healthy, pending], undefined, "WAITING", ["NO_REGRESSION", "WAITING"]],
    [[pending, staging], undefined, "REGRESSED", ["WAITING", "REGRESSED"]],
    [
      [healthy, gap],
      undefined,
      "NOT_ESTABLISHED",
      ["NO_REGRESSION", "NOT_ESTABLISHED"],
    ],
    [[gap, pending], undefined, "WAITING", ["NOT_ESTABLISHED", "WAITING"]],
    [
      [healthy, healthy],
      undefined,
      "NO_REGRESSION",
      ["NO_REGRESSION", "NO_REGRESSION"],
    ],
  ]) {
    const verdict = judgeDeployVerifications(recorded(...deploys), { select });
    assert.equal(verdict.status, status);
    assert.deepEqual(
      verdict.deploys.map((item) => item.reading),
      readings,
    );
  }
});

test("a malformed response is refused, never read as a result", () => {
  const without = (field) => {
    const copy = { ...healthy };
    delete copy[field];
    return copy;
  };
  for (const [name, body] of [
    ["nothing", undefined],
    ["null", null],
    ["a list", [healthy]],
    ["no deploy list", { recorded: true }],
    ["deploys beside recorded: false", { recorded: false, deploys: [healthy] }],
    ["no recorded flag", { deploys: [healthy] }],
    ["recorded is not a boolean", { recorded: "true", deploys: [healthy] }],
    ...[
      ["INCOMPLETE", undefined],
      ["HEALTHY", ["SIGNAL_NO_DATA"]],
      ["SUPERSEDED", undefined],
      [null, undefined],
      ["HEALTHY", []],
    ].map(([result, gaps]) => [
      `a repeated checkpoint that then records ${result} with gaps ${gaps}`,
      recorded({
        ...healthy,
        checkpoints: [
          { ...healthy.checkpoints[0], gaps: [] },
          { ...healthy.checkpoints[0], result, gaps },
        ],
      }),
    ]),
    ["deploys that are not a list", { recorded: true, deploys: healthy }],
    ["a deploy that is not an object", recorded("healthy")],
    ["no state", recorded(without("state"))],
    ["no regressed flag", recorded(without("regressed"))],
    [
      "regressed is not a boolean",
      recorded({ ...healthy, regressed: "false" }),
    ],
    ["no gaps", recorded(without("gaps"))],
    ["no checkpoints", recorded(without("checkpoints"))],
    [
      "a checkpoint that is not an object",
      recorded({ ...healthy, checkpoints: [null] }),
    ],
    // One malformed deploy refuses the response even when it is not selected.
    [
      "a malformed deploy beside a healthy one",
      recorded(healthy, without("state")),
    ],
  ]) {
    assert.throws(
      () =>
        judgeDeployVerifications(body, { select: (item) => item === healthy }),
      (error) => {
        assert(error instanceof ProoflineError, name);
        assert.equal(error.type, "urn:proofline:sdk:invalid-response", name);
        return true;
      },
      name,
    );
  }
  for (const until of ["1h", "landing", ""])
    assert.throws(
      () => judgeDeployVerifications(recorded(healthy), { until }),
      TypeError,
    );
});
