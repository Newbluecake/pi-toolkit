// Shared fixtures for the web-resume P1 session-nav tests: fake session-jsonl builders and
// the <agent>/sessions/<dir>/ layout the provenance cache derivation expects.

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Layout {
  root: string;
  agentDir: string;
  sessionDir: string;
}

export async function makeLayout(): Promise<Layout> {
  const root = await mkdtemp(join(tmpdir(), "session-nav-p1-"));
  const agentDir = join(root, "agent");
  const sessionDir = join(agentDir, "sessions", "--cwd--");
  await mkdir(sessionDir, { recursive: true });
  return { root, agentDir, sessionDir };
}

export async function dropLayout(layout: Layout): Promise<void> {
  await rm(layout.root, { recursive: true, force: true });
}

export function headerLine(id: string, cwd = "/tmp"): string {
  return JSON.stringify({ type: "session", id, timestamp: "2026-10-16T00:00:00.000Z", cwd });
}

/** `subagent:child` self-marker (session-driver.ts writes it as line 2 of persisted children). */
export function childMarkerLine(): string {
  return JSON.stringify({ type: "custom", customType: "subagent:child", data: { v: 1 } });
}

/** A main-session `subagent:run` entry pointing at a child file (`diag.sessionFile`). */
export function runMarkLine(childPath: string): string {
  return JSON.stringify({ type: "custom", customType: "subagent:run", data: { diag: { sessionFile: childPath } } });
}

export function nameLine(name: string): string {
  return JSON.stringify({ type: "session_info", name });
}

export function userLine(text: string): string {
  return JSON.stringify({
    type: "message",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

/** A filler line with no marks (kept small so tests control file sizes precisely). */
export function fillerLine(bytes = 64): string {
  return JSON.stringify({ type: "custom", customType: "test:filler", data: "x".repeat(Math.max(1, bytes - 60)) });
}
