/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * jev-reflex #25 B0 (backtest-plan X4, Major 12): the drafts-OFF parity golden. Captured from `dev`
 * BEFORE any B0 wire/code edit (`PI_TOOLKIT_REFLEX_PARITY_CAPTURE=1`; refuses to overwrite an existing
 * file) with a REAL `activate()` under `{reflex:{enabled:true, autoResolve:["jobs.list"]}}` — the one
 * gap `reflex-off-golden.json` cannot cover (`reflex.enabled=true ∧ drafts.enabled=false`).
 *
 * A fixed input sequence (builtin high shadow→settled, AUTO hit, miss, ambiguous, single-slot
 * replacement, correction, repeat, then `/reflex status`) runs through the full input chain on a
 * frozen clock (`toFake:["Date","performance"]` — wall time pinned to T0, monotonic deltas 0), and
 * ONLY the reflex-observable surface is recorded, so in-flight changes to other subsystems cannot
 * perturb this fixture: `appendEntry`/`sendMessage` calls whose customType starts with
 * `subagent:reflex`, `setStatus("reflex", …)`, `ctx.ui.notify` texts emitted by reflex
 * (`reflex:`/`reflex：` prefix), and the complete `/reflex status` output text.
 *
 * From B4 on, drafts-off runs must reproduce this byte for byte: the runtime draft loader must not
 * touch the builtin path. Never regenerate this to make a failing test pass — a diff means the
 * drafts-off surface changed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import activate from "../../src/index.js";
import { resetSecureDomainForTests } from "../../src/secure/domain.js";
import { BASELINE, fakeCtx, fakePi, emitAll, resetGlobals, sandbox } from "../integration/helpers/schedule-activate.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "fixtures", "reflex-drafts-off-parity.json");

/** Frozen wall clock (X4): every `at` is T0, every monotonic delta is 0. */
const T0 = 1_700_000_000_000;

/** The fixed question set (catalog strong/weak hits verified by the R1/R2 test corpus).
 *  Only SYNCHRONOUS in-memory ports (jobs.list / fleet.status) — never git.status, whose real
 *  child-process spawn would make the capture timing-dependent under load. */
const Q = {
  fleetShadow: "现在有哪些 agent 在跑", // fleet.status strong#3 — shadow (not in autoResolve)
  jobsAuto: "后台还有几个 job", // jobs.list strong#0 — AUTO (in autoResolve); also the repeat ask
  miss: "今天天气怎么样", // no strong, no weak — miss
  ambiguous: "后台任务和 subagent 都在跑吗", // jobs.list weak + fleet.status weak ⇒ ambiguous
  fleetReplaceA: "有几个 subagent 在跑", // fleet.status strong#0 — pending, then replaced before settle
  fleetReplaceB: "subagent 都在跑吗", // fleet.status strong#1 — replaces A in the single slot
  correction: "不对，说错了", // CORRECTION_RE hit on the fleet.status shadow memo
} as const;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setImmediate(r));
};
const userMsg = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const assistantText = { type: "message", message: { role: "assistant", content: [{ type: "text", text: "嗯" }] } };

interface ParityCapture {
  note: string;
  settings: { reflex: { enabled: boolean; autoResolve: string[] } };
  entries: Array<{ op: "appendEntry" | "sendMessage"; customType: string; data: unknown }>;
  statuses: Array<[string | undefined]>;
  notices: string[];
  statusText: string;
}

async function capture(): Promise<ParityCapture> {
  const sb = sandbox("pi-parity-");
  resetGlobals();
  resetSecureDomainForTests();
  try {
    sb.writeSettings({ ...BASELINE, reflex: { enabled: true, autoResolve: ["jobs.list"] } });
    const h = fakePi();
    /** Session branch the fake ctx serves — mirrors what pi would persist, fed back for `/reflex status`. */
    const branch: any[] = [];
    const appended: Array<{ customType: string; data: unknown }> = [];
    const sent: any[] = [];
    (h.pi as any).appendEntry = (customType: string, data: unknown) => {
      appended.push({ customType, data });
      if (customType.startsWith("subagent:reflex")) branch.push({ type: "custom", customType, data });
    };
    (h.pi as any).sendMessage = (message: any) => {
      sent.push(message);
      if (typeof message?.customType === "string" && message.customType.startsWith("subagent:reflex"))
        branch.push({ type: "custom_message", customType: message.customType, details: message.details });
    };
    activate(h.pi);
    const c = fakeCtx(sb.home);
    c.ctx.mode = "tui"; // R-I2: only interactive ∧ tui reaches S1
    c.ctx.sessionManager.getBranch = () => branch;
    const notices: string[] = [];
    const baseNotify = c.ctx.ui.notify;
    c.ctx.ui.notify = (m: unknown) => {
      if (typeof m === "string" && /^reflex[:：]/.test(m)) notices.push(m);
      baseNotify(m);
    };
    const input = (text: string): Promise<unknown[]> =>
      emitAll(h, "input", { type: "input", text, source: "interactive" }, c.ctx);
    const settled = (): Promise<unknown[]> => emitAll(h, "agent_settled", { aborted: false }, c.ctx);
    const turn = async (text: string): Promise<void> => {
      await input(text);
      branch.push(userMsg(text), assistantText);
    };

    await emitAll(h, "session_start", { type: "session_start", reason: "startup" }, c.ctx);

    // ① builtin high → shadow → settled (port runs off-path; sync in-memory fleet port)
    await input(Q.fleetShadow);
    await flush();
    branch.push(userMsg(Q.fleetShadow), assistantText);
    await settled();

    // ② AUTO hit — the only awaited branch; answers in-band, no record
    await turn(Q.jobsAuto);
    await flush();

    // ③ miss — no reflex surface at all
    await turn(Q.miss);

    // ④ ambiguous — single slot pending(ambiguous), settled as an unknown-agreement record
    await input(Q.ambiguous);
    branch.push(userMsg(Q.ambiguous), assistantText);
    await settled();

    // ⑤ single-slot replacement: A's slot is flushed (with its port) the moment B arrives
    await input(Q.fleetReplaceA);
    await flush();
    await input(Q.fleetReplaceB);
    await flush();
    branch.push(userMsg(Q.fleetReplaceB), assistantText);
    await settled();

    // ⑥ correction — CORRECTION_RE hit on the shadow memo left by ⑤, persisted synchronously
    await turn(Q.correction);

    // ⑦ repeat — the AUTO answer from ② re-asked within REPEAT_WINDOW_MS ⇒ demote + notify
    await input(Q.jobsAuto);
    branch.push(userMsg(Q.jobsAuto), assistantText);
    await settled();

    // ⑧ /reflex status — full output text on an isolated ctx (same branch)
    const cmdNotices: string[] = [];
    const cmd = h.commands.get("reflex") as any;
    await cmd.handler("status", {
      ...c.ctx,
      ui: { ...c.ctx.ui, notify: (m: unknown) => void cmdNotices.push(String(m)) },
    });

    return {
      note: "drafts-off parity golden captured at jev-reflex #25 B0 on dev before any wire.ts edit. Never regenerate to fix a diff.",
      settings: { reflex: { enabled: true, autoResolve: ["jobs.list"] } },
      entries: [
        ...appended
          .filter((a) => a.customType.startsWith("subagent:reflex"))
          .map((a) => ({ op: "appendEntry" as const, customType: a.customType, data: a.data })),
        ...sent.map((m) => ({
          op: "sendMessage" as const,
          customType: m.customType as string,
          data: { content: m.content, display: m.display, details: m.details },
        })),
      ],
      statuses: c.statuses.filter(([k]) => k === "reflex").map(([, v]) => [v]),
      notices,
      statusText: cmdNotices.join("\n"),
    };
  } finally {
    resetGlobals();
    resetSecureDomainForTests();
    sb.cleanup();
  }
}

describe("reflex drafts-off parity (jev-reflex #25 B0, backtest-plan X4)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it("matches the checked-in golden byte for byte", async () => {
    const actual = await capture();
    const serialized = `${JSON.stringify(actual, null, 2)}\n`;
    if (process.env.PI_TOOLKIT_REFLEX_PARITY_CAPTURE === "1" && !existsSync(FIXTURE)) {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, serialized);
    }
    expect(existsSync(FIXTURE), "parity golden missing — capture it BEFORE changing wire.ts").toBe(true);
    if (process.env.PARITY_DUMP !== undefined && process.env.PARITY_DUMP !== "")
      writeFileSync(process.env.PARITY_DUMP, serialized);
    expect(serialized).toBe(readFileSync(FIXTURE, "utf8"));
  });

  it("is deterministic across runs", async () => {
    const first = await capture();
    expect(`${JSON.stringify(first, null, 2)}\n`).toBe(`${JSON.stringify(await capture(), null, 2)}\n`);
  });

  it("records the full sequence: 5 records + 1 correction + 1 answer, AUTO-only answer, repeat demote", async () => {
    const c = await capture();
    const records = c.entries.filter((e) => e.customType === "subagent:reflex-record");
    const corrections = c.entries.filter((e) => e.customType === "subagent:reflex-correction");
    const answers = c.entries.filter((e) => e.op === "sendMessage");
    expect(records.map((r) => (r.data as any).kind)).toEqual(["shadow", "ambiguous", "shadow", "shadow", "repeat"]);
    expect(corrections).toHaveLength(1);
    expect(answers).toHaveLength(1);
    // builtin records carry NO draft-era fields (BD11: nothing is ever written for builtin rows)
    for (const r of records)
      for (const key of ["origin", "draftHash", "templateHash"] as const)
        expect((r.data as any)[key], key).toBeUndefined();
    expect(c.notices.length).toBe(1);
    expect(c.notices[0]).toContain("jobs.list");
    expect(c.statusText).toContain("reflex: enabled");
    expect(c.statusText).toContain("jobs.list demoted");
  });
});
