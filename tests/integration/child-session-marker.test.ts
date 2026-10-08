/**
 * web-hub session-history plan §4.3 (H0) — REAL `PiSessionDriver` + real pi `createAgentSession`
 * against a scripted fake model runtime (same harness style as
 * tests/integration/child-bash-jobs-real-session.test.ts), exercising the `subagent:child` marker
 * end to end:
 *
 * - M1 create path: line 1 header, line 2 the marker; the `subagent:prompt-sections` snapshot a
 *   real child session persists carries ONLY `pi_project_memory` (agent-types/models register
 *   post-guard, main-session only); the first user message sits on the real persisted branch with
 *   the marker as its ancestor; `buildSessionContext().messages` never contains the marker (pi's
 *   own CustomEntry contract: custom entries do not participate in LLM context).
 * - M2 resume path: resuming the same file appends no second marker.
 * - M4 todo #27 child-extension-missing: with settings.json NOT listing this package, the child
 *   extension never activates — the driver-side marker is still written, and the
 *   `child_extension_missing` diagnostic fires exactly as before.
 * - M5 projection: `src/web-hub/hub/run-file-reader.ts` projects a marked child session exactly
 *   like the same session without the marker, plus one ignored (display:false) custom entry; and
 *   session-nav's `[sub:type]` title machinery is unaffected (the marker is not a
 *   `subagent:run` entry).
 *
 * M3 (consult fork has no marker) lives in tests/integration/consult.test.ts.
 *
 * Hermeticity: `PI_CODING_AGENT_DIR` is redirected to a scratch dir (session storage + pi's
 * settings.json extension discovery), `HOME` to another scratch dir (the extension's own
 * settings path `~/.pi/agent/pi-subagent.json` and the memory root are homedir()-based), both
 * restored in afterEach. M1/M2 claim the process-wide `Symbol.for("pi-subagent:host")` key for
 * the duration of the create so the extension's `activate()` takes the child-session branch —
 * exactly what a real child session sees in the host process (the key is released afterwards).
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSessionContext, createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { PiSessionDriver, SUBAGENT_CHILD_CUSTOM_TYPE } from "../../src/runtime/session-driver.js";
import type { SessionHandle } from "../../src/runtime/session-driver.js";
import { createRunFileReader } from "../../src/web-hub/hub/run-file-reader.js";
import { collectSubagentMarks, markSubagentSessions } from "../../src/session-nav/subagent-sessions.js";

const posix = process.platform !== "win32";
const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const HOST_KEY = Symbol.for("pi-subagent:host");

function fakeModel() {
  return {
    id: "fake-model",
    name: "Fake Model",
    api: "anthropic-messages",
    provider: "fake-provider",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
}
type FakeModel = ReturnType<typeof fakeModel>;

function fakeModelRuntime(model: FakeModel, replies: string[]) {
  let call = 0;
  const requestMessages: unknown[][] = [];
  return {
    streamSimple: (_m: unknown, context: { messages?: unknown[] }) => {
      requestMessages.push(context.messages ?? []);
      const text = replies[call] ?? replies[replies.length - 1]!;
      call += 1;
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      });
      return stream;
    },
    getAuth: async () => undefined,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ ok: true }),
    isUsingOAuth: () => false,
    getAvailableSnapshot: () => [model],
    getModel: () => model,
    callCount: () => call,
    requestMessages,
  };
}
type FakeModelRuntime = ReturnType<typeof fakeModelRuntime>;

interface Scratch {
  root: string;
  cwd: string;
  agentDir: string;
  settingsJson(packages: string[] | undefined): void;
}

const scratches: Scratch[] = [];
const envRestore: Array<() => void> = [];
let hostKeyReleased: (() => void) | undefined;

afterEach(() => {
  hostKeyReleased?.();
  hostKeyReleased = undefined;
  for (const restore of envRestore.splice(0)) restore();
  for (const s of scratches.splice(0)) rmSync(s.root, { recursive: true, force: true });
});

function scratch(label: string): Scratch {
  const root = mkdtempSync(join(tmpdir(), `pi-child-marker-${label}-`));
  const cwd = join(root, "work");
  const agentDir = join(root, "agent-home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(root, "home"), { recursive: true }); // redirected HOME target
  const s: Scratch = {
    root,
    cwd,
    agentDir,
    settingsJson(packages: string[] | undefined) {
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ ...(packages ? { packages } : {}) }));
    },
  };
  scratches.push(s);
  return s;
}

/** Redirect PI_CODING_AGENT_DIR (pi's agentDir: sessions + extension discovery) and HOME (the
 *  toolkit's own settings + memory root are homedir()-based) for the rest of the test. */
function redirectEnv(s: Scratch): void {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = s.agentDir;
  envRestore.push(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  });
  const prevHome = process.env.HOME;
  process.env.HOME = join(s.root, "home");
  expect(homedir()).toBe(process.env.HOME); // premise of the redirect (posix)
  envRestore.push(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });
}

/** Claim the host key so the extension's activate() takes the CHILD branch (a real child session
 *  in the host process sees exactly this state). Released in afterEach. */
function claimHostKey(): void {
  const g = globalThis as Record<symbol, unknown>;
  const prev = g[HOST_KEY];
  g[HOST_KEY] = { activatedAt: Date.now() };
  hostKeyReleased = () => {
    if (prev === undefined) delete g[HOST_KEY];
    else g[HOST_KEY] = prev;
  };
}

async function createChildSession(opts: {
  cwd: string;
  runtime: FakeModelRuntime;
  prompt: string;
}): Promise<{ handle: SessionHandle; file: string }> {
  const model = fakeModel();
  const driver = new PiSessionDriver(true, () => model);
  const handle = await driver.create({
    cwd: opts.cwd,
    model: model as never,
    modelRuntime: opts.runtime as never,
    persist: true,
  } as never);
  try {
    await handle.prompt(opts.prompt);
    const file = handle.sessionFile;
    expect(file).toBeDefined();
    return { handle, file: file! };
  } finally {
    handle.dispose();
  }
}

function readLines(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "");
}

function markerLineCount(file: string): number {
  return readLines(file).filter((l) => l.startsWith(`{"type":"custom","customType":"${SUBAGENT_CHILD_CUSTOM_TYPE}"`))
    .length;
}

describe.skipIf(!posix)("H0 child-session marker: real driver create (M1)", () => {
  it("marker is line 2; prompt-sections snapshot has only pi_project_memory; the marker is an ancestor of the first user message and never enters LLM context", async () => {
    const s = scratch("m1");
    redirectEnv(s);
    s.settingsJson([REPO_ROOT]); // regular installation shape: settings.json lists THIS package
    claimHostKey(); // child-session branch for the extension's activate()

    const runtime = fakeModelRuntime(fakeModel(), ["child answer"]);
    const { file } = await createChildSession({ cwd: s.cwd, runtime, prompt: "child task" });

    // --- line 1 header, line 2 marker
    const lines = readLines(file);
    const header = JSON.parse(lines[0]!);
    expect(header.type).toBe("session");
    expect(lines[1]!.startsWith(`{"type":"custom","customType":"${SUBAGENT_CHILD_CUSTOM_TYPE}"`)).toBe(true);
    const marker = JSON.parse(lines[1]!);
    expect(marker.data).toEqual({ v: 1 });
    expect(markerLineCount(file)).toBe(1);

    // --- the extension really activated in the child branch (M1's premise): the sysprompt hub
    //     persisted a prompt-sections snapshot with ONLY the memory section (pre-guard);
    //     agent-types/models are post-guard, main-session only.
    const sectionLines = lines.filter((l) => l.startsWith(`{"type":"custom","customType":"subagent:prompt-sections"`));
    expect(sectionLines.length).toBeGreaterThanOrEqual(1);
    const sectionEntry = JSON.parse(sectionLines[0]!);
    expect(Object.keys(sectionEntry.data.sections)).toEqual(["pi_project_memory"]);

    // --- first user message on the REAL persisted branch, with the marker as ancestor
    const reopened = SessionManager.open(file);
    const branch = reopened.getBranch() as Array<Record<string, unknown>>;
    const firstUser = branch.find(
      (e) => e["type"] === "message" && (e["message"] as { role?: string } | undefined)?.["role"] === "user",
    );
    expect(firstUser).toBeDefined();
    const byId = new Map(branch.map((e) => [e["id"] as string, e]));
    let cursor: string | undefined = firstUser!["parentId"] as string | undefined;
    const ancestors: string[] = [];
    while (cursor !== undefined && cursor !== null) {
      ancestors.push(cursor);
      const parent = byId.get(cursor);
      expect(parent).toBeDefined(); // a healthy chain never dangles
      cursor = parent!["parentId"] as string | undefined;
    }
    expect(ancestors).toContain(marker.id); // marker is an ancestor of the first user message

    // --- buildSessionContext never surfaces the marker (custom entries are not LLM context)
    const entries = reopened.getEntries();
    const ctx = buildSessionContext(entries, reopened.getLeafId());
    expect(ctx.messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(ctx.messages)).not.toContain(SUBAGENT_CHILD_CUSTOM_TYPE);
    // and the real model requests agree (the fake runtime saw the same projection)
    expect(JSON.stringify(runtime.requestMessages[0])).not.toContain(SUBAGENT_CHILD_CUSTOM_TYPE);
  });
});

describe.skipIf(!posix)("H0 child-session marker: resume does not re-mark (M2)", () => {
  it("driver.resume() on the M1-style file runs another round and the file still has exactly ONE marker line", async () => {
    const s = scratch("m2");
    redirectEnv(s);
    s.settingsJson([REPO_ROOT]);
    claimHostKey();

    const model = fakeModel();
    const runtime = fakeModelRuntime(model, ["first answer"]);
    const { file } = await createChildSession({ cwd: s.cwd, runtime, prompt: "first task" });
    expect(markerLineCount(file)).toBe(1);

    const runtime2 = fakeModelRuntime(model, ["second answer"]);
    const driver = new PiSessionDriver(true, () => model);
    const handle = await driver.resume(file, {
      cwd: s.cwd,
      model: model as never,
      modelRuntime: runtime2 as never,
      persist: true,
    } as never);
    try {
      await handle.prompt("second task");
      expect(runtime2.callCount()).toBe(1);
    } finally {
      handle.dispose();
    }
    expect(markerLineCount(file)).toBe(1); // exactly one marker, still line 2
    expect(readLines(file)[1]!.startsWith(`{"type":"custom","customType":"${SUBAGENT_CHILD_CUSTOM_TYPE}"`)).toBe(true);
  });
});

describe.skipIf(!posix)("H0 child-session marker: child-extension-missing still gets the marker (M4)", () => {
  it("settings.json does NOT list this package -> extension never activates -> marker still written, child_extension_missing diagnostic unchanged", async () => {
    const s = scratch("m4");
    redirectEnv(s);
    s.settingsJson(undefined); // empty settings: no packages — todo #27's `-e`-style parent shape

    const runtime = fakeModelRuntime(fakeModel(), ["orphan answer"]);
    const model = fakeModel();
    const driver = new PiSessionDriver(true, () => model);
    const handle = await driver.create({
      cwd: s.cwd,
      model: model as never,
      modelRuntime: runtime as never,
      persist: true,
    } as never);
    try {
      // Diagnostics unchanged: the todo #27 event fires exactly as before the marker existed.
      const events: Array<{ t: string }> = [];
      await driver.bind(handle, (e) => events.push(e as { t: string }));
      expect((handle as { childExtensionMissing?: boolean }).childExtensionMissing).toBe(true);
      expect(events).toContainEqual({ t: "child_extension_missing" });

      await handle.prompt("orphan task");
    } finally {
      handle.dispose();
    }
    const file = handle.sessionFile!;
    expect(file).toBeDefined();
    // The marker is the WHOLE point of driver-side writing: it exists even though the child
    // extension never activated (no prompt-sections snapshot either — the hub never ran).
    expect(markerLineCount(file)).toBe(1);
    expect(readLines(file).some((l) => l.includes("subagent:prompt-sections"))).toBe(false);
  });
});

describe.skipIf(!posix)("H0 child-session marker: projection unaffected (M5)", () => {
  it("run-file-reader projects the marked child session identically to the marker-free control, plus exactly one ignored custom entry", async () => {
    const s = scratch("m5");
    redirectEnv(s);
    s.settingsJson(undefined); // extension absent keeps the file minimal (no prompt-sections noise)

    const { file } = await createChildSession({
      cwd: s.cwd,
      runtime: fakeModelRuntime(fakeModel(), ["m5 answer"]),
      prompt: "m5 task",
    });

    // Control: the SAME session without the marker — drop the marker line and reparent every
    // entry that hung off it to the marker's own parent (null = root). The leaf id is untouched.
    const lines = readLines(file);
    const markerIdx = lines.findIndex((l) =>
      l.startsWith(`{"type":"custom","customType":"${SUBAGENT_CHILD_CUSTOM_TYPE}"`),
    );
    expect(markerIdx).toBe(1); // sanity: still line 2 here
    const markerId = JSON.parse(lines[markerIdx]!).id as string;
    const controlPath = join(s.root, "control.jsonl");
    const controlLines = lines
      .filter((_, i) => i !== markerIdx)
      .map((l) => {
        const entry = JSON.parse(l);
        if (entry.parentId === markerId) entry.parentId = null;
        return JSON.stringify(entry);
      });
    writeFileSync(controlPath, `${controlLines.join("\n")}\n`);

    const reader = createRunFileReader();
    const leafId = SessionManager.open(file).getLeafId();
    expect(leafId).toBe(SessionManager.open(controlPath).getLeafId()); // same leaf on both files
    const deadline = Date.now() + 10_000;
    const marked = await reader.read(file, leafId!, { limit: 100, maxBytes: 1 << 20, deadlineAt: deadline });
    const control = await reader.read(controlPath, leafId!, { limit: 100, maxBytes: 1 << 20, deadlineAt: deadline });
    expect(marked.ok).toBe(true);
    expect(control.ok).toBe(true);
    if (!marked.ok || !control.ok) throw new Error("reader failed");

    const markerRows = marked.entries.filter(
      (e) => e.type === "custom" && (e as { customType?: string }).customType === SUBAGENT_CHILD_CUSTOM_TYPE,
    );
    expect(markerRows).toHaveLength(1);
    expect((markerRows[0] as { display?: boolean }).display).toBe(false); // the ignored custom
    expect(
      control.entries.every(
        (e) => !((e as { customType?: string }).customType ?? "").includes(SUBAGENT_CHILD_CUSTOM_TYPE),
      ),
    ).toBe(true);
    expect(marked.entries.length).toBe(control.entries.length + 1); // exactly one extra row
    // Everything else projects identically to the marker-free control. `parentId` is normalized
    // away on both sides: the one entry that hung off the marker necessarily reparents to the
    // marker's own parent (null) in the control — that ancestry shift IS the removed marker row,
    // already accounted for by the length assertion above, not a projection difference.
    const stripParent = (entries: typeof marked.entries) =>
      entries.map((e) => {
        const { parentId: _parentId, ...rest } = e as { parentId?: string };
        return rest;
      });
    expect(stripParent(marked.entries.filter((e) => e !== markerRows[0]))).toEqual(stripParent(control.entries));
    reader.dispose();
  });

  it("session-nav: the marker is not a subagent:run entry — collectSubagentMarks finds none, and [sub:type] titles still apply", async () => {
    const s = scratch("m5nav");
    redirectEnv(s);
    s.settingsJson(undefined);

    const { file } = await createChildSession({
      cwd: s.cwd,
      runtime: fakeModelRuntime(fakeModel(), ["nav answer"]),
      prompt: "nav task",
    });

    const marks = await collectSubagentMarks([file], dirname(file));
    expect(marks.size).toBe(0); // the child marker itself contributes no mark

    // A main session's subagent:run entry pointing at this child still drives the title
    // (markSubagentSessions is the pure title function; the child file's contents never enter it).
    const sessionInfo = {
      path: file,
      id: "whatever",
      cwd: s.cwd,
      created: new Date(),
      modified: new Date(),
      messageCount: 2,
      firstMessage: "nav task",
      allMessagesText: "nav task",
    } as unknown as SessionInfo;
    const marked = markSubagentSessions(
      [sessionInfo],
      new Map([[resolve(file), { agentType: "explorer", label: "scan the repo" }]]),
    );
    expect(marked[0]!.firstMessage).toBe("[sub:explorer] scan the repo");
  });
});
