/**
 * #65 outdated-reload（预览 outdated-reload-preview.html §1–§6）— `@logic/outdatedReload.ts`
 * 的纯逻辑门：落后判定（证据等级与 version-match §4 一致）、snooze 记忆键、OrCoordinator
 * 排队/送达/超时状态机、仪表盘汇总列表与批量进度。协调器用注入的假定时器驱动，不碰 Vue。
 * #23 P-A 新增：总预算（D1 绝对截止时间 + 反复忙闲跨过截止）、sending 上界（D2）、attempt
 * token 的 ABA 乱序（D3）、下线判定（D4/D5）与 orFailReason（D9）。
 */
import { describe, expect, it } from "vitest";
import {
  createOrCoordinator,
  fleetActiveCount,
  isSnoozed,
  OR_EFFECT_TIMEOUT_MS,
  OR_QUEUE_TIMEOUT_MS,
  OR_SEND_TIMEOUT_MS,
  OR_TOAST_MS,
  orBannerView,
  orFailReason,
  outdatedSessions,
  readSnoozeMap,
  sessionOutdatedInfo,
  sessionReloadedToHub,
  withSnooze,
  writeSnoozeMap,
  SNOOZE_CAP,
  SNOOZE_STORAGE_KEY,
  type OrSendResult,
  type SnoozeStorage,
} from "../../../src/web-hub/ui/src/logic/outdatedReload.js";
import { CMD_REQUEST_TIMEOUT_MS } from "../../../src/web-hub/ui/src/logic/token-client.js";

// ---------------------------------------------------------------------------
// 落后判定 / 成功判据
// ---------------------------------------------------------------------------

describe("sessionOutdatedInfo", () => {
  it("hub 侧 outdated 旗标优先（老 hub 也工作）", () => {
    expect(sessionOutdatedInfo({ outdated: true, pluginVersion: "0.8.1" }, "0.9.0")).toEqual({
      outdated: true,
      pluginVersion: "0.8.1",
    });
  });

  it("semver 旧于 hub ⇒ 落后；相等/更新 ⇒ 不落后", () => {
    expect(sessionOutdatedInfo({ pluginVersion: "0.8.1" }, "0.9.0").outdated).toBe(true);
    expect(sessionOutdatedInfo({ pluginVersion: "0.9.0" }, "0.9.0").outdated).toBe(false);
    expect(sessionOutdatedInfo({ pluginVersion: "0.10.0" }, "0.9.0").outdated).toBe(false);
  });

  it("无法验证（缺 hub 版本 / 缺 pluginVersion / 非数字版本）⇒ 不判定落后", () => {
    expect(sessionOutdatedInfo({ pluginVersion: "0.8.1" }, undefined).outdated).toBe(false);
    expect(sessionOutdatedInfo({}, "0.9.0").outdated).toBe(false);
    expect(sessionOutdatedInfo({ pluginVersion: "dev" }, "0.9.0").outdated).toBe(false);
    expect(sessionOutdatedInfo(undefined, "0.9.0").outdated).toBe(false);
  });

  it("成功判据：重上报版本 == hub 版本 ∧ hub 不再标 outdated", () => {
    expect(sessionReloadedToHub({ pluginVersion: "0.9.0", outdated: false }, "0.9.0")).toBe(true);
    expect(sessionReloadedToHub({ pluginVersion: "0.9.0" }, "0.9.0")).toBe(true);
    expect(sessionReloadedToHub({ pluginVersion: "0.9.0", outdated: true }, "0.9.0")).toBe(false);
    expect(sessionReloadedToHub({ pluginVersion: "0.8.1" }, "0.9.0")).toBe(false);
    expect(sessionReloadedToHub({}, "0.9.0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// snooze（【暂不】/【关闭】记忆键）
// ---------------------------------------------------------------------------

function memStorage(initial?: string): SnoozeStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(SNOOZE_STORAGE_KEY, initial);
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

describe("snooze 记忆", () => {
  it("读：缺失/损坏/非对象 ⇒ 空表；合法表过滤非字符串值", () => {
    expect(readSnoozeMap(null)).toEqual({});
    expect(readSnoozeMap(memStorage())).toEqual({});
    expect(readSnoozeMap(memStorage("not json"))).toEqual({});
    expect(readSnoozeMap(memStorage('["a"]'))).toEqual({});
    expect(readSnoozeMap(memStorage('{"k":"0.9.0","bad":1}'))).toEqual({ k: "0.9.0" });
  });

  it("写读回环；hub 版本再变 ⇒ 不再 snoozed", () => {
    const s = memStorage();
    const m1 = withSnooze({}, "a1", "0.9.0");
    writeSnoozeMap(s, m1);
    const back = readSnoozeMap(s);
    expect(isSnoozed(back, "a1", "0.9.0")).toBe(true);
    expect(isSnoozed(back, "a1", "0.9.1")).toBe(false); // hub 版本变化 ⇒ 重新提示
    expect(isSnoozed(back, "a2", "0.9.0")).toBe(false); // 按会话记忆
    expect(isSnoozed(back, "a1", undefined)).toBe(false);
  });

  it(`容量封顶 ${SNOOZE_CAP}，FIFO 淘汰最旧`, () => {
    let m: Record<string, string> = {};
    for (let i = 0; i < SNOOZE_CAP + 5; i++) m = withSnooze(m, `a${i}`, "1.0.0");
    expect(Object.keys(m)).toHaveLength(SNOOZE_CAP);
    expect(m["a0"]).toBeUndefined();
    expect(m[`a${SNOOZE_CAP + 4}`]).toBe("1.0.0");
  });
});

// ---------------------------------------------------------------------------
// OrCoordinator 状态机
// ---------------------------------------------------------------------------

interface FakeWorld {
  main: Set<string>;
  fleet: Map<string, number>;
  settled: Set<string>;
  offline: Set<string>;
  precheck: Map<string, "ok" | "offline" | "unsupported">;
  sendResults: Map<string, OrSendResult>;
  /** 可控 send：置顶时优先于 sendResults（永不 settle / 逐次 resolve/reject 都靠它）。 */
  sendImpl?: (key: string) => Promise<OrSendResult>;
  sent: string[];
  cancels: string[];
}

function makeWorld(): FakeWorld {
  return {
    main: new Set(),
    fleet: new Map(),
    settled: new Set(),
    offline: new Set(),
    precheck: new Map(),
    sendResults: new Map(),
    sent: [],
    cancels: [],
  };
}

function makeCoordinator(world: FakeWorld) {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 1;
  const coord = createOrCoordinator({
    mainBusy: (k) => world.main.has(k),
    fleetActive: (k) => world.fleet.get(k) ?? 0,
    precheck: (k) => world.precheck.get(k) ?? "ok",
    isSettled: (k) => world.settled.has(k),
    offline: (k) => world.offline.has(k),
    now: () => 0, // 固定时钟：deadline 恒为 +30min，armTimer 拿到的 ms 即各常量原值
    send: (k) => {
      world.sent.push(k);
      if (world.sendImpl !== undefined) return world.sendImpl(k);
      return Promise.resolve(world.sendResults.get(k) ?? { ok: true });
    },
    sendCancel: (k) => {
      world.cancels.push(k);
      return Promise.resolve(true);
    },
    setTimeout: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (h) => void timers.delete(h as number),
  });
  /** 触发所有时长为 ms 的定时器（测试不区分先后——每 key 每类只有一个）。 */
  function fire(ms: number): void {
    for (const [id, t] of [...timers]) {
      if (t.ms === ms) {
        timers.delete(id);
        t.fn();
      }
    }
  }
  return { coord, fire, timers };
}

/**
 * #23 D1：带假时钟的协调器——`advance` 按到期顺序触发定时器并把时钟推到目标刻；
 * `warp` 只推时钟不触发（模拟后台标签页计时器延迟）。 */
function makeClockCoordinator(world: FakeWorld, startNow = 1_000_000) {
  let now = startNow;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextTimer = 1;
  const coord = createOrCoordinator({
    mainBusy: (k) => world.main.has(k),
    fleetActive: (k) => world.fleet.get(k) ?? 0,
    precheck: (k) => world.precheck.get(k) ?? "ok",
    isSettled: (k) => world.settled.has(k),
    offline: (k) => world.offline.has(k),
    now: () => now,
    send: (k) => {
      world.sent.push(k);
      if (world.sendImpl !== undefined) return world.sendImpl(k);
      return Promise.resolve(world.sendResults.get(k) ?? { ok: true });
    },
    sendCancel: (k) => {
      world.cancels.push(k);
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
      let bestId: number | undefined;
      let bestAt = Number.POSITIVE_INFINITY;
      for (const [id, t] of timers) {
        if (t.at <= target && t.at < bestAt) {
          bestAt = t.at;
          bestId = id;
        }
      }
      if (bestId === undefined) break;
      const t = timers.get(bestId);
      if (t === undefined) break;
      timers.delete(bestId);
      now = t.at;
      t.fn();
    }
    now = target;
  }
  /** 只推时钟不触发定时器（后台标签页节流：timer 还挂着，now 已过成）。 */
  function warp(ms: number): void {
    now += ms;
  }
  return { coord, advance, warp, timers, nowOf: () => now };
}

/** 让 send 的 promise 链 settle（ coordinator 内部两个 then）。 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("OrCoordinator", () => {
  it("空闲会话：request → sending →(ok)→ awaiting →版本到位→ done →toast 超时→ idle", async () => {
    const w = makeWorld();
    const { coord, fire } = makeCoordinator(w);
    coord.request("a");
    expect(coord.entryOf("a").phase).toBe("sending");
    await flush();
    expect(coord.entryOf("a").phase).toBe("awaiting");
    w.settled.add("a");
    coord.notifyTick();
    expect(coord.entryOf("a").phase).toBe("done");
    fire(OR_TOAST_MS);
    expect(coord.entryOf("a").phase).toBe("idle");
  });

  it("忙会话（主会话流式）：request → queued；本轮结束（busy 翻转）⇒ 自动送帧", async () => {
    const w = makeWorld();
    w.main.add("a");
    const { coord } = makeCoordinator(w);
    coord.request("a");
    expect(coord.entryOf("a").phase).toBe("queued");
    expect(w.sent).toEqual([]);
    w.main.delete("a");
    coord.notifyTick();
    expect(coord.entryOf("a").phase).toBe("sending");
    await flush();
    expect(coord.entryOf("a").phase).toBe("awaiting");
    expect(w.sent).toEqual(["a"]);
  });

  it("major：主会话 idle 但 fleet 忙 ⇒ queued 而非 send/timeout；fleet 清空才送", async () => {
    const w = makeWorld();
    w.fleet.set("a", 2); // 主会话 idle，2 个子 agent 在跑
    const { coord, fire } = makeCoordinator(w);
    coord.request("a");
    expect(coord.entryOf("a").phase).toBe("queued");
    expect(w.sent).toEqual([]);
    // 90s（生效计时）在 queued 下绝不触发 failed
    fire(OR_EFFECT_TIMEOUT_MS);
    expect(coord.entryOf("a").phase).toBe("queued");
    w.fleet.set("a", 0);
    coord.notifyTick();
    expect(coord.entryOf("a").phase).toBe("sending");
    await flush();
    expect(coord.entryOf("a").phase).toBe("awaiting");
  });

  it("major：送达时 fleet 已忙 ⇒ parked（不计 90s）；fleet 清空后才开始 90s 计时", async () => {
    const w = makeWorld();
    const { coord, fire } = makeCoordinator(w);
    coord.request("a"); // 送时 fleet 空
    w.fleet.set("a", 1); // send 的 promise settle 前 fleet 变忙
    await flush();
    expect(coord.entryOf("a").phase).toBe("parked");
    fire(OR_EFFECT_TIMEOUT_MS); // parked 下 90s 不得报 E_TIMEOUT
    expect(coord.entryOf("a").phase).toBe("parked");
    w.fleet.set("a", 0);
    coord.notifyTick();
    expect(coord.entryOf("a").phase).toBe("awaiting");
    fire(OR_EFFECT_TIMEOUT_MS); // fleet 空闲后 90s 仍未生效 ⇒ E_TIMEOUT
    expect(coord.entryOf("a")).toMatchObject({ phase: "failed", error: "E_TIMEOUT" });
  });

  it("major：awaiting 中 fleet 变忙 ⇒ 转 parked（停 90s）；再清空 ⇒ 重开 90s", async () => {
    const w = makeWorld();
    const { coord, fire } = makeCoordinator(w);
    coord.request("a");
    await flush();
    expect(coord.entryOf("a").phase).toBe("awaiting");
    w.fleet.set("a", 3);
    coord.notifyTick();
    expect(coord.entryOf("a").phase).toBe("parked");
    fire(OR_EFFECT_TIMEOUT_MS); // 旧的 effect 计时器已被清除
    expect(coord.entryOf("a").phase).toBe("parked");
    w.fleet.set("a", 0);
    coord.notifyTick();
    expect(coord.entryOf("a").phase).toBe("awaiting");
    fire(OR_EFFECT_TIMEOUT_MS);
    expect(coord.entryOf("a")).toMatchObject({ phase: "failed", error: "E_TIMEOUT" });
  });

  it("major：parked 的【取消排队】送 /agent reload cancel 并回 idle；queued 取消不发帧", async () => {
    const w = makeWorld();
    const { coord } = makeCoordinator(w);
    // parked 路径
    coord.request("a");
    w.fleet.set("a", 1);
    await flush();
    expect(coord.entryOf("a").phase).toBe("parked");
    coord.cancelQueue("a");
    expect(w.cancels).toEqual(["a"]);
    expect(coord.entryOf("a").phase).toBe("idle");
    // queued 路径（从未送达，无需 cancel 帧）
    w.fleet.set("b", 1);
    coord.request("b");
    expect(coord.entryOf("b").phase).toBe("queued");
    coord.cancelQueue("b");
    expect(w.cancels).toEqual(["a"]);
    expect(w.sent).toEqual(["a"]);
    expect(coord.entryOf("b").phase).toBe("idle");
  });

  it("major：parked 超 30min 总上限 ⇒ 先 cancel 后端 reload 再报 E_QUEUE_TIMEOUT", async () => {
    const w = makeWorld();
    const { coord, fire } = makeCoordinator(w);
    coord.request("a");
    w.fleet.set("a", 1);
    await flush();
    expect(coord.entryOf("a").phase).toBe("parked");
    fire(OR_QUEUE_TIMEOUT_MS);
    expect(w.cancels).toEqual(["a"]);
    expect(coord.entryOf("a")).toMatchObject({ phase: "failed", error: "E_QUEUE_TIMEOUT" });
  });

  it("排队可取消（回到 idle，不发帧）；排队有超时（E_QUEUE_TIMEOUT）", () => {
    const w = makeWorld();
    w.main.add("a");
    w.main.add("b");
    const { coord, fire } = makeCoordinator(w);
    coord.request("a");
    coord.request("b");
    coord.cancelQueue("a");
    expect(coord.entryOf("a").phase).toBe("idle");
    expect(w.cancels).toEqual([]); // 未送达 ⇒ 不发 cancel 帧
    fire(OR_QUEUE_TIMEOUT_MS);
    expect(coord.entryOf("b").phase).toBe("failed");
    expect(coord.entryOf("b").error).toBe("E_QUEUE_TIMEOUT");
    expect(w.sent).toEqual([]);
  });

  it("离线/无控制面 ⇒ 不发帧，立即 failed（E_OFFLINE / E_UNSUPPORTED）", () => {
    const w = makeWorld();
    w.precheck.set("a", "offline");
    w.precheck.set("b", "unsupported");
    const { coord } = makeCoordinator(w);
    coord.request("a");
    coord.request("b");
    expect(coord.entryOf("a")).toMatchObject({ phase: "failed", error: "E_OFFLINE" });
    expect(coord.entryOf("b")).toMatchObject({ phase: "failed", error: "E_UNSUPPORTED" });
    expect(w.sent).toEqual([]);
  });

  it("送帧失败 ⇒ failed 带 wire 错误码与原因；【重试】重走完整流程", async () => {
    const w = makeWorld();
    w.sendResults.set("a", { ok: false, error: "E_AGENT_GONE", message: "agent not connected" });
    const { coord } = makeCoordinator(w);
    coord.request("a");
    await flush();
    expect(coord.entryOf("a")).toMatchObject({
      phase: "failed",
      error: "E_AGENT_GONE",
      message: "agent not connected",
    });
    w.sendResults.set("a", { ok: true });
    coord.request("a"); // 重试
    expect(coord.entryOf("a").phase).toBe("sending");
    await flush();
    expect(coord.entryOf("a").phase).toBe("awaiting");
    expect(w.sent).toEqual(["a", "a"]);
  });

  it("生效等待有超时（E_TIMEOUT）；failed 后版本仍可能到位（effect:unknown）⇒ 收敛 done", async () => {
    const w = makeWorld();
    const { coord, fire } = makeCoordinator(w);
    coord.request("a");
    await flush();
    fire(OR_EFFECT_TIMEOUT_MS);
    expect(coord.entryOf("a")).toMatchObject({ phase: "failed", error: "E_TIMEOUT" });
    // 命令其实送达了（延迟的 reload 完成）——版本到位是全局真值，failed 也收敛。
    w.settled.add("a");
    coord.notifyTick();
    expect(coord.entryOf("a").phase).toBe("done");
  });

  it("request 幂等（在飞不重复送帧）；reset 清场并停表", async () => {
    const w = makeWorld();
    const { coord, timers } = makeCoordinator(w);
    coord.request("a");
    coord.request("a");
    await flush();
    expect(w.sent).toEqual(["a"]);
    coord.reset("a");
    expect(coord.entryOf("a").phase).toBe("idle");
    expect(timers.size).toBe(0);
  });

  it("批量（预览 §6）：忙的进排队、空闲的直接送，全部到位后逐条 done", async () => {
    const w = makeWorld();
    w.main.add("busy1");
    const { coord } = makeCoordinator(w);
    for (const k of ["a", "busy1", "c"]) coord.request(k);
    expect(coord.entryOf("busy1").phase).toBe("queued");
    await flush();
    expect(w.sent.sort()).toEqual(["a", "c"]);
    w.main.delete("busy1");
    coord.notifyTick();
    await flush();
    expect(w.sent.sort()).toEqual(["a", "busy1", "c"]);
    w.settled.add("a");
    w.settled.add("busy1");
    w.settled.add("c");
    coord.notifyTick();
    for (const k of ["a", "busy1", "c"]) expect(coord.entryOf(k).phase).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// #23 P-A：总预算（D1 绝对截止时间，假时钟）
// ---------------------------------------------------------------------------

describe("OrCoordinator 总预算（#23 D1）", () => {
  it("fleet 反复忙闲（每段不足 90s）永不永久等待；30min 时处于 awaiting ⇒ E_TIMEOUT", async () => {
    const w = makeWorld();
    const { coord, advance } = makeClockCoordinator(w);
    w.fleet.set("a", 1);
    coord.request("a");
    expect(coord.entryOf("a").phase).toBe("queued");
    // 14 轮「awaiting 60s → parked 60s」：每段 < 90s，永不提前 E_TIMEOUT
    for (let i = 0; i < 14; i++) {
      w.fleet.set("a", 0);
      coord.notifyTick(); // queued → sending →（microtask）awaiting
      await flush();
      expect(coord.entryOf("a").phase).toBe("awaiting");
      advance(60_000);
      expect(coord.entryOf("a").phase).toBe("awaiting"); // 60s < 90s
      w.fleet.set("a", 1);
      coord.notifyTick(); // awaiting → parked
      expect(coord.entryOf("a").phase).toBe("parked");
      advance(60_000);
      expect(coord.entryOf("a").phase).toBe("parked");
    }
    // 28min 已过；最后一次 fleet 清空 ⇒ 回 awaiting（effect 计时被剩余预算 2min 收紧）
    w.fleet.set("a", 0);
    coord.notifyTick();
    expect(coord.entryOf("a").phase).toBe("awaiting");
    advance(2 * 60_000); // 到 30min 总预算
    expect(coord.entryOf("a")).toMatchObject({ phase: "failed", error: "E_TIMEOUT" });
    expect(w.cancels).toEqual([]); // awaiting 超预算不发 cancel（未 park）
  });

  it("跨过截止后才进入 parked ⇒ 立即 E_QUEUE_TIMEOUT 并先 sendCancel（计时器延迟兑底）", async () => {
    const w = makeWorld();
    const { coord, warp } = makeClockCoordinator(w);
    coord.request("a");
    w.fleet.set("a", 1); // send settle 前变忙 ⇒ parked
    await flush();
    expect(coord.entryOf("a").phase).toBe("parked");
    warp(OR_QUEUE_TIMEOUT_MS + 5_000); // 后台标签页：timer 还挂着，now 已过成
    w.fleet.set("a", 0);
    coord.notifyTick(); // parked →（enterAwaiting 入口截止检查）按当前相结算
    expect(coord.entryOf("a")).toMatchObject({ phase: "failed", error: "E_QUEUE_TIMEOUT" });
    expect(w.cancels).toEqual(["a"]);
  });

  it("计时器延迟：now 已过截止但 timer 未触发，进入 parked 前也结算（awaiting ⇒ E_TIMEOUT）", async () => {
    const w = makeWorld();
    const { coord, warp } = makeClockCoordinator(w);
    coord.request("a");
    await flush();
    expect(coord.entryOf("a").phase).toBe("awaiting");
    warp(OR_QUEUE_TIMEOUT_MS + 1_000);
    w.fleet.set("a", 1);
    coord.notifyTick(); // awaiting →（enterParked 入口截止检查）按当前相 awaiting 结算
    expect(coord.entryOf("a")).toMatchObject({ phase: "failed", error: "E_TIMEOUT" });
  });

  it("计时器延迟：now 已过截止，queued 放行送帧前结算（queued ⇒ E_QUEUE_TIMEOUT，不发 cancel）", () => {
    const w = makeWorld();
    const { coord, warp } = makeClockCoordinator(w);
    w.fleet.set("a", 1);
    coord.request("a");
    expect(coord.entryOf("a").phase).toBe("queued");
    warp(OR_QUEUE_TIMEOUT_MS + 1);
    w.fleet.set("a", 0);
    coord.notifyTick(); // toSend → send() 入口截止检查
    expect(coord.entryOf("a")).toMatchObject({ phase: "failed", error: "E_QUEUE_TIMEOUT" });
    expect(w.sent).toEqual([]);
    expect(w.cancels).toEqual([]);
  });

  it("计时器延迟：send 迟到 settle 且已过截止 ⇒ 进入 awaiting 前按当前相（sending）结算 E_SEND_UNKNOWN", async () => {
    const w = makeWorld();
    const deferreds: Array<(r: OrSendResult) => void> = [];
    w.sendImpl = () =>
      new Promise<OrSendResult>((resolve) => {
        deferreds.push(resolve);
      });
    const { coord, warp } = makeClockCoordinator(w);
    coord.request("a");
    expect(coord.entryOf("a").phase).toBe("sending");
    warp(OR_QUEUE_TIMEOUT_MS + 1); // 后台标签页：timer 还挂着，now 已过成
    deferreds[0]!({ ok: true }); // 迟到成功：enterAwaiting 入口截止检查，按 sending 相结算
    await flush();
    expect(coord.entryOf("a")).toMatchObject({ phase: "failed", error: "E_SEND_UNKNOWN" });
    expect(w.cancels).toEqual([]); // 未 park，不发 cancel
  });
});

// ---------------------------------------------------------------------------
// #23 P-A：sending 上界（D2）
// ---------------------------------------------------------------------------

describe("OrCoordinator sending 上界（#23 D2）", () => {
  it(`OR_SEND_TIMEOUT_MS > 2×CMD_REQUEST_TIMEOUT_MS（${OR_SEND_TIMEOUT_MS}ms vs 2×${CMD_REQUEST_TIMEOUT_MS}ms，relogin 余量）`, () => {
    expect(OR_SEND_TIMEOUT_MS).toBeGreaterThan(2 * CMD_REQUEST_TIMEOUT_MS);
  });

  it("send 永不 settle ⇒ 60s 后 E_SEND_UNKNOWN；不自动重发；之后版本到位仍收敛 done", async () => {
    const w = makeWorld();
    w.sendImpl = () => new Promise<OrSendResult>(() => {}); // body 永不结束（#25 场景）
    const { coord, fire } = makeCoordinator(w);
    coord.request("a");
    expect(coord.entryOf("a").phase).toBe("sending");
    fire(OR_SEND_TIMEOUT_MS);
    expect(coord.entryOf("a")).toMatchObject({ phase: "failed", error: "E_SEND_UNKNOWN" });
    expect(w.sent).toEqual(["a"]); // 只送过一次，不自动重发（D7）
    // 命令其实已送达：版本到位 ⇒ failed 收敛 done（D6）
    w.settled.add("a");
    coord.notifyTick();
    expect(coord.entryOf("a").phase).toBe("done");
    fire(OR_TOAST_MS);
    expect(coord.entryOf("a").phase).toBe("idle");
  });

  it("sending 剩余预算更小则收紧 send 上界（min 生效，不超总预算）", async () => {
    const w = makeWorld();
    const { coord, advance } = makeClockCoordinator(w);
    // 重试场景：先让一个请求在截止前 10s 重新送帧
    w.sendImpl = () => new Promise<OrSendResult>(() => {});
    w.fleet.set("a", 1);
    coord.request("a"); // queued
    advance(OR_QUEUE_TIMEOUT_MS - 10_000); // 还剩 10s
    w.fleet.set("a", 0);
    coord.notifyTick(); // queued → send：send 上界 = min(60s, 10s) = 10s
    expect(coord.entryOf("a").phase).toBe("sending");
    advance(10_000); // 到总预算，不是 60s
    expect(coord.entryOf("a")).toMatchObject({ phase: "failed", error: "E_SEND_UNKNOWN" });
  });
});

// ---------------------------------------------------------------------------
// #23 P-A：attempt token（D3，ABA 乱序）
// ---------------------------------------------------------------------------

describe("OrCoordinator attempt token（#23 D3）", () => {
  type Deferred = { resolve: (r: OrSendResult) => void; reject: (e: unknown) => void };

  function deferredSend(world: FakeWorld): Deferred[] {
    const deferreds: Deferred[] = [];
    world.sendImpl = () =>
      new Promise<OrSendResult>((resolve, reject) => {
        deferreds.push({ resolve, reject });
      });
    return deferreds;
  }

  it("attempt1 因下线失败后重试进 attempt2：attempt1 迟到 resolve 不影响 attempt2；attempt2 resolve ⇒ awaiting", async () => {
    const w = makeWorld();
    const deferreds = deferredSend(w);
    const { coord } = makeCoordinator(w);
    // attempt1：sending 中目标下线 ⇒ E_OFFLINE
    coord.request("a");
    expect(coord.entryOf("a").phase).toBe("sending");
    w.offline.add("a");
    coord.notifyTick();
    expect(coord.entryOf("a")).toMatchObject({ phase: "failed", error: "E_OFFLINE" });
    // key 恢复但版本仍旧 ⇒ 重试（attempt2）
    w.offline.delete("a");
    coord.request("a");
    expect(coord.entryOf("a").phase).toBe("sending");
    expect(w.sent).toEqual(["a", "a"]);
    // attempt1 迟到 resolve ok：token 已失效，不得把 attempt2 顶进 awaiting/parked
    deferreds[0]!.resolve({ ok: true });
    await flush();
    expect(coord.entryOf("a").phase).toBe("sending");
    // attempt2 正常 settle ⇒ awaiting
    deferreds[1]!.resolve({ ok: true });
    await flush();
    expect(coord.entryOf("a").phase).toBe("awaiting");
  });

  it("attempt1 迟到 reject 同样被 token 挡掉（不得把 attempt2 改成 failed）", async () => {
    const w = makeWorld();
    const deferreds = deferredSend(w);
    const { coord } = makeCoordinator(w);
    coord.request("a");
    w.offline.add("a");
    coord.notifyTick();
    w.offline.delete("a");
    coord.request("a"); // attempt2
    deferreds[0]!.reject(new Error("late"));
    await flush();
    expect(coord.entryOf("a").phase).toBe("sending"); // 未被旧 attempt 破坏
    deferreds[1]!.resolve({ ok: true });
    await flush();
    expect(coord.entryOf("a").phase).toBe("awaiting");
  });

  it("reset/cancelQueue 清场也使 token 失效：迟到的 resolve 不复活任何相", async () => {
    const w = makeWorld();
    const deferreds = deferredSend(w);
    const { coord } = makeCoordinator(w);
    coord.request("a");
    coord.reset("a"); // 清场（token 失效）
    deferreds[0]!.resolve({ ok: true });
    await flush();
    expect(coord.entryOf("a").phase).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// #23 P-A：下线判定（D4/D5）
// ---------------------------------------------------------------------------

describe("OrCoordinator 下线判定（#23 D4/D5）", () => {
  it("四个在飞阶段遇到 offline 都进 E_OFFLINE，计时器全部清空；failed 不重复处理", async () => {
    const w = makeWorld();
    const { coord, timers } = makeCoordinator(w);
    // queued
    w.fleet.set("q", 1);
    coord.request("q");
    expect(coord.entryOf("q").phase).toBe("queued");
    // sending（永不 settle，保持住相）
    w.sendImpl = () => new Promise<OrSendResult>(() => {});
    coord.request("s");
    // awaiting
    w.sendImpl = undefined;
    coord.request("aw");
    await flush();
    expect(coord.entryOf("aw").phase).toBe("awaiting");
    // parked（送帧时闲，settle 前变忙）
    coord.request("p");
    w.fleet.set("p", 1);
    await flush();
    expect(coord.entryOf("p").phase).toBe("parked");
    // 全部下线
    for (const k of ["q", "s", "aw", "p"]) w.offline.add(k);
    coord.notifyTick();
    for (const k of ["q", "s", "aw", "p"])
      expect(coord.entryOf(k)).toMatchObject({ phase: "failed", error: "E_OFFLINE" });
    expect(timers.size).toBe(0); // 计时器全部清空
    expect(w.cancels).toEqual([]); // parked 下线不发 reload cancel（D5）
    // 再 tick：failed 相不重复处理，也不自动重发
    coord.notifyTick();
    expect(w.sent).toEqual(["s", "aw", "p"]);
    for (const k of ["q", "s", "aw", "p"])
      expect(coord.entryOf(k)).toMatchObject({ phase: "failed", error: "E_OFFLINE" });
  });

  it("settled 与 offline 同时为真 ⇒ 先判版本到位（done）", async () => {
    const w = makeWorld();
    const { coord } = makeCoordinator(w);
    coord.request("a");
    await flush();
    expect(coord.entryOf("a").phase).toBe("awaiting");
    w.settled.add("a");
    w.offline.add("a"); // 下线与到位同时
    coord.notifyTick();
    expect(coord.entryOf("a").phase).toBe("done");
  });

  it("queued 遇 offline（precheck 同源判据）⇒ E_OFFLINE 而非无限排队", () => {
    const w = makeWorld();
    const { coord } = makeCoordinator(w);
    w.fleet.set("a", 1);
    coord.request("a");
    w.offline.add("a");
    coord.notifyTick();
    expect(coord.entryOf("a")).toMatchObject({ phase: "failed", error: "E_OFFLINE" });
  });
});

// ---------------------------------------------------------------------------
// orFailReason（#23 D9 唯一文案来源）
// ---------------------------------------------------------------------------

describe("orFailReason（#23 D9）", () => {
  it("wire message 优先直出 raw", () => {
    expect(orFailReason({ phase: "failed", error: "E_AGENT_GONE", message: "agent not connected" })).toEqual({
      raw: "agent not connected",
    });
  });

  it("本地错误码映射 i18n key；未知/缺失错误码退 raw 错误码/空串", () => {
    expect(orFailReason({ phase: "failed", error: "E_OFFLINE" })).toEqual({ key: "outdated.errOffline" });
    expect(orFailReason({ phase: "failed", error: "E_UNSUPPORTED" })).toEqual({ key: "outdated.errUnsupported" });
    expect(orFailReason({ phase: "failed", error: "E_TIMEOUT" })).toEqual({ key: "outdated.errTimeout" });
    expect(orFailReason({ phase: "failed", error: "E_QUEUE_TIMEOUT" })).toEqual({ key: "outdated.errQueueTimeout" });
    expect(orFailReason({ phase: "failed", error: "E_SEND_UNKNOWN" })).toEqual({ key: "outdated.errSendUnknown" });
    expect(orFailReason({ phase: "failed", error: "E_AGENT_GONE" })).toEqual({ raw: "E_AGENT_GONE" });
    expect(orFailReason({ phase: "idle" })).toEqual({ raw: "" });
  });
});

// ---------------------------------------------------------------------------
// 仪表盘汇总列表
// ---------------------------------------------------------------------------

describe("outdatedSessions（汇总，预览 §6）", () => {
  const agent = (key: string, card: Record<string, unknown>, busy = false) => ({
    key,
    card,
    status: { busy },
  });

  it("只收落后会话，保持传入顺序，带 busy/版本", () => {
    const rows = outdatedSessions(
      [
        agent("a", { pluginVersion: "0.8.1" }),
        agent("b", { pluginVersion: "0.9.0" }),
        agent("c", { outdated: true }, true),
      ],
      "0.9.0",
    );
    expect(rows).toEqual([
      { key: "a", busy: false, pluginVersion: "0.8.1" },
      { key: "c", busy: true, pluginVersion: undefined },
    ]);
  });

  it("hub 版本缺失 ⇒ 空（无法验证不汇总）；畸形 card 不 throw", () => {
    expect(outdatedSessions([agent("a", { pluginVersion: "0.8.1" })], undefined)).toEqual([]);
    expect(outdatedSessions([agent("a", null as never)], "0.9.0")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fleetActiveCount（major 修复的「fleet 忙」计数口径）
// ---------------------------------------------------------------------------

describe("fleetActiveCount", () => {
  it("running ∧ 非 terminal 行计数 + omitted.active；其它行/畸形输入不计", () => {
    const fleet = [
      { status: "running", terminal: false },
      { status: "running" },
      { status: "completed", terminal: true },
      { status: "failed" },
      "junk",
      null,
    ];
    expect(fleetActiveCount(fleet, undefined)).toBe(2);
    expect(fleetActiveCount(fleet, { active: 3 })).toBe(5);
    expect(fleetActiveCount(undefined, { active: 2 })).toBe(2);
    expect(fleetActiveCount(undefined, undefined)).toBe(0);
    expect(fleetActiveCount("junk", { active: -1 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// orBannerView（横幅 状态→tone/icon 映射，minor）
// ---------------------------------------------------------------------------

describe("orBannerView（状态→tone 映射）", () => {
  it("failed → danger/alert/alert 不转；queued/parked → info loader 转；sending/awaiting → warn loader 转；idle/done → warn info 不转", () => {
    expect(orBannerView({ phase: "failed", error: "E_X" })).toEqual({
      tone: "danger",
      role: "alert",
      icon: "alert",
      spinning: false,
    });
    for (const phase of ["queued", "parked"] as const) {
      expect(orBannerView({ phase })).toEqual({ tone: "info", role: "status", icon: "loader", spinning: true });
    }
    for (const phase of ["sending", "awaiting"] as const) {
      expect(orBannerView({ phase })).toEqual({ tone: "warn", role: "status", icon: "loader", spinning: true });
    }
    for (const phase of ["idle", "done"] as const) {
      expect(orBannerView({ phase })).toEqual({ tone: "warn", role: "status", icon: "info", spinning: false });
    }
  });
});
