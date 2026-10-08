import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isConsultForkSpec, markChildSession, SUBAGENT_CHILD_CUSTOM_TYPE } from "../../src/runtime/session-driver.js";
import type { SessionSpec } from "../../src/runtime/session-driver.js";

/**
 * web-hub session-history plan §4.3 (H0, PD2): every persisted child (subagent) session gets a
 * `subagent:child` custom entry as its very FIRST entry, written by the DRIVER right after
 * `SessionManager.create()` — before any setup entry `createAgentSession` appends — so it is
 * fixed on line 2 of the lazily-flushed jsonl. Consult forks (`forkSessionFrom`) and
 * non-persisted runs never get it; `resume()` never writes it (source-scan pinned below).
 */
describe("H0 markChildSession: unit (real devDep SessionManager)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function scratch(): { cwd: string; sessions: string } {
    const cwd = mkdtempSync(join(tmpdir(), "pi-child-marker-unit-"));
    dirs.push(cwd);
    const sessions = join(cwd, "sessions");
    return { cwd, sessions };
  }

  it("marker lands on line 2, right after the header, once a user message flushes the file", () => {
    const { cwd, sessions } = scratch();
    const sm = SessionManager.create(cwd, sessions);
    markChildSession(sm, {}, true);
    // Lazy persistence: no conversation yet -> no file at all (pinned separately below).
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "child task" }],
      timestamp: Date.now(),
    });
    const file = sm.getSessionFile();
    expect(file).toBeDefined();
    const lines = readFileSync(file!, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(lines[0]!).type).toBe("session"); // line 1: header
    // Line 2 is EXACTLY the marker (pi's appendCustomEntry serializes type/customType first).
    expect(lines[1]!.startsWith(`{"type":"custom","customType":"${SUBAGENT_CHILD_CUSTOM_TYPE}"`)).toBe(true);
    const marker = JSON.parse(lines[1]!);
    expect(marker.type).toBe("custom");
    expect(marker.customType).toBe(SUBAGENT_CHILD_CUSTOM_TYPE);
    expect(marker.data).toEqual({ v: 1 });
    expect(marker.parentId).toBeNull(); // first entry: child of the root
    expect(marker.id).toBeTypeOf("string");
  });

  it("pi's lazy persistence: marking alone never creates the file", () => {
    const { cwd, sessions } = scratch();
    const sm = SessionManager.create(cwd, sessions);
    markChildSession(sm, {}, true);
    expect(sm.getSessionFile()).toBeDefined();
    expect(existsSync(sm.getSessionFile()!)).toBe(false);
  });

  it("writes nothing (and does not throw) when persist=false", () => {
    const appendCustomEntry = vi.fn();
    markChildSession({ appendCustomEntry }, {}, false);
    expect(appendCustomEntry).not.toHaveBeenCalled();
  });

  it("writes nothing for a consult fork spec (forkSessionFrom)", () => {
    const appendCustomEntry = vi.fn();
    const spec: SessionSpec = { forkSessionFrom: "/tmp/expert.jsonl" };
    expect(isConsultForkSpec(spec)).toBe(true); // premise: this IS the consult-fork shape
    markChildSession({ appendCustomEntry }, spec, true);
    expect(appendCustomEntry).not.toHaveBeenCalled();
  });

  it("writes nothing when appendCustomEntry is absent or not a function (never throws)", () => {
    expect(() => markChildSession({}, {}, true)).not.toThrow();
    expect(() => markChildSession({ appendCustomEntry: "not-a-fn" }, {}, true)).not.toThrow();
    expect(() => markChildSession(null, {}, true)).not.toThrow();
    expect(() => markChildSession(undefined, {}, true)).not.toThrow();
  });

  it("swallows a throwing appendCustomEntry (best-effort marker, never fails the run)", () => {
    const appendCustomEntry = vi.fn(() => {
      throw new Error("boom");
    });
    expect(() => markChildSession({ appendCustomEntry }, {}, true)).not.toThrow();
    expect(appendCustomEntry).toHaveBeenCalledTimes(1); // it really tried, then swallowed
  });

  it("passes ({v: 1}) as the marker data on the happy path", () => {
    const appendCustomEntry = vi.fn();
    markChildSession({ appendCustomEntry }, {}, true);
    expect(appendCustomEntry).toHaveBeenCalledTimes(1);
    expect(appendCustomEntry).toHaveBeenCalledWith(SUBAGENT_CHILD_CUSTOM_TYPE, { v: 1 });
  });
});

/** Source-scan: `resume()` never marks — a resumed session's provenance is already on disk, and a
 *  consult fork (which resumes) must stay unmarked. The positive control (create DOES mark) keeps
 *  the scan from passing vacuously if the method extraction ever drifts. */
describe("H0 source scan: markChildSession call sites in session-driver.ts", () => {
  const source = readFileSync("src/runtime/session-driver.ts", "utf8");

  function methodBody(signature: string): string {
    const start = source.indexOf(`  ${signature} {`);
    expect(start).toBeGreaterThan(-1); // implementation found — extraction premise (interfaces end with `;`)
    const rest = source.slice(start + signature.length);
    const next = rest.search(/\n  [a-zA-Z]/);
    expect(next).toBeGreaterThan(-1);
    return rest.slice(0, next);
  }

  it("resume()'s body contains no markChildSession call", () => {
    expect(methodBody("resume(sessionFile: string, spec: SessionSpec)")).not.toContain("markChildSession");
  });

  it("create()'s body does call markChildSession (positive control)", () => {
    expect(methodBody("create(spec: SessionSpec)")).toContain("markChildSession(");
  });
});
