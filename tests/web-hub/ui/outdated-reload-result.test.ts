/**
 * #30 P-U：agent 回传的 reload 结果（status.reload）被 #23 状态机吸收。
 * 覆盖 plan 验收矩阵 U1–U11（前端归属行）：rev 去重 + 固定 effectDeadline、跨 attempt/TUI 来源
 * 忽略、deferred/started 换相、IDLE_WAIT 与总截止的确定性竞态、LOST/NO_UPGRADE/completed、
 * failed 相规则（Q4）、老 agent 无 reload 字段 ⇒ #23 行为、parseReloadStatus 防御、
 * 真实 reduce + composable 端到端。
 */
import { nextTick, ref } from "vue";
import { describe, expect, it } from "vitest";
import {
  createOrCoordinator,
  OR_EFFECT_TIMEOUT_MS,
  OR_QUEUE_TIMEOUT_MS,
  orFailReason,
  parseReloadStatus,
  type OrEntry,
  type ReloadStatus,
} from "../../../src/web-hub/ui/src/logic/outdatedReload.js";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";
import { useOutdatedReload } from "../../../src/web-hub/ui/src/composables/useOutdatedReload.js";
import type { CmdOutcome, ControlHandle, HubHandle } from "../../../src/web-hub/ui/src/types.js";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function fact(over: Partial<ReloadStatus> & Pick<ReloadStatus, "rev" | "state">): ReloadStatus {
  return { v: 1, life: "L1", cmdIds: [], execId: "E1", open: true, at: 1, ...over } as ReloadStatus;
}

function harness(opts: { hubVersion?: string | undefined } = {}) {
  let now = 1_000_000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextTimer = 1;
  const w = {
    fleet: 0,
    settled: false,
    offline: false,
    outcome: undefined as ReloadStatus | undefined,
    sent: [] as string[],
    cancels: 0,
    resolveSend: undefined as undefined | ((r: { ok: boolean }) => void),
  };
  let idSeq = 0;
  const hubVersion = "hubVersion" in opts ? opts.hubVersion : "1.0.0";
  const coord = createOrCoordinator({
    mainBusy: () => false,
    fleetActive: () => w.fleet,
    precheck: () => "ok",
    isSettled: () => w.settled,
    offline: () => w.offline,
    now: () => now,
    newCmdId: () => `cmd-${++idSeq}`,
    reloadOutcome: () => w.outcome,
    hubVersion: () => hubVersion,
    send: (_k, cmdId) => {
      w.sent.push(cmdId);
      return new Promise((res) => {
        w.resolveSend = res;
      });
    },
    sendCancel: () => {
      w.cancels += 1;
      return Promise.resolve(true);
    },
    setTimeout: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h) => void timers.delete(h as number),
  });
  function advance(ms: number): void {
    const target = now + ms;
    for (;;) {
      let nextId: number | undefined;
      let nextAt = Infinity;
      for (const [id, t] of timers) if (t.at <= target && t.at < nextAt) [nextId, nextAt] = [id, t.at];
      if (nextId === undefined) break;
      const t = timers.get(nextId)!;
      timers.delete(nextId);
      now = Math.max(now, t.at);
      t.fn();
    }
    now = target;
  }
  const warp = (ms: number): void => void (now += ms);
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  /** 注入事实（cmdIds 默认含当前 attempt）并 tick。 */
  function emit(f: ReloadStatus, ids: string[] = [w.sent[w.sent.length - 1]!]): void {
    w.outcome = { ...f, cmdIds: ids };
    coord.notifyTick();
  }
  /** request + send 解决（ok）。 */
  async function start(): Promise<void> {
    coord.request("k");
    await flush();
    w.resolveSend?.({ ok: true });
    await flush();
  }
  const entry = (): OrEntry => coord.entryOf("k");
  return { coord, w, advance, warp, flush, emit, start, entry };
}

// ---------------------------------------------------------------------------

describe("#30 U1：started 去重 + 固定 effectDeadline", () => {
  it("同一 started 补发多次（rev 相同 / rev 递增）叠加 tick，effectDeadline 只建立一次，到点 E_TIMEOUT", async () => {
    const h = harness();
    await h.start();
    h.emit(fact({ rev: 1, state: "started" }));
    expect(h.entry().phase).toBe("awaiting");
    for (let i = 0; i < 80; i++) {
      h.advance(1_000);
      h.emit(fact({ rev: i < 40 ? 1 : 2, state: "started" }));
    }
    // 80s 时仍 awaiting（重复 started 没有重开 90s）
    expect(h.entry().phase).toBe("awaiting");
    h.advance(10_000);
    expect(h.entry()).toMatchObject({ phase: "failed", error: "E_TIMEOUT" });
  });

  it("sending 相收到 started 直接 awaiting，并清掉 send 计时（60s 不再报 E_SEND_UNKNOWN）", async () => {
    const h = harness();
    h.coord.request("k");
    await h.flush();
    expect(h.entry().phase).toBe("sending");
    h.emit(fact({ rev: 1, state: "started" }));
    expect(h.entry().phase).toBe("awaiting");
    h.advance(70_000);
    expect(h.entry().phase).toBe("awaiting");
    h.w.resolveSend?.({ ok: true }); // 迟到的 HTTP 成功不改变相
    await h.flush();
    expect(h.entry().phase).toBe("awaiting");
  });
});

describe("#30 U2：跨 attempt / 非本请求来源被忽略", () => {
  it("attempt1 的 cancelled 迟到、TUI 来源（cmdIds 不含本 attempt）都不生效", async () => {
    const h = harness();
    await h.start();
    const first = h.w.sent[0]!;
    h.w.offline = true;
    h.coord.notifyTick();
    expect(h.entry()).toMatchObject({ phase: "failed", error: "E_OFFLINE" });
    h.w.offline = false;
    h.coord.request("k"); // attempt2
    await h.flush();
    h.w.resolveSend?.({ ok: true });
    await h.flush();
    expect(h.w.sent).toHaveLength(2);
    h.emit(fact({ rev: 5, state: "cancelled", open: false, code: "user" }), [first]);
    expect(h.entry().phase).toBe("awaiting");
    h.emit(fact({ rev: 6, state: "failed", code: "E_RELOAD_REFUSED" }), ["tui-someone"]);
    expect(h.entry().phase).toBe("awaiting");
  });
});

describe("#30 U3/U4：deferred ⇒ parked，不再按 fleet 回 awaiting", () => {
  it("sending 期间收到 deferred ⇒ parked 并清 send 计时；waitingFor 透传", async () => {
    const h = harness();
    h.coord.request("k");
    await h.flush();
    h.emit(fact({ rev: 1, state: "deferred", waitingFor: "idle" }));
    expect(h.entry()).toMatchObject({ phase: "parked", waitingFor: "idle" });
    h.advance(120_000);
    expect(h.entry().phase).toBe("parked");
  });

  it("deferred(idle) 持续到总截止：无 90s 误判；到截止先 cancel 再 E_QUEUE_TIMEOUT", async () => {
    const h = harness();
    await h.start();
    h.emit(fact({ rev: 1, state: "deferred", waitingFor: "idle" }));
    h.w.fleet = 0; // fleet 空也不回 awaiting（事实接管）
    h.coord.notifyTick();
    h.advance(OR_EFFECT_TIMEOUT_MS * 3);
    expect(h.entry().phase).toBe("parked");
    h.advance(OR_QUEUE_TIMEOUT_MS);
    expect(h.entry()).toMatchObject({ phase: "failed", error: "E_QUEUE_TIMEOUT" });
    expect(h.w.cancels).toBe(1);
  });
});

describe("#30 U5：IDLE_WAIT 与总截止的确定性竞态 / Q3", () => {
  it("IDLE_WAIT 先到：立即失败、不立刻 cancel；到总截止时 cancel 恰好一次，原因仍 E_RELOAD_IDLE_WAIT", async () => {
    const h = harness();
    await h.start();
    h.emit(fact({ rev: 1, state: "deferred", waitingFor: "idle" }));
    h.advance(10 * 60_000);
    h.emit(fact({ rev: 2, state: "failed", code: "E_RELOAD_IDLE_WAIT", open: true }));
    expect(h.entry()).toMatchObject({ phase: "failed", error: "E_RELOAD_IDLE_WAIT" });
    expect(h.w.cancels).toBe(0);
    h.advance(OR_QUEUE_TIMEOUT_MS);
    expect(h.w.cancels).toBe(1);
    expect(h.entry()).toMatchObject({ phase: "failed", error: "E_RELOAD_IDLE_WAIT" });
    // 我方 cancel 之后迟到的 cancelled user 不再细化
    h.emit(fact({ rev: 3, state: "cancelled", open: false, code: "user" }));
    expect(h.entry()).toMatchObject({ error: "E_RELOAD_IDLE_WAIT" });
    expect(h.w.cancels).toBe(1);
  });

  it("顺序 A：总截止回调先处理（事实已在 outcome 里）⇒ cancel 一次、原因 E_RELOAD_IDLE_WAIT", async () => {
    const h = harness();
    await h.start();
    h.emit(fact({ rev: 1, state: "deferred", waitingFor: "idle" }));
    h.w.outcome = { ...fact({ rev: 2, state: "failed", code: "E_RELOAD_IDLE_WAIT" }), cmdIds: [h.w.sent[0]!] };
    h.advance(OR_QUEUE_TIMEOUT_MS); // 不先 tick：timer 回调自己先吸收
    expect(h.entry()).toMatchObject({ phase: "failed", error: "E_RELOAD_IDLE_WAIT" });
    expect(h.w.cancels).toBe(1);
  });

  it("顺序 B：计时器先结算 E_QUEUE_TIMEOUT，随后 IDLE_WAIT 到达 ⇒ 细化为 E_RELOAD_IDLE_WAIT，不再 cancel", async () => {
    const h = harness();
    await h.start();
    h.emit(fact({ rev: 1, state: "deferred", waitingFor: "idle" }));
    h.advance(OR_QUEUE_TIMEOUT_MS);
    expect(h.entry()).toMatchObject({ error: "E_QUEUE_TIMEOUT" });
    expect(h.w.cancels).toBe(1);
    h.emit(fact({ rev: 2, state: "failed", code: "E_RELOAD_IDLE_WAIT" }));
    expect(h.entry()).toMatchObject({ error: "E_RELOAD_IDLE_WAIT" });
    expect(h.w.cancels).toBe(1);
  });

  it("IDLE_WAIT 后总截止已过（warp，计时器未触发）同 tick 吸收 ⇒ 立即恰好一次 cancel", async () => {
    const h = harness();
    await h.start();
    h.emit(fact({ rev: 1, state: "deferred", waitingFor: "idle" }));
    h.warp(OR_QUEUE_TIMEOUT_MS + 1);
    h.emit(fact({ rev: 2, state: "failed", code: "E_RELOAD_IDLE_WAIT" }));
    expect(h.entry()).toMatchObject({ error: "E_RELOAD_IDLE_WAIT" });
    expect(h.w.cancels).toBe(1);
    h.advance(1_000);
    expect(h.w.cancels).toBe(1);
  });

  it("IDLE_WAIT 后后端已 open:false 结束（cancelled）⇒ 到点不再 cancel；retry 清掉 cancelAt", async () => {
    const h = harness();
    await h.start();
    h.emit(fact({ rev: 1, state: "failed", code: "E_RELOAD_IDLE_WAIT", open: true }));
    h.emit(fact({ rev: 2, state: "cancelled", open: false, code: "user" }));
    h.advance(OR_QUEUE_TIMEOUT_MS + 1_000);
    expect(h.w.cancels).toBe(0);
    const h2 = harness();
    await h2.start();
    h2.emit(fact({ rev: 1, state: "failed", code: "E_RELOAD_IDLE_WAIT", open: true }));
    h2.coord.request("k"); // retry
    await h2.flush();
    h2.advance(OR_QUEUE_TIMEOUT_MS - 1_000);
    expect(h2.w.cancels).toBe(0);
  });
});

describe("#30 U6/U7：LOST、completed、NO_UPGRADE", () => {
  it("started 后下线 ⇒ E_RELOAD_LOST；随后同 key completed(version==hub) ⇒ done", async () => {
    const h = harness();
    await h.start();
    h.emit(fact({ rev: 1, state: "started" }));
    h.w.offline = true;
    h.coord.notifyTick();
    expect(h.entry()).toMatchObject({ phase: "failed", error: "E_RELOAD_LOST" });
    h.w.offline = false;
    h.emit(fact({ rev: 2, state: "completed", open: false, version: "1.0.0", epoch: "ep2" }));
    expect(h.entry().phase).toBe("done");
  });

  it("未吸收 started 就下线 ⇒ E_OFFLINE；deferred 后下线同样 E_OFFLINE", async () => {
    const h = harness();
    await h.start();
    h.emit(fact({ rev: 1, state: "deferred", waitingFor: "runs" }));
    h.w.offline = true;
    h.coord.notifyTick();
    expect(h.entry()).toMatchObject({ error: "E_OFFLINE" });
  });

  it("completed 版本不等于 hub ⇒ E_RELOAD_NO_UPGRADE", async () => {
    const h = harness();
    await h.start();
    h.emit(fact({ rev: 1, state: "completed", open: false, version: "0.9.0", epoch: "ep2" }));
    expect(h.entry()).toMatchObject({ phase: "failed", error: "E_RELOAD_NO_UPGRADE" });
  });

  it("completed 缺 epoch / 缺 version / hub 版本未知 ⇒ 按未知处理（不判 done 也不判 NO_UPGRADE），等版本或生效计时", async () => {
    for (const over of [{ version: "0.9.0" }, { epoch: "e" }, {}] as const) {
      const h = harness();
      await h.start();
      h.emit(fact({ rev: 1, state: "completed", open: false, ...over }));
      expect(h.entry().phase).toBe("awaiting");
      h.advance(OR_EFFECT_TIMEOUT_MS + 1);
      expect(h.entry()).toMatchObject({ error: "E_TIMEOUT" });
    }
    const h = harness({ hubVersion: undefined });
    await h.start();
    h.emit(fact({ rev: 1, state: "completed", open: false, version: "1.0.0", epoch: "e" }));
    expect(h.entry().phase).toBe("awaiting");
  });

  it("failed 事实带 message ⇒ 直出；cancelled ⇒ E_RELOAD_CANCELLED 且不发 cancel", async () => {
    const h = harness();
    await h.start();
    h.emit(fact({ rev: 1, state: "failed", code: "E_RELOAD_THREW", open: false, message: "boom" }));
    expect(h.entry()).toMatchObject({ error: "E_RELOAD_THREW", message: "boom" });
    expect(orFailReason(h.entry())).toEqual({ raw: "boom" });
    const c = harness();
    await c.start();
    c.emit(fact({ rev: 1, state: "cancelled", open: false, code: "superseded" }));
    expect(c.entry()).toMatchObject({ error: "E_RELOAD_CANCELLED" });
    expect(c.w.cancels).toBe(0);
  });
});

describe("#30 U8：failed 相规则（Q4）", () => {
  it("迟到的 deferred/started 不复活；E_OFFLINE 后收到 failed/cancelled 细化", async () => {
    const h = harness();
    await h.start();
    h.w.offline = true;
    h.coord.notifyTick();
    expect(h.entry().error).toBe("E_OFFLINE");
    h.emit(fact({ rev: 1, state: "deferred" }));
    h.emit(fact({ rev: 2, state: "started" }));
    expect(h.entry()).toMatchObject({ phase: "failed", error: "E_OFFLINE" });
    h.emit(fact({ rev: 3, state: "failed", code: "E_RELOAD_REFUSED", open: false }));
    expect(h.entry()).toMatchObject({ error: "E_RELOAD_REFUSED" });
    // 已有 E_RELOAD_* 不再细化
    h.emit(fact({ rev: 4, state: "cancelled", open: false }));
    expect(h.entry()).toMatchObject({ error: "E_RELOAD_REFUSED" });
  });

  it("E_TIMEOUT 后迟到 cancelled ⇒ E_RELOAD_CANCELLED；迟到 completed ⇒ done", async () => {
    const h = harness();
    await h.start();
    h.advance(OR_EFFECT_TIMEOUT_MS + 1);
    expect(h.entry().error).toBe("E_TIMEOUT");
    h.emit(fact({ rev: 1, state: "cancelled", open: false }));
    expect(h.entry().error).toBe("E_RELOAD_CANCELLED");
    h.emit(fact({ rev: 2, state: "completed", open: false, version: "1.0.0", epoch: "e" }));
    expect(h.entry().phase).toBe("done");
  });

  it("非 E_RELOAD_* 的 failed code 不用于细化", async () => {
    const h = harness();
    await h.start();
    h.w.offline = true;
    h.coord.notifyTick();
    h.emit(fact({ rev: 1, state: "failed", code: "weird" }));
    expect(h.entry().error).toBe("E_OFFLINE");
  });
});

describe("#30 U9：老 agent（无 status.reload）⇒ #23 行为", () => {
  it("没有 reloadOutcome 事实：fleet 启发式照旧（parked ⇄ awaiting 重开 90s）", async () => {
    const h = harness();
    await h.start();
    expect(h.entry().phase).toBe("awaiting");
    h.w.fleet = 1;
    h.coord.notifyTick();
    expect(h.entry().phase).toBe("parked");
    h.w.fleet = 0;
    h.coord.notifyTick();
    expect(h.entry().phase).toBe("awaiting");
    h.advance(OR_EFFECT_TIMEOUT_MS + 1);
    expect(h.entry().error).toBe("E_TIMEOUT");
  });

  it("下线（无事实）⇒ E_OFFLINE，不是 LOST", async () => {
    const h = harness();
    await h.start();
    h.w.offline = true;
    h.coord.notifyTick();
    expect(h.entry().error).toBe("E_OFFLINE");
  });
});

describe("#30 U10：parseReloadStatus 防御", () => {
  const good = { v: 1, life: "L", cmdIds: ["a"], rev: 1, execId: "E", state: "started", open: true, at: 5 };
  it("合法 ⇒ 解析；可选字段类型不符被丢弃", () => {
    expect(parseReloadStatus({ reload: good })).toMatchObject({ life: "L", rev: 1, state: "started" });
    const r = parseReloadStatus({ reload: { ...good, waitingFor: "zzz", activeRuns: -1, code: 3, version: "" } });
    expect(r).toBeDefined();
    expect(r).not.toHaveProperty("waitingFor");
    expect(r).not.toHaveProperty("activeRuns");
    expect(r).not.toHaveProperty("code");
    expect(r).not.toHaveProperty("version");
  });
  it("v≠1 / 缺必填 / 类型错 / cmdIds 空或过多 / 非对象 ⇒ undefined，never throws", () => {
    const bad: unknown[] = [
      undefined,
      null,
      "x",
      [],
      {},
      { reload: null },
      { reload: [] },
      { reload: { ...good, v: 2 } },
      { reload: { ...good, life: "" } },
      { reload: { ...good, execId: 1 } },
      { reload: { ...good, cmdIds: [] } },
      { reload: { ...good, cmdIds: ["a", "b", "c", "d", "e"] } },
      { reload: { ...good, cmdIds: [1] } },
      { reload: { ...good, rev: 1.5 } },
      { reload: { ...good, rev: -1 } },
      { reload: { ...good, state: "weird" } },
      { reload: { ...good, open: "yes" } },
      { reload: { ...good, at: Number.NaN } },
    ];
    for (const b of bad) expect(parseReloadStatus(b)).toBeUndefined();
    const evil = {
      get reload(): never {
        throw new Error("x");
      },
    };
    expect(parseReloadStatus(evil)).toBeUndefined();
  });
});

describe("#30 orFailReason 新错误码", () => {
  it("映射到各自 i18n 键；THREW 无 message ⇒ errReloadFailed；未知码仍 raw", () => {
    const k = (error: string) => orFailReason({ phase: "failed", error });
    expect(k("E_RELOAD_LOST")).toEqual({ key: "outdated.errReloadLost" });
    expect(k("E_RELOAD_NO_UPGRADE")).toEqual({ key: "outdated.errReloadNoUpgrade" });
    expect(k("E_RELOAD_CANCELLED")).toEqual({ key: "outdated.errReloadCancelled" });
    expect(k("E_RELOAD_UNAVAILABLE")).toEqual({ key: "outdated.errReloadUnavailable" });
    expect(k("E_RELOAD_SETTLE")).toEqual({ key: "outdated.errReloadSettle" });
    expect(k("E_RELOAD_IDLE_WAIT")).toEqual({ key: "outdated.errReloadIdleWait" });
    expect(k("E_RELOAD_REFUSED")).toEqual({ key: "outdated.errReloadRefused" });
    expect(k("E_RELOAD_THREW")).toEqual({ key: "outdated.errReloadFailed" });
    expect(k("E_FUTURE")).toEqual({ raw: "E_FUTURE" });
  });
});

// ---------------------------------------------------------------------------
// 真实 reduce + composable
// ---------------------------------------------------------------------------

describe("#30 端到端：真实 reduce（未改 state.js）+ composable", () => {
  const card = (v: string): Record<string, unknown> => ({
    agentKey: "a1",
    kind: "tui",
    pid: 1,
    cwd: "/tmp",
    state: "live",
    pluginVersion: v,
    outdated: v !== "1.0.0",
    control: true,
    commands: [],
    prompts: [],
  });
  function loop() {
    const state = ref(initialState());
    const ids: string[] = [];
    const control = {
      runCommand: (_k: string, _n: string, args: string, o?: { id?: string }) => {
        if (args === "reload" && o?.id !== undefined) ids.push(o.id);
        return Promise.resolve({ ok: true } satisfies CmdOutcome);
      },
    } as unknown as ControlHandle;
    const hub: HubHandle = { state, dispatch: () => {}, control };
    const h = useOutdatedReload({
      hub,
      storage: null,
      setTimeout: () => 0,
      clearTimeout: () => {},
      now: () => 0,
    });
    const push = async (msg: { event: string; data?: unknown }): Promise<void> => {
      state.value = reduce(state.value, msg);
      for (let i = 0; i < 6; i++) await Promise.resolve();
      await nextTick();
      for (let i = 0; i < 6; i++) await Promise.resolve();
      await nextTick();
    };
    return { h, push, ids };
  }

  it("命令带自生成 id；status.reload 的 deferred→started→completed 驱动 parked→awaiting→done；坏结构被忽略", async () => {
    const { h, push, ids } = loop();
    await push({ event: "hub", data: { version: "1.0.0", caps: ["cmd.v1"] } });
    await push({ event: "agents", data: [card("0.9.0")] });
    h.request("a1");
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await nextTick();
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(h.entryOf("a1").phase).toBe("awaiting"); // 老路径：HTTP ok ⇒ awaiting
    const rl = (rev: number, state: string, extra: Record<string, unknown> = {}) => ({
      event: "status",
      data: {
        agentKey: "a1",
        status: {
          busy: false,
          reload: { v: 1, life: "L", cmdIds: [ids[0]], rev, execId: "E", state, open: true, at: 1, ...extra },
        },
      },
    });
    await push(rl(1, "deferred", { waitingFor: "idle" }));
    expect(h.entryOf("a1")).toMatchObject({ phase: "parked", waitingFor: "idle" });
    await push({ event: "status", data: { agentKey: "a1", status: { busy: false, reload: { v: 9 } } } });
    expect(h.entryOf("a1").phase).toBe("parked");
    await push(rl(2, "started"));
    expect(h.entryOf("a1").phase).toBe("awaiting");
    await push(rl(3, "completed", { open: false, version: "1.0.0", epoch: "ep" }));
    expect(h.entryOf("a1").phase).toBe("done");
  });
});
