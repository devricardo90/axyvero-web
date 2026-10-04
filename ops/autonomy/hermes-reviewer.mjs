import { HermesBridge, HermesBridgeError } from "./hermes-util.mjs";

function findingsFrom(metadata, summary) {
  const source = Array.isArray(metadata?.findings) ? metadata.findings : [];
  if (source.length > 0) {
    return source.map((item, index) => ({
      id: `R-${index + 1}`,
      summary: typeof item === "string" ? item : String(item?.summary ?? item?.message ?? JSON.stringify(item)),
    }));
  }
  if (typeof summary === "string" && /VERDICT:\s*FINDINGS/i.test(summary)) {
    const lines = summary.split("\n").filter((line) => /^-\s+/.test(line.trim()));
    return lines.map((line, index) => ({ id: `R-${index + 1}`, summary: line.replace(/^\s*-\s*/, "").trim() }));
  }
  return [];
}

function verdictFrom(payload) {
  const run = Array.isArray(payload?.runs) ? payload.runs.at(-1) : null;
  const metadata = run?.metadata ?? {};
  const summary = run?.summary ?? payload?.latest_summary ?? payload?.task?.result ?? "";
  const verdict = String(metadata?.verdict ?? (/VERDICT:\s*(CLEAN|FINDINGS|UNAVAILABLE)/i.exec(summary)?.[1] ?? "")).toUpperCase();
  return { verdict, metadata, summary };
}

export class HermesIndependentReviewer {
  constructor({ command = "hermes", board = "workflow-prod", reviewerAssignee = "reviewer", repoPath, pollMs = 2000, maxPolls = 1800 } = {}) {
    if (!repoPath) throw new TypeError("HermesIndependentReviewer requires repoPath");
    this.reviewerAssignee = reviewerAssignee;
    this.repoPath = repoPath;
    this.bridge = new HermesBridge({ command, board, pollMs, maxPolls });
  }

  async reviewSpec(workPackage) {
    const criteria = workPackage.acceptanceCriteria.map(({ id, text }) => `- ${id}: ${text}`).join("\n");
    const body = [
      `Review the frozen Jira specification for ${workPackage.taskId}.`,
      `Title: ${workPackage.title}`,
      "",
      "Acceptance Criteria:",
      criteria,
      "",
      "Judge only whether the specification is internally coherent, testable, scoped, and safe to implement autonomously.",
      "Do not modify files, create commits, push, or merge.",
      "Return exactly one verdict: CLEAN, FINDINGS, or UNAVAILABLE.",
    ].join("\n");
    try {
      const id = await this.bridge.createTask({
        title: `SPEC REVIEW - ${workPackage.taskId}`,
        body,
        assignee: this.reviewerAssignee,
        workspacePath: this.repoPath,
        idempotencyKey: `loop-${workPackage.executionId}-spec-review`,
      });
      const payload = await this.bridge.poll(id);
      return this.toOutput(payload, null);
    } catch (error) {
      if (error instanceof HermesBridgeError && error.retryable) return { verdict: "UNAVAILABLE", findings: [], reviewerId: "hermes-reviewer" };
      throw error;
    }
  }

  async reviewImplementation({ workPackage, head, base, workspacePath, authorId, changedFiles }) {
    const criteria = workPackage.acceptanceCriteria.map(({ id, text }) => `- ${id}: ${text}`).join("\n");
    const body = [
      `Independent implementation review for ${workPackage.taskId}.`,
      `Title: ${workPackage.title}`,
      `Target SHA: ${head}`,
      `Baseline: ${base}`,
      `Implementation author: ${authorId ?? "unknown"}`,
      `Workspace: ${workspacePath}`,
      "",
      "Acceptance Criteria:",
      criteria,
      "",
      "Changed files:",
      ...(changedFiles.length ? changedFiles.map((f) => `- ${f}`) : ["- (none)"]),
      "",
      "Do not modify tracked files. Do not create commits. Do not push. Do not merge.",
      "Verify HEAD is exactly the target SHA and the working tree is clean before and after review.",
      "Run npm ci, npm run lint, npm run build, npm audit --omit=dev --audit-level=high when package.json is present.",
      "Review correctness, security, maintainability, scope, and every acceptance criterion.",
      "Return VERDICT: CLEAN or VERDICT: FINDINGS and concrete findings.",
    ].join("\n");
    try {
      const id = await this.bridge.createTask({
        title: `REVIEW - ${workPackage.taskId} - ${head.slice(0, 8)}`,
        body,
        assignee: this.reviewerAssignee,
        workspacePath,
        idempotencyKey: `loop-${workPackage.executionId}-review-${head}`,
      });
      const payload = await this.bridge.poll(id);
      return this.toOutput(payload, head);
    } catch (error) {
      if (error instanceof HermesBridgeError && error.retryable) return { verdict: "UNAVAILABLE", findings: [], reviewerId: "hermes-reviewer" };
      throw error;
    }
  }

  toOutput(payload, expectedHead) {
    const { verdict, metadata, summary } = verdictFrom(payload);
    if (!["CLEAN", "FINDINGS", "UNAVAILABLE"].includes(verdict)) throw new Error(`Hermes reviewer returned unsupported verdict ${verdict || "(empty)"}`);
    if (expectedHead) {
      const target = metadata?.target_sha ?? (/TARGET_SHA:\s*([0-9a-f]{40})/i.exec(summary)?.[1] ?? null);
      if (target !== expectedHead) throw new Error(`Hermes reviewer target ${target ?? "missing"} does not match ${expectedHead}`);
    }
    const findings = findingsFrom(metadata, summary);
    if (verdict === "FINDINGS" && findings.length === 0) throw new Error("Hermes reviewer returned FINDINGS without findings");
    return { verdict, findings: verdict === "CLEAN" ? [] : findings, reviewerId: "hermes-reviewer" };
  }
}
