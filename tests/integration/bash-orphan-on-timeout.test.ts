import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { wireChildBashJobs } from "../../src/bash/child.js";
import { getChildBashRegistry } from "../../src/bash/child-registry.js";
import {
  createOrphanFixture,
  killGroup,
  liveGroupMembers,
  until,
  type OrphanFixture,
} from "../bash/helpers/orphan-fixtures.js";

/**
 * reaper-orphans plan §7 seal-chain integration: a real child bash job whose
 * group holds a SIGTERM-resistant worker (the vitest-worker orphan shape) is
 * fully reaped by `registry.sealAndKill(sessionId, 300)`.
 */
function fakePi() {
  const tools = new Map<string, { name: string; execute: (...args: never[]) => unknown }>();
  const pi = {
    registerTool: (tool: { name: string; execute: (...args: never[]) => unknown }) => tools.set(tool.name, tool),
    registerCommand: () => undefined,
    on: () => undefined,
    sendMessage: () => undefined,
    appendEntry: () => undefined,
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  };
  return { pi: pi as unknown as ExtensionAPI, tools };
}

const dirs: string[] = [];
let fixture: OrphanFixture | undefined;
let pgid: number | undefined;
afterEach(() => {
  if (pgid !== undefined) killGroup(pgid);
  pgid = undefined;
  fixture?.cleanup();
  fixture = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("sealAndKill reaps SIGTERM-resistant group members", () => {
  it("leader + resistant worker ⇒ whole group empty after sealAndKill(…, 300)", async () => {
    const { pi, tools } = fakePi();
    const sessionId = randomUUID();
    const dir = mkdtempSync(join(tmpdir(), "pi-toolkit-orphan-seal-"));
    dirs.push(dir);
    fixture = createOrphanFixture();
    wireChildBashJobs(pi, { settings: { ...DEFAULT_SETTINGS, bashJobs: { ...DEFAULT_SETTINGS.bashJobs, dir } } });
    const ctx = {
      cwd: dir,
      sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
      model: { provider: "test", id: "test-model" },
    } as unknown as ExtensionContext;

    const result = (await tools
      .get("bash")!
      .execute("c1", { command: fixture.command("alive"), run_in_background: true }, undefined, undefined, ctx)) as {
      details?: { jobId?: string };
    };
    const jobId = result.details?.jobId;
    expect(jobId).toBeTruthy();

    let pid: number | undefined;
    expect(
      await until(() => {
        return fixture!.workerPid() !== undefined;
      }),
    ).toBe(true);
    const status = (await tools
      .get("bash_job")!
      .execute("c2", { action: "status", job_id: jobId }, undefined, undefined, ctx)) as { details?: { pid?: number } };
    pid = status.details?.pid;
    expect(pid).toBeTruthy();
    pgid = pid;
    expect(liveGroupMembers(pid!)).toBeGreaterThanOrEqual(2);

    const sealed = getChildBashRegistry().sealAndKill(sessionId, 300);
    expect(sealed).toBeDefined();
    await sealed!.done;
    expect(await until(() => liveGroupMembers(pid!) === 0, 5_000)).toBe(true);
  }, 15_000);
});
