import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSessions, sessionsDir } from "../src/sessions.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "cs-sessions-"));
  process.env.CLAUDE_CONFIG_DIR = base;
});
afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
});

const line = (o: object) => JSON.stringify(o) + "\n";

describe("sessions", () => {
  it("encodes the project path like Claude Code does", () => {
    expect(sessionsDir("/Users/me/my.app_v2")).toBe(join(base, "projects", "-Users-me-my-app-v2"));
  });

  it("lists sessions newest first with their first real prompt", () => {
    const dir = sessionsDir("/work/proj");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${A}.jsonl`),
      line({ type: "permission-mode" }) +
        line({ type: "user", isMeta: true, message: { content: "meta" } }) +
        line({ type: "user", message: { content: "<command-name>/clear</command-name>" } }) +
        line({ type: "user", message: { content: "Build the   scraper\nfast" } }),
    );
    writeFileSync(join(dir, `${B}.jsonl`), line({ type: "user", message: { content: [{ type: "text", text: "Fix auth" }] } }));
    writeFileSync(join(dir, "notes.jsonl"), "ignored");
    utimesSync(join(dir, `${A}.jsonl`), new Date(1000), new Date(1000));

    const sessions = listSessions("/work/proj");
    expect(sessions.map((s) => [s.id, s.firstPrompt])).toEqual([
      [B, "Fix auth"],
      [A, "Build the scraper fast"],
    ]);
  });

  it("returns nothing for an unknown project", () => {
    expect(listSessions("/nope")).toEqual([]);
  });
});
