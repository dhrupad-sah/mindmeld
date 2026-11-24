import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity, fingerprint } from "../src/identity.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mindmeld-id-"));
  process.env.MINDMELD_HOME = dir;
});
afterEach(() => {
  delete process.env.MINDMELD_HOME;
  rmSync(dir, { recursive: true, force: true });
});

describe("identity", () => {
  it("creates once and reuses", () => {
    const a = loadOrCreateIdentity();
    const b = loadOrCreateIdentity();
    expect(a.deviceId).toBe(b.deviceId);
    expect(a.deviceId).toMatch(/^[0-9a-f]{16}$/);
    expect(b.signPriv).toBe(a.signPriv);
  });

  it.skipIf(process.platform === "win32")("file is mode 600", () => {
    loadOrCreateIdentity();
    expect(statSync(join(dir, "identity.json")).mode & 0o777).toBe(0o600);
  });

  it("fingerprint is stable and 8 groups", () => {
    const id = loadOrCreateIdentity();
    const fp = fingerprint(id.signPub);
    expect(fp).toMatch(/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
    expect(fingerprint(id.signPub)).toBe(fp);
  });

  describe("corrupt file", () => {
    const file = () => join(dir, "identity.json");
    it("truncated JSON throws guidance", () => {
      loadOrCreateIdentity();
      writeFileSync(file(), readFileSync(file(), "utf8").slice(0, 40));
      expect(() => loadOrCreateIdentity()).toThrow(/identity\.json is corrupt.*Repair it or delete it/);
    });
    it("empty object throws guidance", () => {
      writeFileSync(file(), "{}");
      expect(() => loadOrCreateIdentity()).toThrow(/identity\.json is corrupt.*Repair it or delete it/);
    });
    it("signPub not matching signPriv throws guidance", () => {
      const a = loadOrCreateIdentity();
      rmSync(file());
      const other = loadOrCreateIdentity();
      writeFileSync(file(), JSON.stringify({ ...a, signPub: other.signPub }));
      expect(() => loadOrCreateIdentity()).toThrow(/identity\.json is corrupt.*Repair it or delete it/);
    });
  });
});
