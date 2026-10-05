import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { JiraTaskSystemAdapter, mapIssueToTask } from "/projects/souza-lab/src/adapters/jira-task-adapter.js";
import { JiraSyncClient } from "/projects/souza-lab/src/adapters/jira-sync-client.js";
import { SqliteExecutionAttemptStore } from "/projects/souza-lab/src/adapters/sqlite-execution-attempt-store.js";
import { SqliteGateFactStore } from "/projects/souza-lab/src/adapters/sqlite-gate-fact-store.js";
import { LocalExecutionLeaseProvider } from "/projects/souza-lab/src/adapters/local-execution-lease-provider.js";
import { ExecutionRunner } from "/projects/souza-lab/src/controller/execution-runner.js";
import { composeGitHubLifecycle } from "/projects/souza-lab/src/controller/production-composition.js";
import { createWorkPackageRuntime } from "/projects/souza-lab/src/controller/runtime-assembly.js";
import { WorkspaceCommandValidator } from "/projects/souza-lab/src/adapters/workspace-command-validator.js";

import { AxyHermesAgentExecutor } from "./axy-hermes-agent.mjs";
import { HermesIndependentReviewer } from "./hermes-reviewer.mjs";
import { HermesBridge } from "./hermes-util.mjs";
import { healSpecification, parseRepairOutput, SpecNeedsOwnerError, SpecRepairExhaustedError } from "./spec-healing.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, "config.json"), "utf8"));
const email = readFileSync("/opt/data/secrets/jira-email", "utf8").trim();
const apiToken = readFileSync("/opt/data/secrets/jira-token", "utf8").trim();
const stateDir = config.stateDir;
mkdirSync(stateDir, { recursive: true });
mkdirSync(join(stateDir, "executions"), { recursive: true });
mkdirSync(join(stateDir, "leases"), { recursive: true });

const log = (entry) => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function retryTransient(fn, { attempts = 4, baseMs = 1000 } = {}) {
  for (let n = 0; ; n += 1) {
    try { return await fn(); } catch (error) {
      if (!error?.retryable || n >= attempts - 1) throw error;
      await sleep(baseMs * (2 ** n));
      log({ event: "retry", attempt: n + 1, code: error.code ?? error.name ?? "ERROR" });
    }
  }
}

function git(args, cwd, options = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"], input: options.input }).trim();
}

function syncLocalMain() {
  const repo = config.repository.repoPath;
  const current = git(["branch", "--show-current"], repo);
  if (current !== config.repository.baseRef) throw new Error(`expected ${repo} on ${config.repository.baseRef}, found ${current}`);
  if (git(["status", "--porcelain=v1", "-uall"], repo) !== "") throw new Error(`cannot sync ${config.repository.baseRef}: main checkout is dirty`);
  git(["fetch", "origin", config.repository.baseRef], repo);
  git(["merge", "--ff-only", `origin/${config.repository.baseRef}`], repo);
}

function makeWorkPackage(task) {
  const digest = task.acceptanceCriteriaDigest;
  const short = digest.slice(0, 12);
  return Object.freeze({
    workPackageId: `wp-${task.id}-${short}`,
    executionId: `${task.id.toLowerCase()}-${short}`,
    taskId: task.id,
    title: task.title,
    acceptanceCriteria: Object.freeze(task.acceptanceCriteria.map(({ id, description }) => Object.freeze({ id, text: description }))),
    dependencies: Object.freeze(task.dependencies.map(({ taskId }) => taskId)),
    planBinding: Object.freeze({ documentId: `jira:${config.projectKey}`, planVersion: 1, contentHash: digest, taskHash: digest }),
    repository: Object.freeze({ identity: config.repository.identity, baseRef: config.repository.baseRef }),
  });
}

function safeTransition(jiraWrite, issueKey, desiredStatus, transitionName) {
  const before = jiraWrite.getIssueStatusName(issueKey);
  if (before === desiredStatus) return { changed: false, status: before };
  const response = jiraWrite.request(`issue/${encodeURIComponent(issueKey)}/transitions`);
  const transitions = Array.isArray(response?.transitions) ? response.transitions : [];
  const match = transitions.find((t) => t?.to?.name === desiredStatus) ?? transitions.find((t) => t?.name === transitionName);
  if (!match?.id) throw new Error(`${issueKey}: no transition to ${desiredStatus}`);
  jiraWrite.request(`issue/${encodeURIComponent(issueKey)}/transitions`, { method: "POST", body: { transition: { id: match.id } } });
  const after = jiraWrite.getIssueStatusName(issueKey);
  if (after !== desiredStatus) throw new Error(`${issueKey}: transition expected ${desiredStatus}, observed ${after}`);
  return { changed: true, status: after };
}

function ensureBootstrapCi(workPackage, attemptStore) {
  const attempt = attemptStore.get(workPackage.executionId);
  if (!attempt?.workspacePath || !existsSync(attempt.workspacePath)) return false;
  const workflow = join(attempt.workspacePath, config.github.workflowIdentity);
  if (existsSync(workflow)) return false;
  const dirty = git(["status", "--porcelain=v1", "-uall"], attempt.workspacePath);
  if (dirty !== "") throw new Error(`cannot bootstrap CI while ${attempt.workspacePath} is dirty`);
  mkdirSync(dirname(workflow), { recursive: true });
  writeFileSync(workflow, readFileSync(join(here, "validate.yml"), "utf8"), "utf8");
  git(["add", config.github.workflowIdentity], attempt.workspacePath);
  const message = [
    "ci: add baseline validation workflow",
    "",
    `Loop-Execution-Id: ${workPackage.executionId}`,
    `Loop-Task-Id: ${workPackage.taskId}`,
    "",
  ].join("\n");
  git(["-c", "user.name=AXYVERO Automation", "-c", "user.email=automation@axyvero.invalid", "commit", "-F", "-"], attempt.workspacePath, { input: message });
  if (git(["status", "--porcelain=v1", "-uall"], attempt.workspacePath) !== "") throw new Error("CI bootstrap left the workspace dirty");
  log({ event: "ci_bootstrap_committed", taskId: workPackage.taskId, head: git(["rev-parse", "HEAD"], attempt.workspacePath) });
  return true;
}

const jiraRead = new JiraTaskSystemAdapter({
  site: config.jira.site,
  email,
  apiToken,
  projectKey: config.projectKey,
  statusMapping: {
    [config.jira.todoStatus]: "OPEN",
    [config.jira.doingStatus]: "OPEN",
    [config.jira.doneStatus]: "DONE",
  },
  relationship: null,
});
const jiraWrite = new JiraSyncClient({ site: config.jira.site, email, apiToken });
const attemptStore = new SqliteExecutionAttemptStore({ path: join(stateDir, "execution-attempts.sqlite") });
const gateStore = new SqliteGateFactStore({ path: join(stateDir, "gate-facts.sqlite") });
const leaseProvider = new LocalExecutionLeaseProvider({ directory: join(stateDir, "leases"), defaultTtlMs: 120000 });
const agent = new AxyHermesAgentExecutor({
  command: config.hermes.command,
  board: config.hermes.board,
  coderAssignee: config.hermes.coderAssignee,
  pollMs: config.hermes.pollMs,
  maxPolls: config.hermes.maxPolls,
});
const reviewer = new HermesIndependentReviewer({
  command: config.hermes.command,
  board: config.hermes.board,
  reviewerAssignee: config.hermes.reviewerAssignee,
  repoPath: config.repository.repoPath,
  pollMs: config.hermes.pollMs,
  maxPolls: config.hermes.maxPolls,
});
const validator = new WorkspaceCommandValidator({ command: process.execPath, args: [join(here, "validate-workspace.mjs")], timeoutMs: 15 * 60 * 1000 });
const executionRunner = new ExecutionRunner({
  attemptStore,
  agent,
  repoPath: config.repository.repoPath,
  workspacesDir: config.repository.workspacesDir,
});
const lifecycle = composeGitHubLifecycle({
  github: {
    owner: config.repository.owner,
    repo: config.repository.repo,
    baseBranch: config.github.baseBranch,
    workflowIdentity: config.github.workflowIdentity,
    maxCorrections: config.github.maxCorrections,
  },
  repoPath: config.repository.repoPath,
  attemptStore,
  gateStore,
  reviewer,
  validator,
  agent,
});
const hermesBridge = new HermesBridge(config.hermes);

function readJiraTask(issueKey) {
  const issue = jiraWrite.request(`issue/${encodeURIComponent(issueKey)}?fields=summary,description,status,issuelinks`);
  const mapped = mapIssueToTask(issue, { projectKey: config.projectKey, site: config.jira.site, statusMapping: {
    [config.jira.todoStatus]: "OPEN", [config.jira.doingStatus]: "OPEN", [config.jira.doneStatus]: "DONE",
  }, relationship: null });
  return { task: mapped.task, description: typeof issue.fields?.description === "string" ? issue.fields.description : "" };
}

async function pauseForOwner(task, error) {
  const question = error.question ?? error.message;
  const body = [
    `Owner decision required for AXYVERO project ${config.projectKey}.`, `Jira issue: ${task.id}`,
    "Stage: SPEC_REPAIR", `Question: ${question}`, `Kanban task: ${process.env.HERMES_KANBAN_TASK ?? "owner-decision-card-created-below"}`,
    "Add the decision as a comment on this card, then unblock it with the normal Hermes Kanban flow.",
    `Evidence: ${JSON.stringify(error.evidence ?? {})}`,
  ].join("\n");
  const id = await hermesBridge.createTask({ title: `OWNER DECISION - ${task.id} - specification`, body, assignee: config.hermes.coderAssignee, workspacePath: config.repository.repoPath, idempotencyKey: `owner-decision-spec-${task.id}` });
  await hermesBridge.comment(id, body);
  await hermesBridge.block(id, `${body}\nKanban task: ${id}`, "needs_input");
  writeFileSync(join(stateDir, "owner-paused.json"), JSON.stringify({ taskId: task.id, decisionTaskId: id, stage: "SPEC_REPAIR", evidence: error.evidence ?? {}, updatedAt: new Date().toISOString() }, null, 2));
  log({ event: "owner_paused", taskId: task.id, decisionTaskId: id, stage: "SPEC_REPAIR" });
}

function ownerDecisionFrom(payload) {
  const comments = payload?.task?.comments ?? payload?.comments ?? payload?.task?.comment?.comments ?? [];
  return comments.map((comment) => comment?.body ?? comment?.text ?? comment?.content ?? "").filter(Boolean).reverse().find((text) => !String(text).includes("Owner decision required")) ?? null;
}

async function resumePausedOwner() {
  const path = join(stateDir, "owner-paused.json");
  if (!existsSync(path)) return null;
  const paused = JSON.parse(readFileSync(path, "utf8"));
  const payload = await hermesBridge.show(paused.decisionTaskId);
  const status = String(payload?.task?.status ?? payload?.status ?? "").toLowerCase();
  if (status === "blocked") return "PAUSED";
  const decision = ownerDecisionFrom(payload);
  if (!decision) { log({ event: "owner_decision_waiting", decisionTaskId: paused.decisionTaskId }); return "PAUSED"; }
  writeFileSync(join(stateDir, "executions", `${paused.taskId}-owner-decision.json`), JSON.stringify({ ...paused, decision, resumedAt: new Date().toISOString() }, null, 2));
  unlinkSync(path);
  log({ event: "owner_resumed", taskId: paused.taskId, decisionTaskId: paused.decisionTaskId });
  return { task: readJiraTask(paused.taskId), decision };
}

async function driveTask(task) {
  try {
    const healed = await healSpecification({
      task,
      readIssue: readJiraTask,
      writeIssue: async (issueKey, description) => jiraWrite.request(`issue/${encodeURIComponent(issueKey)}`, { method: "PUT", body: { fields: { description } } }),
      reviewer,
      repairer: async (input) => parseRepairOutput(await reviewer.repairSpec(input)),
      ownerPause: pauseForOwner,
      maxSpecRepairs: config.timings.maxSpecRepairs,
      constraints: `Repository: ${config.repository.identity}; base branch: ${config.repository.baseRef}; workflow: ${config.github.workflowIdentity}`,
      checkpoint: async (kind, evidence) => {
        const path = join(stateDir, "executions", `${task.id}-spec.json`);
        if (kind === "load") return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
        writeFileSync(path, JSON.stringify({ taskId: task.id, stage: kind === "repaired" ? "SPEC_REVIEW" : "SPEC_REPAIR", attempts: evidence?.attempts ?? [], evidence, updatedAt: new Date().toISOString() }, null, 2));
        return evidence;
      },
      retry: retryTransient,
    });
    task = healed.task;
  } catch (error) {
    if (error instanceof SpecNeedsOwnerError || error instanceof SpecRepairExhaustedError) { await pauseForOwner(task, error); return "PAUSED"; }
    if (error?.retryable) { log({ event: "retryable_task_failure", taskId: task.id, code: error.code ?? error.name }); return "RETRY"; }
    throw error;
  }
  const workPackage = makeWorkPackage(task);
  safeTransition(jiraWrite, task.id, config.jira.doingStatus, config.jira.doingTransition);
  log({ event: "task_started", taskId: task.id, executionId: workPackage.executionId });

  const scope = lifecycle.scope(workPackage);
  const { runtime } = createWorkPackageRuntime({
    workPackage,
    directory: join(stateDir, "executions"),
    scope,
    leaseProvider,
    ownerId: `axyvero-${process.pid}`,
    agentExecutor: agent,
    executionRunner,
    runtimeOptions: { timeoutMs: 62 * 60 * 1000, leaseTtlMs: 65 * 60 * 1000 },
  });

  for (let cycle = 1; cycle <= config.timings.maxRuntimeCyclesPerTask; cycle += 1) {
    ensureBootstrapCi(workPackage, attemptStore);
    const result = await runtime.runCycle({ executionId: workPackage.executionId, repository: workPackage.repository.identity });
    const state = result.nextComputed?.state ?? result.observation?.computed?.state ?? null;
    log({ event: "runtime_cycle", taskId: task.id, cycle, outcome: result.outcome, state });
    if (result.outcome === "DONE") {
      safeTransition(jiraWrite, task.id, config.jira.doneStatus, config.jira.doneTransition);
      log({ event: "task_done", taskId: task.id });
      return;
    }
    if (["BLOCKED_OWNER", "BLOCKED_EXTERNAL"].includes(result.outcome)) {
      throw new Error(`${task.id} blocked: ${state ?? result.outcome}`);
    }
    if (result.outcome === "WAIT_RETRYABLE") await sleep(config.timings.cycleWaitMs);
  }
  throw new Error(`${task.id} exceeded ${config.timings.maxRuntimeCyclesPerTask} runtime cycles`);
}

let exitCode = 0;
try {
  log({ event: "controller_start", projectKey: config.projectKey, repository: config.repository.identity });
  await hermesBridge.waitForExistingAxyWork();
  for (;;) {
    const resumed = await resumePausedOwner();
    if (resumed === "PAUSED") break;
    syncLocalMain();
    const tasks = jiraRead.listTasks();
    const selection = resumed?.task ? { reason: "ELIGIBLE_TASK_FOUND", taskId: resumed.task.task.id } : jiraRead.resolveNextTask();
    if (selection.reason !== "ELIGIBLE_TASK_FOUND") {
      const allDone = tasks.length > 0 && tasks.every((task) => task.completed);
      log({ event: allDone ? "project_complete" : "idle", reason: selection.reason, tasks: tasks.length });
      break;
    }
    const task = resumed?.task?.task ?? tasks.find((candidate) => candidate.id === selection.taskId);
    if (!task) throw new Error(`selected task ${selection.taskId} was not found`);
    const outcome = await driveTask(task);
    if (outcome === "PAUSED") break;
    if (outcome === "RETRY") { await sleep(config.timings.cycleWaitMs); continue; }
  }
} catch (error) {
  exitCode = 1;
  log({ event: "fatal", code: error?.code ?? error?.name ?? "ERROR", message: String(error?.message ?? error).slice(0, 800) });
} finally {
  try { attemptStore.close(); } catch {}
  try { gateStore.close(); } catch {}
}
process.exit(exitCode);
