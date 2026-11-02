/**
 * headless-confirm plan (docs/dev/memory/headless-confirm/plan.md) — the integration half:
 * the memory user-order guard's confirm running over the REAL ask_user remote channel —
 * `wireWebHub`'s real `dialogBridge` (AskUserRemotePort), the real unix-socket link, the real
 * dialogs wire frame, and the real `dialog_answer` cmd round-trip back through the bridge —
 * against the real guard + real CAS write path (real createJevWritePort touchedUserEntries,
 * real memory dir, real lock/commit). The unit matrix (tests/memory/tool-v2-jev-remote-confirm
 * .test.ts) pins the arbitration/lifecycle/CAS edges with fake ports; this file proves the
 * production port wiring end to end: hub frame shapes, sensitive-content protection on the
 * actual wire bytes, and a web approve committing / a web decline refusing.
 *
 * Managed-spawn note: the remaining hop beyond this suite — a REAL `pi --mode rpc` child forked
 * by the hub supervisor with the extension loaded — needs a scripted model provider and is
 * tracked in the plan's impl-notes.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { memoryDirFor, type MemoryPaths } from "../../src/memory/paths.js";
import { createMemoryToolV2 } from "../../src/memory/tool-v2.js";
import { createJevWritePort } from "../../src/memory/jev/write-port.js";
import { EntryIndex } from "../../src/memory/jev/entries.js";
import { mergeTaxonomy } from "../../src/memory/jev/taxonomy.js";
import type { JevClient, JevStatus } from "../../src/memory/jev/contracts.js";
import { wireWebHub, type WebHubDeps } from "../../src/web-hub/agent/index.js";
import type { AgentFrame, CmdFrame } from "../../src/web-hub/protocol/messages.js";
import {
  ackFrame,
  fakeCtx,
  fakePi,
  pathsIn,
  resetGlobals,
  SETTINGS,
  startFakeHub,
  tmpDir,
  waitUntil,
  type FakeHub,
} from "../web-hub/agent/helpers.js";

const GUARD_FILE = "## Rules\n\n- 用户令一条\n";
const REFUSE = "用户未确认";
const APPROVE_LABEL = "确认执行";
const DECLINE_LABEL = "取消";

const PARTIAL: JevStatus = { kind: "partial", reason: "451", inactive: false };

let tmp: ReturnType<typeof tmpDir>;
let hub: FakeHub | undefined;

beforeEach(() => {
  tmp = tmpDir("mem-headless-confirm-");
  resetGlobals();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:web-hub:cmd-ledger")];
});

afterEach(async () => {
  resetGlobals();
  await hub?.close();
  hub = undefined;
  tmp.cleanup();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:web-hub:cmd-ledger")];
});

function webHubDeps(over: Partial<WebHubDeps> = {}): WebHubDeps {
  return {
    settings: SETTINGS,
    fleet: () => [],
    env: { HOME: tmp.dir },
    paths: pathsIn(tmp.dir),
    buildInfo: async () => ({ pluginVersion: "1.2.3", buildId: "1.2.3@test" }),
    argv1: "/nonexistent/pi",
    ...over,
  };
}

/** The real guard port (real touchedUserEntries pairing) over an always-partial client. */
function realJevPort(paths: MemoryPaths, cwd: string, confirmTimeoutMs = 60_000) {
  const client: JevClient = {
    status: () => PARTIAL,
    async ask() {
      return { ok: false, reason: "unavailable", detail: "down" };
    },
    async probe() {
      return PARTIAL;
    },
  };
  return createJevWritePort({
    client,
    entryIndex: new EntryIndex(),
    dirFor: () => memoryDirFor(cwd, paths),
    taxonomyFor: () => mergeTaxonomy().taxonomy,
    confirmTimeoutMs,
    now: () => Date.parse("2026-10-31T00:00:00Z"),
  });
}

interface Fixture {
  cwd: string;
  paths: MemoryPaths;
  memDir: string;
}

function memoryFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mem-hc-"));
  const cwd = join(root, "proj");
  mkdirSync(cwd, { recursive: true });
  const paths = { memoryRoot: join(root, "mem"), ccProjectsRoot: join(root, "cc") };
  const memDir = memoryDirFor(cwd, paths);
  mkdirSync(memDir, { recursive: true });
  return { cwd, paths, memDir };
}

/** Connect wireWebHub to the (fake-server) hub socket and complete the handshake — the real
 *  dialogBridge then lives at control.askUserRemote(), exactly as src/index.ts wires it. */
async function connectAgent() {
  hub = await startFakeHub(pathsIn(tmp.dir).socketPath, { autoAck: false });
  const { pi, fire } = fakePi();
  const control = wireWebHub(pi, webHubDeps());
  const { ctx } = fakeCtx({ mode: "rpc" });
  fire("session_start", { type: "session_start", reason: "startup" }, ctx);
  await waitUntil(() => hub!.all().some((f) => f.t === "hello"));
  const hello = hub!.all().find((f) => f.t === "hello") as Extract<AgentFrame, { t: "hello" }>;
  hub!.send(hub!.conns[0]!, ackFrame(`a${hello.agentId.pid}`, 4242, ["cmd.v1", "dialog.v1"]));
  await waitUntil(() => control.status().state === "live", 3_000, "live");
  return { control };
}

function cmdFrame(id: string, cmd: CmdFrame["cmd"]): AgentFrame & { t: "cmd" } {
  return {
    t: "cmd",
    rid: `r-${id}`,
    id,
    deadlineMs: 8_000,
    origin: { listener: "loopback", ip: "127.0.0.1", reqId: "0123456789abcdef" },
    cmd,
  } as AgentFrame & { t: "cmd" };
}

function rpcCtx(cwd: string): ExtensionContext {
  // The headless spawn session's tool context: rpc mode (dialog-capable, so hasUI is true —
  // exactly the combination that used to dead-lock on the hub's auto-cancelled confirm).
  return {
    mode: "rpc",
    hasUI: true,
    cwd,
    ui: {
      notify: () => {},
      confirm: async () => {
        throw new Error("rpc confirm must never be called");
      },
    },
  } as unknown as ExtensionContext;
}

async function openGuardDialog(fx: Fixture, control: ReturnType<typeof wireWebHub>) {
  writeFileSync(join(fx.memDir, "core.md"), GUARD_FILE);
  const tool = createMemoryToolV2({
    settings: DEFAULT_SETTINGS.memory,
    isChildSession: false,
    onAfterWrite: () => {},
    paths: fx.paths,
    jev: realJevPort(fx.paths, fx.cwd),
    remote: () => control.askUserRemote(),
  });
  const pending = tool.execute(
    "headless-call-1",
    { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" } as never,
    undefined,
    undefined,
    rpcCtx(fx.cwd),
  );
  // The real bridge pushes a dialogs frame over the socket.
  await waitUntil(() => hub!.all().some((f) => f.t === "dialogs" && f.open.length > 0), 5_000, "dialogs frame");
  const opened = hub!.all().find((f) => f.t === "dialogs" && f.open.length > 0) as Extract<
    AgentFrame,
    { t: "dialogs" }
  >;
  return { pending, dialogId: opened.open[0]!.dialogId, epoch: opened.epoch, record: opened.open[0]! };
}

function answerDialog(id: string, dialogId: string, epoch: string, label: string) {
  hub!.send(
    hub!.conns[0]!,
    cmdFrame(id, {
      op: "dialog_answer",
      dialogId,
      epoch,
      answers: [{ selected: [label], other: null }],
    }),
  );
}

/** Attach a no-op consumer so an early REFUSE/CAS rejection (fires while the
 *  test is still awaiting the cmd_result frame) is never an unhandled
 *  rejection; the assertions below consume the same promise again. */
function swallow(p: Promise<unknown>): void {
  p.catch(() => {});
}

describe("memory guard × real ask_user remote channel", () => {
  it("a web approve over the real socket commits the write", async () => {
    const fx = memoryFixture();
    const { control } = await connectAgent();
    const { pending, dialogId, epoch, record } = await openGuardDialog(fx, control);

    // Wire-shape + sensitive-content protection on the REAL frame: two fixed options,
    // one question, no entry body anywhere in the dialog record.
    expect(record.dialogId).toBe("ask:memory:headless-call-1");
    const q = record.questions[0]!;
    expect(q.options.map((o) => o.label)).toEqual([APPROVE_LABEL, DECLINE_LABEL]);
    expect(JSON.stringify(record)).not.toContain("用户令一条");
    expect(q.question).toContain("core.md");
    expect(q.question).toContain("1 条用户令");

    answerDialog("cmd0000000000001", dialogId, epoch, APPROVE_LABEL);
    await waitUntil(() => hub!.all().some((f) => f.t === "cmd_result" && f.id === "cmd0000000000001"));
    expect(hub!.all().find((f) => f.t === "cmd_result" && f.id === "cmd0000000000001")).toMatchObject({ ok: true });

    const result = (await pending) as { content: { type: string; text: string }[] };
    expect(result.content[0]!.text).toContain("edited core.md");
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toContain("改掉");
    rmSync(fx.cwd, { recursive: true, force: true });
    rmSync(fx.paths.memoryRoot, { recursive: true, force: true });
  });

  it("a web decline over the real socket refuses and the file stays untouched", async () => {
    const fx = memoryFixture();
    const { control } = await connectAgent();
    const { pending, dialogId, epoch } = await openGuardDialog(fx, control);

    answerDialog("cmd0000000000002", dialogId, epoch, DECLINE_LABEL);
    swallow(pending);
    await waitUntil(() => hub!.all().some((f) => f.t === "cmd_result" && f.id === "cmd0000000000002"));

    await expect(pending).rejects.toThrow(REFUSE);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe(GUARD_FILE);
    rmSync(fx.cwd, { recursive: true, force: true });
    rmSync(fx.paths.memoryRoot, { recursive: true, force: true });
  });

  it("a concurrent same-file change while the card is open ⇒ CAS refusal, concurrent version kept", async () => {
    const fx = memoryFixture();
    const { control } = await connectAgent();
    const { pending, dialogId, epoch } = await openGuardDialog(fx, control);

    writeFileSync(join(fx.memDir, "core.md"), "## Rules\n\n- 用户令一条（别处已改）\n");
    answerDialog("cmd0000000000003", dialogId, epoch, APPROVE_LABEL);
    swallow(pending);
    await waitUntil(() => hub!.all().some((f) => f.t === "cmd_result" && f.id === "cmd0000000000003"));

    await expect(pending).rejects.toThrow(/changed concurrently/);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe("## Rules\n\n- 用户令一条（别处已改）\n");
    rmSync(fx.cwd, { recursive: true, force: true });
    rmSync(fx.paths.memoryRoot, { recursive: true, force: true });
  });
});
