import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionInfo {
  id: string;
  modified: Date;
  /** First real prompt the user typed, as a label. */
  firstPrompt: string;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEAD_BYTES = 256 * 1024;

/**
 * Where Claude Code keeps transcripts for a project: ~/.claude/projects/<cwd with every
 * non-alphanumeric character replaced by "-">/<session-id>.jsonl. This layout is not a
 * documented API, so everything here is best-effort and callers fall back to `--continue`.
 */
export function sessionsDir(cwd: string): string {
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(base, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

function readHead(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function firstPromptOf(path: string): string {
  for (const line of readHead(path).split("\n")) {
    if (!line.includes('"type":"user"')) continue;
    try {
      const m = JSON.parse(line);
      if (m.type !== "user" || m.isMeta) continue;
      const c = m.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.find((p: any) => p.type === "text")?.text : undefined;
      // Skip slash-command wrappers and other harness-injected messages.
      if (typeof text === "string" && text.trim() && !text.trimStart().startsWith("<")) {
        return text.replace(/\s+/g, " ").trim();
      }
    } catch {
      // A line cut off at HEAD_BYTES; ignore.
    }
  }
  return "(no prompt yet)";
}

/** Sessions for a project, most recently active first. */
export function listSessions(cwd: string): SessionInfo[] {
  const dir = sessionsDir(cwd);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith(".jsonl") && ID.test(f.slice(0, -6)))
    .map((f) => {
      const path = join(dir, f);
      return { id: f.slice(0, -6), modified: statSync(path).mtime, firstPrompt: firstPromptOf(path) };
    })
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export function describeSession(s: SessionInfo, width = 70): string {
  const label = s.firstPrompt.length > width ? s.firstPrompt.slice(0, width - 1) + "…" : s.firstPrompt;
  return `${s.id.slice(0, 8)}  ${s.modified.toLocaleString()}  ${label}`;
}
