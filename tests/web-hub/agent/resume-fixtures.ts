/**
 * Shared fixtures for the web-resume P2 agent tests: pi-shaped session-jsonl writers and the
 * `<agent>/sessions/<dir>` layout the P1 provenance cache derivation expects (so a real
 * `advanceProvenance` in a test writes its cache inside the sandbox, never `~/.pi`).
 */
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProvenanceIndex } from "../../../src/session-nav/provenance.js";

export interface Layout {
  root: string;
  agentDir: string;
  sessionDir: string;
  cleanup(): void;
}

export function makeLayout(): Layout {
  const root = mkdtempSync(join(tmpdir(), "web-resume-p2-"));
  const agentDir = join(root, "agent");
  const sessionDir = join(agentDir, "sessions", "--encoded-cwd--");
  mkdirSync(sessionDir, { recursive: true });
  return { root, agentDir, sessionDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function headerLine(id: string, cwd: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "session", id, timestamp: "2026-10-16T00:00:00.000Z", cwd, ...extra });
}

export function childMarkerLine(): string {
  // byte-exact prefix pinned by session-head.ts's CUSTOM_TYPE_RE ({"type":"custom","customType":…)
  return JSON.stringify({ type: "custom", customType: "subagent:child", data: { v: 1 } });
}

export function runMarkLine(childPath: string): string {
  return JSON.stringify({ type: "custom", customType: "subagent:run", data: { diag: { sessionFile: childPath } } });
}

export interface SessionFixture {
  id: string;
  cwd: string;
  child?: boolean;
  forked?: boolean;
  name?: string;
  firstMessage?: string;
  /** Raw extra lines appended verbatim (already-encoded jsonl lines). */
  extraLines?: string[];
  /** Fixed mtime (D5 tests need files older than 30 s). */
  mtime?: Date;
}

/** Write one pi-shaped session file; returns its path. */
export function writeSession(dir: string, filename: string, fx: SessionFixture): string {
  const lines: string[] = [headerLine(fx.id, fx.cwd, fx.forked === true ? { parentSession: "/tmp/parent.jsonl" } : {})];
  if (fx.child === true) lines.push(childMarkerLine());
  if (fx.name !== undefined) lines.push(JSON.stringify({ type: "session_info", name: fx.name }));
  if (fx.firstMessage !== undefined) {
    lines.push(
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: fx.firstMessage }] },
      }),
    );
  }
  for (const l of fx.extraLines ?? []) lines.push(l);
  const path = join(dir, filename);
  writeFileSync(path, `${lines.join("\n")}\n`);
  if (fx.mtime !== undefined) utimesSync(path, fx.mtime, fx.mtime);
  return path;
}

/** A deterministic in-memory provenance index (P1's shape, incl. the status read). */
export function fakeIndex(has: readonly string[] = [], complete = true): ProvenanceIndex {
  const set = new Set(has);
  return {
    has: (p) => set.has(p),
    complete,
    status: complete ? "complete" : "partial",
  } as ProvenanceIndex & { status: string };
}

/** Controllable clock for the closure deps. */
export function fakeClock(start = 1_000_000): { now(): number; advance(ms: number): void; set(t: number): void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (v) => {
      t = v;
    },
  };
}
