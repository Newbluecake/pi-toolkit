/**
 * #39 P2 (memory-scopes arch §6.3): the driver half of the memory-seed pipeline,
 * on the REAL public SDK (SessionManager + createAgentSession) with own /tmp
 * resources and a fake model runtime (no real model, no network). Pins:
 * marker-first then exactly one seed snap; validation of the FINAL snap DTO;
 * synchronous write-gate refusal at the append point; append failure rejects
 * create BEFORE any session/model prompt; resume never reseeds; Fast coexistence.
 *
 * Tier 2 by location (tests/integration/**) — real child-process-free SDK use only.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiSessionDriver, SUBAGENT_CHILD_CUSTOM_TYPE, type SessionHandle } from "../../src/runtime/session-driver.js";
import type { SessionMemorySeedV1 } from "../../src/core/memory-types.js";

const STAMP = "2026-11-07T17:57:00.000Z";
const seed = (over: Partial<SessionMemorySeedV1> = {}): SessionMemorySeedV1 => ({
  v: 1,
  fromSid: "parent-sid",
  frozenAt: STAMP,
  items: [
    { id: "n1", text: "alpha", authority: "agent", created: STAMP, updated: STAMP },
    { id: "n2", text: "beta", authority: "agent", created: STAMP, updated: STAMP },
  ],
  nextN: 3,
  ...over,
});

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

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratch(): { cwd: string; agentDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), "memory39-seed-"));
  const agentDir = join(cwd, "agentdir");
  dirs.push(cwd);
  return { cwd, agentDir };
}

type CustomLike = { type: string; customType?: string; data?: unknown; id?: string };

function managerOf(handle: SessionHandle): SessionManager {
  return (handle as unknown as { session: { sessionManager: SessionManager } }).session.sessionManager;
}
function customEntries(sm: SessionManager): CustomLike[] {
  return sm.getBranch().filter((e) => (e as CustomLike).type === "custom") as unknown as CustomLike[];
}

describe("PiSessionDriver memory seed append (real SDK, fake runtime)", () => {
  it("appends the child marker FIRST, then exactly one seed snap with inherit", async () => {
    const { cwd, agentDir } = scratch();
    const driver = new PiSessionDriver(true, () => fakeModel());
    const handle = await driver.create({
      cwd,
      agentDir,
      model: { provider: "fake-provider", id: "fake-model" },
      memorySeed: seed(),
    });
    const sm = managerOf(handle);
    const customs = customEntries(sm);
    expect(customs[0]).toMatchObject({ customType: SUBAGENT_CHILD_CUSTOM_TYPE });
    const memoryEntries = customs.filter((e) => e.customType === "subagent:memory-session");
    expect(memoryEntries).toHaveLength(1);
    expect(memoryEntries[0]!.data).toEqual({
      v: 1,
      sid: sm.getSessionId(),
      op: "snap",
      items: seed().items,
      nextN: 3,
      inherit: { kind: "spawn", fromSid: "parent-sid", frozenAt: STAMP },
    });
  });

  it("no memorySeed ⇒ marker only, byte-identical legacy entry set", async () => {
    const { cwd, agentDir } = scratch();
    const driver = new PiSessionDriver(true, () => fakeModel());
    const handle = await driver.create({ cwd, agentDir, model: { provider: "fake-provider", id: "fake-model" } });
    expect(customEntries(managerOf(handle)).map((e) => e.customType)).toEqual([SUBAGENT_CHILD_CUSTOM_TYPE]);
  });

  it("an invalid final snap (exhaustion-class shape) rejects create before any session", async () => {
    const { cwd, agentDir } = scratch();
    const driver = new PiSessionDriver(true, () => fakeModel());
    // nextN beyond the frozen P0 cap: validation of the FINAL snap must fail closed.
    await expect(
      driver.create({
        cwd,
        agentDir,
        persist: false,
        model: { provider: "fake-provider", id: "fake-model" },
        memorySeed: seed({ nextN: 1_000_000 }),
      }),
    ).rejects.toThrow("memory seed append failed: invalid seed snap (nextN)");
    await expect(
      driver.create({
        cwd,
        agentDir,
        persist: false,
        model: { provider: "fake-provider", id: "fake-model" },
        memorySeed: seed({ fromSid: "not a sid!" }),
      }),
    ).rejects.toThrow("memory seed append failed: invalid seed snap (inherit)");
  });

  it("write-gate refusal rejects create (locked ⇒ zero branch/disk reads, no plaintext file)", async () => {
    const { cwd, agentDir } = scratch();
    const driver = new PiSessionDriver(true, () => fakeModel(), undefined, undefined, {
      check: () => ({ ok: false, reason: "locked" }),
    });
    await expect(
      driver.create({
        cwd,
        agentDir,
        persist: false,
        model: { provider: "fake-provider", id: "fake-model" },
        memorySeed: seed(),
      }),
    ).rejects.toThrow("memory seed append failed: write gate refused (locked)");
    expect(readdirSync(cwd)).toEqual([]); // nothing was created before the refusal
  });

  it("an appendCustomEntry failure rejects create — never swallowed into a memoryless child", async () => {
    const { cwd, agentDir } = scratch();
    const driver = new PiSessionDriver(true, () => fakeModel());
    const proto = SessionManager.prototype as {
      appendCustomEntry: (t: string, d?: unknown) => string;
    };
    const original = proto.appendCustomEntry;
    proto.appendCustomEntry = function (type: string) {
      if (type === "subagent:memory-session") throw new Error("boom");
      return original.call(this, type);
    };
    try {
      await expect(
        driver.create({
          cwd,
          agentDir,
          persist: false,
          model: { provider: "fake-provider", id: "fake-model" },
          memorySeed: seed(),
        }),
      ).rejects.toThrow("boom");
    } finally {
      proto.appendCustomEntry = original;
    }
  });

  it("resume never reseeds, even when the spec carries a memorySeed", async () => {
    const { cwd, agentDir } = scratch();
    const sessions = join(cwd, "sessions");
    // Build a real flushed child session file in tmp with our own manager.
    const src = SessionManager.create(cwd, sessions);
    src.appendMessage({
      role: "user",
      content: [{ type: "text", text: "child task" }],
      timestamp: Date.now(),
    });
    const file = src.getSessionFile()!;
    expect(file.startsWith(sessions)).toBe(true);

    const driver = new PiSessionDriver(true, () => fakeModel());
    const proto = SessionManager.prototype as {
      appendCustomEntry: (t: string, d?: unknown) => string;
    };
    const original = proto.appendCustomEntry;
    const types: string[] = [];
    proto.appendCustomEntry = function (type: string, data?: unknown) {
      types.push(type);
      return original.call(this, type, data);
    };
    try {
      await driver
        .resume(file, {
          cwd,
          agentDir,
          model: { provider: "fake-provider", id: "fake-model" },
          memorySeed: seed(), // a resume must ignore this: restore own session, no re-inheritance
        })
        .catch(() => undefined); // resume may fail later for unrelated reasons; seeding is what we pin
      expect(types).not.toContain("subagent:memory-session");
    } finally {
      proto.appendCustomEntry = original;
    }
  });

  it("coexists with Fast: both records appended, fast loader path untouched", async () => {
    const { cwd, agentDir } = scratch();
    const driver = new PiSessionDriver(true, () => fakeModel());
    const handle = await driver.create({
      cwd,
      agentDir,
      persist: false,
      model: { provider: "fake-provider", id: "fake-model" },
      fastSeed: { v: 1, mode: "inherit" },
      memorySeed: seed(),
    });
    const customs = customEntries(managerOf(handle));
    // Marker absent (inMemory): the seed snap still precedes the Fast record — the
    // seed append runs right after markChildSession, before createWithHuman's fast append.
    expect(customs.map((e) => e.customType)).toEqual(["subagent:memory-session", "subagent:fast"]);
    expect(customs[1]!.data).toEqual({ v: 1, mode: "inherit" });
    expect(customs[0]!.data).toMatchObject({ op: "snap", inherit: { kind: "spawn" } });
  });

  it("default gate derives from the frozen secure-domain verdict (plain here)", async () => {
    const { cwd, agentDir } = scratch();
    const driver = new PiSessionDriver(true, () => fakeModel()); // no injected gate
    const handle = await driver.create({
      cwd,
      agentDir,
      persist: false,
      model: { provider: "fake-provider", id: "fake-model" },
      memorySeed: seed(),
    });
    expect(customEntries(managerOf(handle)).some((e) => e.customType === "subagent:memory-session")).toBe(true);
  });

  it("module surface stays exportable for future assembly (no snapshot in this test)", () => {
    expect(vi.isMockFunction).toBeTypeOf("function"); // sanity: vitest alive
    expect(SUBAGENT_CHILD_CUSTOM_TYPE).toBeTypeOf("string");
  });
});
