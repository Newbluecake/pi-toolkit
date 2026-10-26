/**
 * #65 outdated-reload（预览 outdated-reload-preview.html §1–§6）— `@logic/outdatedReload.ts`
 * 的纯逻辑门：落后判定（证据等级与 version-match §4 一致）、snooze 记忆键、OrCoordinator
 * 排队/送达/超时状态机、仪表盘汇总列表与批量进度。协调器用注入的假定时器驱动，不碰 Vue。
 */
import { describe, expect, it } from "vitest";
import {
  createOrCoordinator,
  fleetActiveCount,
  isSnoozed,
  OR_EFFECT_TIMEOUT_MS,
  OR_QUEUE_TIMEOUT_MS,
  OR_TOAST_MS,
  orBannerView,
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
  precheck: Map<string, "ok" | "offline" | "unsupported">;
  sendResults: Map<string, OrSendResult>;
  sent: string[];
  cancels: string[];
}

function makeWorld(): FakeWorld {
  return {
    main: new Set(),
    fleet: new Map(),
    settled: new Set(),
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
    send: (k) => {
      world.sent.push(k);
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
