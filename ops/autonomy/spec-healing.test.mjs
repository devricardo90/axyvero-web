import test from "node:test";
import assert from "node:assert/strict";
import { criteriaDigest, healSpecification, parseRepairOutput, replaceAcceptanceCriteria, SpecRepairExhaustedError } from "./spec-healing.mjs";

const criteria = [{ id: "AC-01", description: "Run npm test and require exit code 0." }];
const task = { id: "AXY-1", title: "Demo", acceptanceCriteria: criteria, acceptanceCriteriaDigest: criteriaDigest(criteria) };

function harness(reviews, repairs) {
  let current = { task, description: "Context\n\nAcceptance Criteria\n- AC-01: Run npm test and require exit code 0.\n" };
  const writes = [];
  return {
    writes,
    readIssue: async () => current,
    writeIssue: async (_id, description) => {
      writes.push(description);
      const lines = description.split("\n").filter((line) => /^- AC-/.test(line));
      const parsed = lines.map((line) => { const [, id, description] = /^- (AC-[^:]+): (.+)$/.exec(line); return { id, description }; });
      current = { task: { ...task, acceptanceCriteria: parsed, acceptanceCriteriaDigest: criteriaDigest(parsed) }, description };
    },
    reviewer: { reviewSpec: async () => reviews.shift() },
    repairer: async () => parseRepairOutput(repairs.shift()),
  };
}

test("findings repair to a new digest then clean", async () => {
  const h = harness([{ verdict: "FINDINGS", findings: [{ id: "R-1", summary: "make it testable" }] }, { verdict: "CLEAN", findings: [] }], ["REPAIRED\n- AC-01: Run npm test and require exit code 0 and report the command output."]);
  const out = await healSpecification({ task, ...h });
  assert.equal(out.attempts.length, 1);
  assert.notEqual(out.attempts[0].oldDigest, out.attempts[0].newDigest);
});

test("multiple repair rounds are retained", async () => {
  const h = harness([{ verdict: "FINDINGS", findings: [{ id: "R-1", summary: "first" }] }, { verdict: "FINDINGS", findings: [{ id: "R-2", summary: "second" }] }, { verdict: "CLEAN", findings: [] }], ["REPAIRED\n- AC-01: Run npm test with exit code 0.", "REPAIRED\n- AC-01: Run npm test with exit code 0 and preserve the output."]);
  const out = await healSpecification({ task, ...h });
  assert.equal(out.attempts.length, 2);
});

test("unchanged repair exhausts with evidence", async () => {
  const h = harness([{ verdict: "FINDINGS", findings: [{ id: "R-1", summary: "bad" }] }], ["REPAIRED\n- AC-01: Run npm test and require exit code 0."]);
  await assert.rejects(healSpecification({ task, ...h }), (error) => error instanceof SpecRepairExhaustedError && error.evidence.oldDigest === error.evidence.proposedDigest);
});

test("replacement preserves surrounding description", () => {
  const result = replaceAcceptanceCriteria("Intro\n\nAcceptance Criteria\n- AC-01: old\n\nNotes", [{ id: "AC-01", description: "new" }]);
  assert.match(result, /Intro/); assert.match(result, /- AC-01: new/); assert.match(result, /Notes/);
});
