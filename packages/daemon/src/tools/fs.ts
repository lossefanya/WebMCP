import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { JailViolation } from "../jail.js";
import { truncate, truncateLines } from "../text.js";
import {
  type Tool,
  type ToolContext,
  ToolError,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  text,
} from "./types.js";

const fsRead: Tool = {
  descriptor: {
    name: "fs_read",
    description:
      "Read a UTF-8 text file from the workspace. Paths are relative to the workspace root. " +
      "Long files are truncated; use offset/limit to page through them.",
    risk: "read",
    server: null,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        offset: { type: "number", description: "First line to return, 1-based. Default 1." },
        limit: { type: "number", description: "Maximum number of lines to return." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  summarize: (args) => `Read ${String(args.path)}`,
  async run(args, ctx) {
    const requested = requireString(args, "path");
    const offset = optionalNumber(args, "offset") ?? 1;
    const limit = optionalNumber(args, "limit");
    if (offset < 1) throw new ToolError(`"offset" is 1-based, got ${offset}`);

    const { handle, path: jailed, size } = await ctx.workspace.openRead(requested);
    try {
      // Read at most twice the paste budget: enough to slice lines from, small
      // enough that a huge file never lands in memory.
      const cap = ctx.config.limits.maxReadBytes * 2;
      const buf = Buffer.alloc(Math.min(size, cap));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      let body = buf.subarray(0, bytesRead).toString("utf8");

      if (offset > 1 || limit !== undefined) {
        const lines = body.split("\n");
        const start = offset - 1;
        body = lines.slice(start, limit === undefined ? undefined : start + limit).join("\n");
      }

      const cut = truncateLines(body, ctx.config.limits.maxReadBytes);
      const header = `${jailed.display} (${size} bytes)\n`;
      return text(header + cut.text, { truncated: cut.truncated, originalBytes: size });
    } finally {
      await handle.close();
    }
  },
};

const fsWrite: Tool = {
  descriptor: {
    name: "fs_write",
    description:
      "Write a UTF-8 text file in the workspace. Requires human approval. " +
      "Creates parent directories only if create_dirs is true.",
    risk: "write",
    server: null,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        content: { type: "string", description: "Full new contents of the file." },
        mode: {
          type: "string",
          enum: ["overwrite", "append", "create_new"],
          description: "Default overwrite.",
        },
        create_dirs: { type: "boolean", description: "Create missing parent directories." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  summarize(args) {
    const bytes = Buffer.byteLength(String(args.content ?? ""), "utf8");
    const mode = String(args.mode ?? "overwrite");
    return `${mode === "append" ? "Append to" : "Write"} ${String(args.path)} (${bytes} bytes)`;
  },
  validate(args, ctx) {
    checkWriteArgs(args, ctx.config.limits.maxWriteBytes);
  },
  async run(args, ctx) {
    const { requested, content, mode, bytes } = checkWriteArgs(
      args,
      ctx.config.limits.maxWriteBytes,
    );

    if (optionalBoolean(args, "create_dirs")) {
      // Resolve the parent through the jail before creating anything.
      const parent = await ctx.workspace.resolveForCreate(path.posix.dirname(toPosix(requested)));
      await fsp.mkdir(parent.real, { recursive: true });
    }

    const { handle, path: jailed, created } = await ctx.workspace.openWrite(requested, mode);
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
    return text(
      `${created ? "Created" : mode === "append" ? "Appended to" : "Overwrote"} ${jailed.display} (${bytes} bytes)`,
    );
  },
};

const fsList: Tool = {
  descriptor: {
    name: "fs_list",
    description: "List the entries of a directory in the workspace.",
    risk: "read",
    server: null,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory relative to the workspace root. Default '.'." },
        recursive: { type: "boolean", description: "Walk subdirectories. Default false." },
      },
      additionalProperties: false,
    },
  },
  summarize: (args) => `List ${String(args.path ?? ".")}`,
  async run(args, ctx) {
    const requested = optionalString(args, "path") ?? ".";
    const recursive = optionalBoolean(args, "recursive") ?? false;
    const jailed = await ctx.workspace.resolveExisting(requested);
    const st = await fsp.stat(jailed.real);
    if (!st.isDirectory()) throw new ToolError(`not a directory: ${jailed.display}`);

    const max = ctx.config.limits.maxListEntries;
    const rows: string[] = [];
    let hitLimit = false;

    const walk = async (dir: string, prefix: string): Promise<void> => {
      if (rows.length >= max) {
        hitLimit = true;
        return;
      }
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (rows.length >= max) {
          hitLimit = true;
          return;
        }
        if (entry.name === "node_modules" || entry.name === ".git") {
          rows.push(`${prefix}${entry.name}/  (skipped)`);
          continue;
        }
        const rel = `${prefix}${entry.name}`;
        if (entry.isDirectory()) {
          rows.push(`${rel}/`);
          if (recursive) await walk(path.join(dir, entry.name), `${rel}/`);
        } else if (entry.isSymbolicLink()) {
          // Listed but flagged: reading it will be re-checked against the jail.
          rows.push(`${rel}  -> symlink`);
        } else {
          const size = await fsp
            .stat(path.join(dir, entry.name))
            .then((s) => s.size)
            .catch(() => 0);
          rows.push(`${rel}  ${size}`);
        }
      }
    };

    await walk(jailed.real, "");
    const body = `${jailed.display}/\n${rows.join("\n")}${hitLimit ? `\n[webmcp: stopped at ${max} entries]` : ""}`;
    const cut = truncate(body, ctx.config.limits.maxReadBytes);
    return text(cut.text, { truncated: cut.truncated, originalBytes: cut.originalBytes });
  },
};

const fsStat: Tool = {
  descriptor: {
    name: "fs_stat",
    description: "Report whether a workspace path exists, and its type and size.",
    risk: "read",
    server: null,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  summarize: (args) => `Stat ${String(args.path)}`,
  async run(args, ctx) {
    const requested = requireString(args, "path");
    try {
      const jailed = await ctx.workspace.resolveExisting(requested);
      const st = await fsp.stat(jailed.real);
      const kind = st.isDirectory() ? "directory" : st.isFile() ? "file" : "other";
      return text(`${jailed.display}: ${kind}, ${st.size} bytes, modified ${st.mtime.toISOString()}`);
    } catch (err) {
      if (err instanceof JailViolation) throw err;
      throw new ToolError(`cannot stat ${requested}`);
    }
  },
};

/** Shared by `validate` and `run` so the two cannot disagree. */
function checkWriteArgs(
  args: Record<string, unknown>,
  maxWriteBytes: number,
): { requested: string; content: string; mode: WriteMode; bytes: number } {
  const requested = requireString(args, "path");
  const content = args.content;
  if (typeof content !== "string") throw new ToolError('argument "content" must be a string');

  const mode = (optionalString(args, "mode") ?? "overwrite") as WriteMode;
  if (mode !== "overwrite" && mode !== "append" && mode !== "create_new") {
    throw new ToolError(`unknown mode "${String(args.mode)}"`);
  }

  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxWriteBytes) {
    throw new ToolError(`content is ${bytes} bytes, limit is ${maxWriteBytes}`);
  }
  return { requested, content, mode, bytes };
}

type WriteMode = "overwrite" | "append" | "create_new";

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

export const fsTools: Tool[] = [fsRead, fsWrite, fsList, fsStat];
