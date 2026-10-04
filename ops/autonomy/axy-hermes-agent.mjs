import { execFileSync } from "node:child_process";
import { HermesAgentExecutor } from "/projects/souza-lab/src/adapters/hermes-agent-executor.js";
import { classifyExecution, inspectWorkspace, resultFromGit } from "/projects/souza-lab/src/adapters/git-workspace.js";
import { validateAgentResult } from "/projects/souza-lab/src/controller/ports.js";
import { HermesBridge } from "./hermes-util.mjs";

export class AxyHermesAgentExecutor extends HermesAgentExecutor {
  constructor(options = {}) {
    super(options);
    this.correctionBridge = new HermesBridge({ command: this.command, board: this.board, pollMs: this.pollMs, maxPolls: this.maxPolls });
  }

  async correct(workPackage, { workspace, findings, round = 1 }) {
    const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.path, encoding: "utf8" }).trim();
    const findingLines = (findings ?? []).map((finding) => `- ${finding.id ?? "finding"}: ${finding.summary ?? finding}`).join("\n");
    const body = [
      `Correction round ${round} for ${workPackage.taskId}.`,
      `Execution id: ${workPackage.executionId}`,
      `Current HEAD: ${before}`,
      `Workspace: ${workspace.path}`,
      "",
      "Independent reviewer findings:",
      findingLines || "- No structured findings were supplied.",
      "",
      "Fix only the findings and preserve all already-satisfied acceptance criteria.",
      "Run the relevant repository checks before committing.",
      "Do not push. Do not merge. Do not reset, clean, or discard existing work.",
      "Create one real Git commit on the existing branch.",
      "The correction commit MUST contain these exact trailers:",
      `Loop-Execution-Id: ${workPackage.executionId}`,
      `Loop-Task-Id: ${workPackage.taskId}`,
    ].join("\n");

    const taskId = await this.correctionBridge.createTask({
      title: `FIX - ${workPackage.taskId} - round ${round}`,
      body,
      assignee: this.coderAssignee,
      workspacePath: workspace.path,
      idempotencyKey: `loop-${workPackage.executionId}-correct-${round}-${before}`,
    });
    await this.correctionBridge.poll(taskId);

    const facts = inspectWorkspace({
      workspacePath: workspace.path,
      baseSha: workspace.baseSha,
      branch: workspace.branch,
      executionId: workPackage.executionId,
      taskId: workPackage.taskId,
    });
    const { classification } = classifyExecution(facts, { executionId: workPackage.executionId, taskId: workPackage.taskId });
    if (classification !== "COMMITTED_IMPLEMENTATION_PRESENT") throw new Error(`Hermes correction ended in ${classification}`);
    if (facts.head === before) throw new Error("Hermes correction did not create a new commit");
    return validateAgentResult(resultFromGit(facts));
  }
}
