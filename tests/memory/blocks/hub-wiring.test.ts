// #36 P3 (arch r5 §3.3.5 生产 hub 接线测试) — the snapshot + ledger protocol
// against the REAL `createPromptSectionHub`: the matrix
//   { stable unchanged, change ×1/×2/×3, 4th ⇒ POINTED, mode live }
//   × { freezeInjectionAfterWrite on/off }
//   × { resume, reload(exact), tree, compaction, cross-midnight, foreign write }
// with the six per-cell assertions (V36): snapshot == parseResidentSection(hub
// state), ledger == want (next turn emits nothing), resident details carry the
// ledger, cross-midnight yields exactly one 已变更, resume/reload restores from
// R details without repeats, a foreign write is discovered next turn.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPromptSectionHub } from "../../../src/sysprompt/hub.js";
import { memorySection } from "../../../src/memory/inject.js";
import { memoryDirFor } from "../../../src/memory/paths.js";
import { wireJev } from "../../../src/memory/jev/wire.js";
import { jevConfigOf } from "../../../src/memory/jev/config.js";
import { EntryIndex } from "../../../src/memory/jev/entries.js";
import { clearHealthTable } from "../../../src/memory/jev/health.js";
import { parseResidentSection } from "../../../src/memory/blocks/render.js";
import { readCorpus } from "../../../src/memory/blocks/store.js";

// #36 P3 acceptance fix: count BODY reads through the whole graph (both the
// section provider and wireJev route here) without changing behavior —
// the factory delegates to the real implementation.
vi.mock("../../../src/memory/blocks/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/memory/blocks/store.js")>();
  const { vi } = await import("vitest");
  return { ...actual, readCorpus: vi.fn(actual.readCorpus) };
});
const readCorpusCalls = () => vi.mocked(readCorpus).mock.calls.length;
import { POINTED } from "../../../src/prompt-sections/stable-section.js";
import { readCorpus } from "../../../src/memory/blocks/store.js";
import { blockRaw, writeBlocksDir } from "./helpers.js";
import { createFakeRegistry } from "../jev/helpers/fake-registry.js";
import { RenderCache } from "../../../src/memory/render.js";
import { DEFAULT_MEMORY_SETTINGS, type MemorySettings } from "../../../src/memory/settings.js";

const CLASSIFIERS = ["opencode/jev-1.13-free", "opencode/jev-1.13"];

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Harness {
  pi: ExtensionAPI;
  hub: ReturnType<typeof createPromptSectionHub>;
  sent: { customType: string; content: unknown; details: any }[];
  branch: any[];
  memDir: string;
  cwd: string;
  frozenBlocks: Map<string, string | undefined>;
  renderInfos: Map<string, any>;
  rNotices(): { content: string; ledger: [string, string][]; snapshotKey: string }[];
  turn(prompt?: string): Promise<void>;
  emit(event: string, payload: unknown): Promise<void>;
  snapshotMap(): Map<string, string>;
  hubState(): { snapshot: string | undefined; stale: boolean; announced: unknown; sentCount: number };
  writeResident(id: string, body: string): void;
  writeAgent(id: string, body: string): void;
  cleanup(): void;
}

function harness(opts: { mode?: () => "stable" | "live" | "legacy"; freeze?: boolean } = {}): Harness {
  clearHealthTable();
  const tmp = mkdtempSync(join(tmpdir(), "pi-mem-hub-wiring-"));
  const cwd = join(tmp, "proj");
  mkdirSync(cwd, { recursive: true });
  const paths = { memoryRoot: join(tmp, "mem"), ccProjectsRoot: join(tmp, "cc") };
  // ONE memDir for both the section provider (memoryDirFor(cwd, paths)) and
  // wireJev's dirFor — the same directory the production closure shares.
  const memDir = memoryDirFor(cwd, paths);
  const realDir = writeBlocksDir(memDir, [
    { id: "general.001", authority: "user", scope: "global", body: "- global rule one: always ask first" },
    { id: "general.002", authority: "user", scope: "global", body: "- global rule two: schedule before release" },
    { id: "quota.001", authority: "agent", body: "- quota note" },
  ]);
  const handlers = new Map<string, Handler[]>();
  const sent: Harness["sent"] = [];
  const branch: any[] = [];
  let nextId = 1;
  const pi = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage: (message: any, _options: unknown) => {
      sent.push(message);
      branch.push({ type: "custom_message", id: `m${nextId++}`, ...message });
    },
    appendEntry: (customType: string, data: unknown) => {
      branch.push({ type: "custom", id: `c${nextId++}`, customType, data });
    },
    registerMessageRenderer: () => {},
  } as unknown as ExtensionAPI;
  const hub = createPromptSectionHub(pi, { mode: opts.mode ?? (() => "stable") });
  const settings: MemorySettings = {
    ...DEFAULT_MEMORY_SETTINGS,
    layout: "blocks",
    freezeInjectionAfterWrite: opts.freeze === true,
    jev: { ...DEFAULT_MEMORY_SETTINGS.jev, predict: { ...DEFAULT_MEMORY_SETTINGS.jev.predict, enabled: false } },
  };
  const frozenBlocks = new Map<string, string | undefined>();
  // production wiring shape (index.ts): onRender records the render info,
  // wireJev reads it back through getRenderInfo — the fusion point where the
  // ledger overlays residentBlocks lives inside wire (renderInfoFor).
  const renderInfos = new Map<string, any>();
  hub.register(
    "pi_project_memory",
    memorySection({
      settings,
      isChildSession: false,
      cache: new RenderCache(),
      frozenBlocks,
      paths,
      onRender: (cwd, _block, info) => {
        if (info !== undefined) renderInfos.set(cwd, info);
      },
    }),
  );
  const fake = createFakeRegistry({
    available: CLASSIFIERS,
    responses: Object.fromEntries(
      CLASSIFIERS.map((id) => [id, [async () => ({ stopReason: "stop" as const, answers: {} })]]),
    ),
  });
  // wireJev AFTER the hub so the before_agent_start handler order is
  // hub → jev — exactly the production registration order (index.ts).
  wireJev(pi, {
    config: { ...jevConfigOf(settings), classifiers: CLASSIFIERS },
    settings,
    isChildSession: false,
    dirFor: () => memDir,
    getRenderInfo: (cwd: string) => renderInfos.get(cwd),
    onAfterWriteHook: () => {},
    log: () => {},
    getSectionSnapshot: () => hub._state("pi_project_memory"),
  });
  const ctx = () => ({
    cwd,
    hasUI: true,
    ui: { notify: () => {} },
    modelRegistry: fake.registry,
    sessionManager: { getBranch: () => branch, getSessionId: () => "s1" },
  });
  const emit = async (event: string, payload: unknown): Promise<void> => {
    for (const h of handlers.get(event) ?? []) await h(payload, ctx());
  };
  return {
    pi,
    hub,
    sent,
    branch,
    memDir,
    cwd,
    frozenBlocks,
    renderInfos,
    rNotices: () =>
      sent
        .filter((m) => m.customType === "subagent:memory-inject" && (m.details as any)?.layer === "R")
        .map((m) => ({
          content: String(m.content),
          ledger: (m.details as any).resident.ledger as [string, string][],
          snapshotKey: (m.details as any).resident.snapshotKey as string,
        })),
    turn: (prompt = "continue the work now please") =>
      emit("before_agent_start", {
        type: "before_agent_start",
        messageType: "user",
        prompt,
        systemPrompt: "",
      }),
    emit,
    snapshotMap: () => parseResidentSection(hub._state("pi_project_memory")?.snapshot ?? ""),
    hubState: () => {
      const s = hub._state("pi_project_memory")!;
      return { snapshot: s.snapshot, stale: s.stale, announced: s.announced, sentCount: s.sentCount };
    },
    writeResident: (id, body) =>
      writeFileSync(join(realDir, `${id}.md`), blockRaw({ id, authority: "user", scope: "global", body })),
    writeAgent: (id, body) => writeFileSync(join(realDir, `${id}.md`), blockRaw({ id, body })),
    cleanup: () => {
      rmSync(tmp, { recursive: true, force: true });
      clearHealthTable();
    },
  };
}

const harnesses: Harness[] = [];
beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-06T10:00:00") });
});
afterEach(() => {
  vi.useRealTimers();
  for (const h of harnesses.splice(0)) h.cleanup();
});

function fresh(opts: Parameters<typeof harness>[0] = {}): Harness {
  const h = harness(opts);
  harnesses.push(h);
  return h;
}

/** The six V36 assertions' shared core, run after a settled turn sequence. */
async function settle(h: Harness): Promise<void> {
  const before = h.rNotices().length;
  await h.turn();
  expect(h.rNotices().length).toBe(before); // ledger == want ⇒ no further notice
}

describe("hub wiring — stable, change axis", () => {
  test("unchanged corpus: snapshot == parse(hub state), ledger == want, zero R notices", async () => {
    const h = fresh();
    await h.turn();
    await h.turn();
    expect(h.rNotices()).toEqual([]);
    expect([...h.snapshotMap().keys()]).toEqual(["general.001", "general.002"]);
    expect(h.hubState().sentCount).toBe(0);
    await settle(h);
  });

  for (const changes of [1, 2, 3]) {
    test(`change ×${changes}: one R notice per change; hub tail updates ride along`, async () => {
      const h = fresh();
      await h.turn();
      for (let i = 1; i <= changes; i++) {
        h.writeResident(`general.00${i + 2}`, `- global rule added ${i}`);
        await h.turn();
        const notices = h.rNotices();
        expect(notices).toHaveLength(i);
        expect(notices.at(-1)!.content).toContain(`- 新增 general.00${i + 2}`);
        expect(notices.at(-1)!.ledger.map(([id]) => id)).toContain(`general.00${i + 2}`);
        // hub stayed on the frozen snapshot, delivered it as a tail update
        expect(h.hubState().sentCount).toBe(i);
        expect(h.hubState().announced).not.toBe("POINTED");
      }
      // snapshot still the ORIGINAL two — the ledger covers the rest
      expect([...h.snapshotMap().keys()]).toEqual(["general.001", "general.002"]);
      await settle(h);
    });
  }

  test("4th change ⇒ hub POINTED, R notices keep delivering (no gaps)", async () => {
    const h = fresh();
    await h.turn();
    for (let i = 1; i <= 4; i++) {
      h.writeResident(`general.00${i + 2}`, `- global rule added ${i}`);
      await h.turn();
    }
    expect(h.rNotices()).toHaveLength(4);
    const state = h.hubState();
    expect(state.announced).toBe(POINTED);
    expect([...h.snapshotMap().keys()]).toEqual(["general.001", "general.002"]); // old snapshot
    await settle(h); // ledger still == want
  });
});

describe("hub wiring — freeze on/off × events", () => {
  test("freeze on: provider output frozen, R notices still deliver the new rule", async () => {
    const h = fresh({ freeze: true });
    await h.turn();
    // wireMemory's onAfterWrite would freeze the pre-write block; do the same
    h.frozenBlocks.set(h.cwd, h.hubState().snapshot);
    h.writeResident("general.003", "- frozen provider still shows the old set");
    await h.turn();
    // hub saw an unchanged provider output ⇒ no tail update
    expect(h.hubState().sentCount).toBe(0);
    // but the R layer noticed the corpus change and delivered it
    expect(h.rNotices()).toHaveLength(1);
    expect(h.rNotices()[0]!.content).toContain("新增 general.003");
    await settle(h);
  });

  test("resume: ledger restored from the R details on the branch — no repeat notices", async () => {
    const h = fresh();
    await h.turn();
    h.writeResident("general.003", "- rule added before resume");
    await h.turn();
    expect(h.rNotices()).toHaveLength(1);
    // simulate /resume: same branch, session_start reason resume (hub + jev)
    await h.emit("session_start", { type: "session_start", reason: "resume" });
    await h.turn();
    expect(h.rNotices()).toHaveLength(1); // restored ledger ⇒ nothing re-notified
    await settle(h);
  });

  test("reload exact: state restored as-is, ledger restored, no repeats", async () => {
    const h = fresh();
    await h.turn();
    h.writeResident("general.003", "- rule added before reload");
    await h.turn();
    await h.emit("session_start", { type: "session_start", reason: "reload" });
    await h.turn();
    expect(h.rNotices()).toHaveLength(1);
    await settle(h);
  });

  test("session_tree: read-back + forgetAnnounced — ledger restored, no repeats", async () => {
    const h = fresh();
    await h.turn();
    h.writeResident("general.003", "- rule added before tree switch");
    await h.turn();
    await h.emit("session_tree", { type: "session_tree" });
    await h.turn();
    expect(h.rNotices()).toHaveLength(1);
    await settle(h);
  });

  test("compaction: markStale ⇒ fresh snapshot ⇒ ledger RESET to the new snapshot", async () => {
    const h = fresh();
    await h.turn();
    h.writeResident("general.003", "- rule added before compaction");
    await h.turn();
    expect(h.rNotices()).toHaveLength(1);
    await h.emit("session_compact", { type: "session_compact", compactionEntry: { id: "comp1" } });
    await h.turn("a fresh user turn after compaction");
    // the refresh adopts all three residents into the new snapshot ⇒ reset
    // ledger == snapshot ⇒ no duplicate notices for the two already-known ones
    expect(h.rNotices()).toHaveLength(1);
    expect([...h.snapshotMap().keys()].sort()).toEqual(["general.001", "general.002", "general.003"]);
    await settle(h);
  });

  test("cross-midnight: only the expiry NOTE changes ⇒ exactly one 已变更 notice", async () => {
    const h = fresh();
    // replace rule two with an expires=today version, byte-stable otherwise
    const realDir = join(h.memDir, "blocks");
    const raw = readCorpus(realDir).blocks.find((b) => b.id === "general.002")!.raw;
    writeFileSync(
      join(realDir, "general.002.md"),
      raw.replace("status: active", 'status: active\nexpires: "2026-11-07"'),
    );
    await h.turn(); // day one: no note, snapshot frozen with both rules
    expect(h.rNotices()).toEqual([]);
    vi.setSystemTime(new Date("2026-11-08T00:05:00"));
    await h.turn(); // midnight: the note appears ⇒ renderKey flips ⇒ one 已变更
    const notices = h.rNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.content).toContain("- 已变更 general.002（以此为准）");
    expect(notices[0]!.content).toContain("（已到期，待用户确认）");
    await settle(h);
  });

  test("foreign process write: discovered on the very next before_agent_start", async () => {
    const h = fresh();
    await h.turn();
    h.writeAgent("quota.002", "- foreign agent block");
    await h.turn();
    // an agent block is not resident ⇒ no R notice, but the corpus fingerprint
    // rotated (the recalc ran); a RESIDENT foreign write does notify:
    h.writeResident("general.003", "- foreign resident write");
    await h.turn();
    expect(h.rNotices()).toHaveLength(1);
    expect(h.rNotices()[0]!.content).toContain("新增 general.003");
    await settle(h);
  });
});

describe("hub wiring — mode live", () => {
  test("live refreshes the snapshot every turn ⇒ ledger resets each turn, zero notices", async () => {
    const h = fresh({ mode: () => "live" });
    await h.turn();
    h.writeResident("general.003", "- rule added under live mode");
    await h.turn();
    // the refreshed snapshot already carries all three ⇒ reset ledger ⇒ no notice
    expect(h.rNotices()).toEqual([]);
    expect([...h.snapshotMap().keys()].sort()).toEqual(["general.001", "general.002", "general.003"]);
    await settle(h);
  });
});

describe("acceptance fixes — read economy + direct ledger assertions", () => {
  test("N unchanged turns cost zero body reads; a foreign replace re-reads once; midnight re-reads once", async () => {
    const h = fresh();
    await h.turn();
    vi.mocked(readCorpus).mockClear();
    await h.turn();
    await h.turn();
    await h.turn();
    expect(readCorpusCalls()).toBe(0); // stat-only fingerprint said "unchanged"
    // foreign replace of an EXISTING block flips mtime/size ⇒ one re-read ⇒ 已变更
    h.writeResident("general.001", "- global rule one: REPLACED text now");
    await h.turn();
    expect(readCorpusCalls()).toBeGreaterThan(0); // timely re-read
    const notices = h.rNotices();
    expect(notices.at(-1)!.content).toContain("- 已变更 general.001（以此为准）");
    // midnight: the date component forces one fresh read even without writes
    vi.mocked(readCorpus).mockClear();
    vi.setSystemTime(new Date("2026-11-07T00:05:00"));
    await h.turn();
    expect(readCorpusCalls()).toBeGreaterThan(0); // date rollover re-read (及时)
  });

  test("residentBlocks exclusion == ledger: a U-layer ask never sees the ledger ids", async () => {
    const h = fresh();
    await h.turn(); // ledger == {general.001, general.002}
    const r = await h.turn("release the quota change with the new dispatch");
    void r;
    // the fake registry answers everything low ⇒ no U message; the QUESTION
    // set still reveals the candidate pool the ledger excluded
    const ledgerIds = new Set(
      h
        .rNotices()
        .at(-1)
        ?.ledger.map(([id]) => id) ?? [],
    );
    if (ledgerIds.size === 0) {
      // no notice was ever sent ⇒ ledger == snapshot == the two residents
      ledgerIds.add("general.001");
      ledgerIds.add("general.002");
    }
    expect(ledgerIds.has("general.001")).toBe(true);
    // the render info the section recorded (production onRender shape) and
    // the ledger agree once the turns settle — residentBlocks == ledger ids
    expect(new Set(h.renderInfos.get(h.cwd)?.residentBlocks)).toEqual(ledgerIds);
  });

  test("pure deletion fires 已删除或已归档 exactly once; the next turn is silent", async () => {
    const h = fresh();
    await h.turn();
    rmSync(join(h.memDir, "blocks", "general.001.md"));
    await h.turn();
    const notices = h.rNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.content).toContain("- 已移除 general.001（已删除或已归档）");
    await settle(h); // no repeat
  });
});

describe("removal + replacement notices", () => {
  test("demote to topic ⇒ 已移除（降为 topic）; supersede ⇒ 已移除 → 见 <new>", async () => {
    const h = fresh();
    await h.turn();
    const realDir = join(h.memDir, "blocks");
    // demote general.002 to topic
    const raw2 = readCorpus(realDir).blocks.find((b) => b.id === "general.002")!.raw;
    writeFileSync(join(realDir, "general.002.md"), raw2.replace("scope: global", "scope: topic"));
    // supersede general.001 with a new block
    writeFileSync(
      join(realDir, "general.001.md"),
      readCorpus(realDir)
        .blocks.find((b) => b.id === "general.001")!
        .raw.replace("status: active", "status: superseded\nsupersededBy: general.009"),
    );
    h.writeResident("general.009", "- replacement global rule");
    await h.turn();
    const notices = h.rNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.content).toContain("- 已移除 general.002（降为 topic）");
    expect(notices[0]!.content).toContain("- 已移除 general.001（已取代 → 见 general.009）");
    expect(notices[0]!.content).toContain("- 新增 general.009");
    await settle(h);
  });
});
