import { spawn } from "node:child_process";
import * as path from "node:path";
import { truncate } from "../text.js";
import {
  type Tool,
  ToolError,
  optionalNumber,
  requireString,
  requireStringArray,
  text,
} from "./types.js";

/**
 * Shell execution, jailed to the workspace.
 *
 * The rules that make this survivable, none of which are optional:
 *  - `shell: false` and a real argv array. There is no string that gets
 *    interpolated into `sh -c`, so quoting bugs cannot become injection.
 *  - The command must be a bare binary name on the allowlist. A path — even
 *    `./configure` — is refused, because the allowlist is meaningless if the
 *    model can name an arbitrary file.
 *  - `cwd` is the workspace root and the environment is rebuilt from scratch,
 *    so the child does not inherit tokens from the user's shell.
 */
const execRun: Tool = {
  descriptor: {
    name: "exec_run",
    description:
      "Run an allowlisted binary in the workspace root. Requires human approval. " +
      "There is no shell: pass the program and its arguments separately, and " +
      "pipes, redirection and globs are not interpreted.",
    risk: "exec",
    server: null,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Binary name, e.g. 'git'. No paths." },
        args: { type: "array", items: { type: "string" }, description: "Arguments, one per element." },
        timeout_ms: { type: "number", description: "Kill the process after this long." },
      },
      required: ["command", "args"],
      additionalProperties: false,
    },
  },
  summarize(args) {
    const argv = Array.isArray(args.args) ? (args.args as unknown[]).map(String) : [];
    return `Run ${String(args.command)} ${argv.join(" ")}`.trim();
  },
  validate(args, ctx) {
    checkExecArgs(args, ctx.config.exec.allow);
  },
  async run(args, ctx) {
    const { allow, timeoutMs, maxOutputBytes } = ctx.config.exec;
    // Re-checked here as well: `run` must not depend on a caller having gone
    // through `validate` first.
    const { command, argv } = checkExecArgs(args, allow);

    const limit = Math.min(optionalNumber(args, "timeout_ms") ?? timeoutMs, timeoutMs);

    const child = spawn(command, argv, {
      cwd: ctx.workspace.root,
      shell: false,
      env: minimalEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group, so a timeout kills the whole tree and not just the
      // parent that spawned it.
      detached: process.platform !== "win32",
    });

    // Hard memory cap, well above the paste budget so the final truncation
    // still has a useful prefix to work with. A process that blows through it
    // is killed — but whatever it already printed is kept, because "the output
    // was too long" is far less useful than the first page of it.
    const hardCap = maxOutputBytes * 4;
    const chunks: { stream: "out" | "err"; data: Buffer }[] = [];
    let bytes = 0;
    let capped = false;
    const collect = (stream: "out" | "err") => (data: Buffer) => {
      if (capped) return;
      const room = hardCap - bytes;
      if (data.length >= room) {
        if (room > 0) chunks.push({ stream, data: data.subarray(0, room) });
        chunks.push({
          stream,
          data: Buffer.from("\n[webmcp: output limit reached, killing process]\n"),
        });
        bytes = hardCap;
        capped = true;
        kill(child, "SIGKILL");
        return;
      }
      bytes += data.length;
      chunks.push({ stream, data });
    };
    child.stdout.on("data", collect("out"));
    child.stderr.on("data", collect("err"));

    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; note?: string }>(
      (resolve) => {
        let settled = false;
        const finish = (v: { code: number | null; signal: NodeJS.Signals | null; note?: string }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ctx.signal.removeEventListener("abort", onAbort);
          resolve(v);
        };

        const timer = setTimeout(() => {
          kill(child, "SIGKILL");
          finish({ code: null, signal: "SIGKILL", note: `timed out after ${limit}ms` });
        }, limit);

        const onAbort = () => {
          kill(child, "SIGKILL");
          finish({ code: null, signal: "SIGKILL", note: "cancelled" });
        };
        ctx.signal.addEventListener("abort", onAbort, { once: true });

        child.on("error", (err) => finish({ code: null, signal: null, note: err.message }));
        child.on("close", (code, signal) => finish({ code, signal }));
      },
    );

    const stdout = join(chunks, "out");
    const stderr = join(chunks, "err");
    const status =
      outcome.note ??
      (outcome.signal ? `killed by ${outcome.signal}` : `exit ${outcome.code ?? "unknown"}`);

    const body = [
      `$ ${command} ${argv.join(" ")}`.trim(),
      `[${status}]`,
      stdout && `--- stdout ---\n${stdout}`,
      stderr && `--- stderr ---\n${stderr}`,
    ]
      .filter(Boolean)
      .join("\n");

    const cut = truncate(body, maxOutputBytes);
    const result = text(cut.text, { truncated: cut.truncated, originalBytes: cut.originalBytes });
    result.isError = outcome.code !== 0;
    return result;
  },
};

/**
 * The whole allowlist decision, in one place so `validate` and `run` cannot
 * drift apart.
 */
function checkExecArgs(
  args: Record<string, unknown>,
  allow: string[],
): { command: string; argv: string[] } {
  const command = requireString(args, "command");
  const argv = requireStringArray(args, "args");

  if (allow.length === 0) {
    throw new ToolError("exec is disabled: the allowlist is empty", "denied");
  }
  if (command !== path.basename(command) || command.includes(path.sep) || command.includes("/")) {
    throw new ToolError(
      `"command" must be a bare binary name, got ${JSON.stringify(command)}`,
      "denied",
    );
  }
  if (!allow.includes(command)) {
    throw new ToolError(`"${command}" is not on the exec allowlist (${allow.join(", ")})`, "denied");
  }
  if (argv.some((a) => a.includes("\0"))) {
    throw new ToolError("arguments must not contain null bytes");
  }
  return { command, argv };
}

function join(chunks: { stream: "out" | "err"; data: Buffer }[], stream: "out" | "err"): string {
  return Buffer.concat(chunks.filter((c) => c.stream === stream).map((c) => c.data)).toString("utf8");
}

function kill(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    // Negative pid targets the group created by `detached`.
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
}

/**
 * A deliberately bare environment. Inheriting `process.env` would hand a
 * prompt-injected `git push` the user's credential helper and every API key in
 * their shell profile.
 */
function minimalEnv(): Record<string, string> {
  const keep = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "SHELL", "USER"];
  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.WEBMCP = "1";
  return env;
}

export const execTools: Tool[] = [execRun];
