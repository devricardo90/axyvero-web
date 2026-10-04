import { execFile } from "node:child_process";
import { open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const NON_TERMINAL = new Set(["triage", "todo", "scheduled", "ready", "running", "review"]);

export class HermesBridgeError extends Error {
  constructor(message, { code = "HERMES_BRIDGE_ERROR", classification = "EXTERNAL_BLOCK", retryable = false } = {}) {
    super(message);
    this.name = "HermesBridgeError";
    Object.assign(this, { code, classification, retryable });
  }
}

function parseJson(raw, label) {
  try { return JSON.parse(String(raw)); }
  catch { throw new HermesBridgeError(`Hermes ${label} returned malformed JSON`, { code: "HERMES_MALFORMED_OUTPUT" }); }
}

function taskStatus(payload) {
  const value = payload?.task?.status ?? payload?.status;
  return typeof value === "string" ? value.toLowerCase() : null;
}

function listRow(line) {
  const match = String(line).match(/^[^A-Za-z0-9]*\s*(t_[A-Za-z0-9]+)\s+(triage|todo|scheduled|ready|running|review|blocked|done)\s+/i);
  return match ? { id: match[1], status: match[2].toLowerCase(), line: String(line).trim() } : null;
}

export class HermesBridge {
  constructor({ command = "hermes", board = "workflow-prod", pollMs = 2000, maxPolls = 1800 } = {}) {
    Object.assign(this, { command, board, pollMs, maxPolls });
  }

  async invoke(args, label = "command") {
    try {
      return await execFileAsync(this.command, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    } catch (cause) {
      throw new HermesBridgeError(`Hermes ${label} failed: ${String(cause?.message ?? cause).slice(0, 300)}`, {
        code: cause?.code === "ENOENT" ? "HERMES_UNAVAILABLE" : "HERMES_COMMAND_FAILED",
        classification: "EXTERNAL_BLOCK",
        retryable: true,
      });
    }
  }

  async createTask({ title, body, assignee, workspacePath, idempotencyKey, maxRuntime = "45m" }) {
    const path = join(tmpdir(), `axy-hermes-${process.pid}-${randomBytes(16).toString("hex")}.txt`);
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(body, "utf8");
      const args = [
        "kanban", "--board", this.board, "create", title,
        "--assignee", assignee,
        "--workspace", `dir:${workspacePath}`,
        "--max-runtime", maxRuntime,
        "--idempotency-key", idempotencyKey,
        "--body-file", path,
        "--json",
      ];
      const result = await this.invoke(args, "create");
      const payload = parseJson(result.stdout ?? result, "create");
      const id = payload?.task?.id ?? payload?.id;
      if (typeof id !== "string" || id === "") throw new HermesBridgeError("Hermes create returned no task id", { code: "HERMES_INVALID_CREATE" });
      return id;
    } finally {
      await handle.close().catch(() => {});
      await unlink(path).catch(() => {});
    }
  }

  async show(taskId) {
    const result = await this.invoke(["kanban", "--board", this.board, "show", taskId, "--json"], "show");
    return parseJson(result.stdout ?? result, "show");
  }

  async poll(taskId) {
    for (let attempt = 0; attempt < this.maxPolls; attempt += 1) {
      const payload = await this.show(taskId);
      const status = taskStatus(payload);
      if (status === "done") return payload;
      if (status === "blocked") throw new HermesBridgeError(`Hermes task ${taskId} is blocked`, { code: "HERMES_BLOCKED", classification: "TASK_FAILURE" });
      if (!NON_TERMINAL.has(status)) throw new HermesBridgeError(`Hermes task ${taskId} has unknown status ${status}`, { code: "HERMES_UNKNOWN_STATUS", classification: "TASK_FAILURE" });
      if (attempt + 1 < this.maxPolls && this.pollMs > 0) await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
    throw new HermesBridgeError(`Hermes task ${taskId} did not reach a terminal state`, { code: "HERMES_POLL_TIMEOUT", retryable: true });
  }

  async waitForExistingAxyWork() {
    for (;;) {
      const result = await this.invoke(["kanban", "--board", this.board, "list"], "list");
      const rows = String(result.stdout ?? result).split("\n").map(listRow).filter(Boolean);
      const active = rows.filter((row) => NON_TERMINAL.has(row.status) && /\bAXY-\d+\b/i.test(row.line));
      if (active.length === 0) return;
      process.stdout.write(`${JSON.stringify({ event: "waiting_existing_hermes", active: active.map((row) => row.line) })}\n`);
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }
}
