import { createHash } from "node:crypto";

export class SpecRepairExhaustedError extends Error {
  constructor(message, evidence) { super(message); this.name = "SpecRepairExhaustedError"; this.code = "SPEC_REPAIR_EXHAUSTED"; this.evidence = evidence; }
}

export class SpecNeedsOwnerError extends Error {
  constructor(question, evidence) { super(question); this.name = "SpecNeedsOwnerError"; this.code = "NEEDS_OWNER"; this.question = question; this.evidence = evidence; }
}

export function criteriaDigest(criteria) {
  return createHash("sha256").update(JSON.stringify(criteria.map(({ id, description, text }) => ({ id, description: description ?? text }))), "utf8").digest("hex");
}

export function parseRepairOutput(output) {
  const text = String(output ?? "").trim();
  if (/^NEEDS_OWNER\b/i.test(text)) return { kind: "NEEDS_OWNER", question: text.replace(/^NEEDS_OWNER\s*/i, "").trim() };
  if (!/^REPAIRED\b/i.test(text)) throw new Error("spec repair must start with REPAIRED or NEEDS_OWNER");
  const criteria = [];
  for (const line of text.replace(/^REPAIRED\s*/i, "").split(/\r?\n/)) {
    const match = line.trim().match(/^[-*]\s*(AC-[A-Za-z0-9_-]+)\s*:\s*(.+)$/i);
    if (match) criteria.push({ id: match[1], description: match[2].trim() });
  }
  if (!criteria.length) throw new Error("REPAIRED output contains no acceptance criteria");
  if (new Set(criteria.map((item) => item.id)).size !== criteria.length) throw new Error("REPAIRED output contains duplicate acceptance criterion IDs");
  return { kind: "REPAIRED", criteria };
}

export function replaceAcceptanceCriteria(description, criteria) {
  const text = String(description ?? "");
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const heading = lines.findIndex((line) => /^\s*#{0,6}\s*Acceptance Criteria\s*:??\s*$/i.test(line));
  const block = ["Acceptance Criteria", ...criteria.map(({ id, description }) => `- ${id}: ${description}`), ""];
  if (heading < 0) return `${text.trimEnd()}\n\n${block.join("\n")}`;
  let end = heading + 1;
  while (end < lines.length && (lines[end].trim() === "" || /^\s*[-*]\s*AC-[A-Za-z0-9_-]+\s*:/i.test(lines[end]))) end += 1;
  return [...lines.slice(0, heading), ...block, ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
}

export async function healSpecification({ task, readIssue, writeIssue, reviewer, repairer, ownerPause, maxSpecRepairs = 5, constraints = "" }) {
  let current = await readIssue(task.id);
  const attempts = [];
  for (let attempt = 0; attempt <= maxSpecRepairs; attempt += 1) {
    const currentTask = current.task ?? current;
    const oldDigest = currentTask.acceptanceCriteriaDigest ?? criteriaDigest(currentTask.acceptanceCriteria);
    const workPackage = { taskId: currentTask.id, title: currentTask.title, executionId: `spec-${currentTask.id}`, acceptanceCriteria: currentTask.acceptanceCriteria.map(({ id, description }) => ({ id, text: description })) };
    const review = await reviewer.reviewSpec(workPackage);
    if (review.verdict === "UNAVAILABLE") throw Object.assign(new Error("spec reviewer unavailable"), { code: "REVIEW_UNAVAILABLE", classification: "TRANSIENT", retryable: true });
    if (review.verdict === "CLEAN") return { task: currentTask, attempts };
    const evidence = { taskId: task.id, attempt, oldDigest, findings: review.findings, criteria: currentTask.acceptanceCriteria };
    if (attempt >= maxSpecRepairs) throw new SpecRepairExhaustedError(`spec repair limit exhausted for ${task.id}`, evidence);
    const repaired = await repairer({ task: currentTask, findings: review.findings, constraints, previousAttempts: attempts });
    if (repaired.kind === "NEEDS_OWNER") throw new SpecNeedsOwnerError(repaired.question, evidence);
    const newDigest = criteriaDigest(repaired.criteria);
    if (newDigest === oldDigest) throw new SpecRepairExhaustedError(`spec repair returned unchanged Acceptance Criteria for ${task.id}`, { ...evidence, proposedDigest: newDigest });
    const fresh = await readIssue(task.id);
    const freshTask = fresh.task ?? fresh;
    const freshDigest = freshTask.acceptanceCriteriaDigest ?? criteriaDigest(freshTask.acceptanceCriteria);
    if (freshDigest !== oldDigest) { current = fresh; continue; }
    const description = fresh.description ?? fresh.fields?.description ?? "";
    await writeIssue(task.id, replaceAcceptanceCriteria(description, repaired.criteria));
    const verified = await readIssue(task.id);
    const verifiedTask = verified.task ?? verified;
    const verifiedDigest = verifiedTask.acceptanceCriteriaDigest ?? criteriaDigest(verifiedTask.acceptanceCriteria);
    if (verifiedDigest !== newDigest) throw new Error(`Jira post-write Acceptance Criteria verification failed for ${task.id}`);
    attempts.push({ attempt: attempt + 1, oldDigest, newDigest, findings: review.findings });
    current = verified;
  }
  throw new SpecRepairExhaustedError(`spec repair limit exhausted for ${task.id}`, { taskId: task.id, attempts });
}
