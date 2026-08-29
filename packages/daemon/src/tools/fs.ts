import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { JailViolation } from "../jail.js";
import { sliceBytes, truncate } from "../text.js";
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

    const maxBytes = ctx.maxResultBytes;
    const { handle, path: jailed, size } = await ctx.workspace.openRead(requested);
    try {
      const range = await readLineRange(handle, size, offset, limit, maxBytes);

      // Going up as a file rather than into the message, so hand back the file
      // and nothing else. The path and the size are already in the covering
      // message and in the attachment's own name; repeating them as a first
      // line *inside* the file is corruption — a CSV gains a bogus row, a JSON
      // file stops parsing — and it is the reason attachments used to be
      // renamed to `.md` rather than keeping the name they were read under.
      if (ctx.canAttach && size > ctx.config.limits.maxReadBytes) {
        return text(range.text, { truncated: range.more, originalBytes: size });
      }

      const header = `${jailed.display} (${size} bytes)\n`;

      // Asking past the end is a real answer, not an empty one. Returning a bare
      // header reads as "the file is empty here", which is what sent a model
      // round in circles paging a file it had already finished.
      if (range.lines === 0) {
        const detail =
          range.totalLines === null
            ? `no lines from offset ${offset}`
            : `offset ${offset} is past the end — ${jailed.display} has ${range.totalLines} lines`;
        return text(`${header}[webmcp: ${detail}]`, { truncated: false, originalBytes: size });
      }

      // The footer names where to resume, because "truncated" without a next
      // offset leaves the model to guess one. The old notice reported the
      // internal read cap as the denominator, which understated a 271KB file as
      // 4096 bytes and read as "you have half of it".
      const last = offset + range.lines - 1;
      // A line longer than the whole budget gets a different note, because the
      // usual one would be a lie: `offset: last + 1` resumes at the *next* line
      // and the rest of this one is not reachable that way at all.
      const footer = range.cutLine
        ? `\n[webmcp: line ${last} of ${jailed.display} is longer than the ${maxBytes}-byte` +
          ` result budget and was cut. Paging with offset cannot recover the rest of it]`
        : range.more
          ? `\n[webmcp: showed lines ${offset}-${last} of ${jailed.display} (${size} bytes).` +
            ` Continue with {"path": "${requested}", "offset": ${last + 1}}]`
          : "";

      return text(header + range.text + footer, {
        truncated: range.more,
        originalBytes: size,
      });
    } finally {
      await handle.close();
    }
  },
};

/**
 * Read a range of lines without holding the file in memory.
 *
 * The previous implementation read the first `2 * maxReadBytes` from byte zero
 * and *then* sliced lines out of that buffer, so any line past the cap was
 * unreachable by any offset — while the tool description told the model to page
 * through long files with exactly that argument. On a 271KB file with a 4KB cap,
 * `offset: 100` came back empty with no explanation.
 *
 * So the scan walks forward chunk by chunk, counting lines, and stops as soon as
 * it has what was asked for. `StringDecoder` carries partial UTF-8 sequences
 * across chunk boundaries — splitting a buffer mid-code-point and decoding each
 * half independently is how a scan like this corrupts non-ASCII text.
 */
const SCAN_CHUNK = 64 * 1024;

async function readLineRange(
  handle: fsp.FileHandle,
  size: number,
  startLine: number,
  limit: number | undefined,
  maxBytes: number,
): Promise<{
  text: string;
  lines: number;
  more: boolean;
  /** The first line was itself over budget and had to be cut mid-line. */
  cutLine: boolean;
  totalLines: number | null;
}> {
  const decoder = new StringDecoder("utf8");
  const out: string[] = [];
  let pos = 0;
  let line = 1;
  let carry = "";
  let outBytes = 0;
  let more = false;
  let cutLine = false;
  let done = false;

  /** Returns true when the caller should stop scanning. */
  const take = (lineText: string): boolean => {
    if (line < startLine) return false;
    if (limit !== undefined && out.length >= limit) {
      more = true;
      return true;
    }
    const bytes = Buffer.byteLength(lineText, "utf8");
    // Always emit something, even for a pathologically long line, so a file of
    // one huge line is not silently unreadable — but emit it *cut to budget*.
    //
    // This used to push the whole line on the reasoning that one line is the
    // minimum useful answer. It meant the budget did not apply to it at all: a
    // 271KB minified file is a single line, so `maxReadBytes` was ignored and
    // the entire thing was pasted into the composer. That is the case this cap
    // exists for, and it was the one case that escaped it.
    if (out.length === 0 && bytes > maxBytes) {
      out.push(sliceBytes(lineText, maxBytes));
      outBytes += maxBytes;
      more = true;
      cutLine = true;
      return true;
    }
    if (out.length > 0 && outBytes + bytes > maxBytes) {
      more = true;
      return true;
    }
    out.push(lineText);
    outBytes += bytes;
    // The budget is checked before the push, so having pushed we always go on.
    return false;
  };

  while (pos < size && !done) {
    const buf = Buffer.alloc(Math.min(SCAN_CHUNK, size - pos));
    const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
    if (bytesRead === 0) break;
    pos += bytesRead;
    carry += decoder.write(buf.subarray(0, bytesRead));

    for (;;) {
      const nl = carry.indexOf("\n");
      if (nl === -1) break;
      const lineText = carry.slice(0, nl + 1);
      carry = carry.slice(nl + 1);
      if (take(lineText)) {
        done = true;
        break;
      }
      line++;
    }
  }

  // A file whose last line has no trailing newline.
  carry += decoder.end();
  const reachedEof = pos >= size;
  if (!done && carry.length > 0) {
    if (!take(carry)) line++;
  }

  return {
    text: out.join(""),
    lines: out.length,
    // More remains if the scan stopped early, or if it stopped at EOF mid-file.
    more: more || (!reachedEof && out.length > 0),
    cutLine,
    totalLines: reachedEof && !done ? line - 1 : null,
  };
}

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
    const cut = truncate(body, ctx.maxResultBytes);
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
