/**
 * #23 P-A loop（plan §3 P-A 第 5 条）：真实 `reduce`（state.js）× 真实 `useOutdatedReload`
 * composable 的全链路——不走组件，但 wire 帧 → reducer → watch 签名 → notifyTick → 协调器
 * entry 的每一步都是生产实现。钉住：
 * - agent_up 新版本 ⇒ done（版本帧是成功判据）；
 * - agent_down / agent_stale / agent_removed / 快照不含目标 ⇒ E_OFFLINE（D4/D5）；
 * - agent_stale 后同 key agent_up（新版本）⇒ failed 收敛 done（D6，不跨 key）；
 * - 快照中目标已是新版本 ⇒ done；
 * - parked 期间新 key 顶上 ⇒ 旧 key E_OFFLINE、不发 reload cancel、新 key 保持 idle（D8）。
 */
import { nextTick, ref } from "vue";
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";
import { agentOffline, useOutdatedReload } from "../../../src/web-hub/ui/src/composables/useOutdatedReload.js";
import type { CmdOutcome, ControlHandle, HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";

type Msg = { event: string; data?: unknown; id?: number };

const HUB_FRAME: Msg = { event: "hub", data: { version: "0.10.6", caps: ["cmd.v1"] } };

function card(key: string, pluginVersion = "0.9.0", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentKey: key,
    kind: "tui",
    pid: 1,
    cwd: "/tmp/p",
    state: "live",
    pluginVersion,
    outdated: true,
    control: true,
    commands: [],
    prompts: [],
    ...extra,
  };
}

function makeLoop() {
  const state = ref(initialState());
  const sent: Array<{ key: string; args: string }> = [];
  const control = {
    runCommand: (key: string, _name: string, args: string) => {
      sent.push({ key, args });
      return Promise.resolve({ ok: true } satisfies CmdOutcome);
    },
  } as unknown as ControlHandle;
  const hub: HubHandle = { state, dispatch: () => {}, control };
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 1;
  const handle = useOutdatedReload({
    hub,
    storage: null,
    setTimeout: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (h) => void timers.delete(h as number),
    now: () => 0, // 固定时钟：deadline 恒 +30min，本文件只测帧驱动路径
  });
  /** 推一帧：reduce（同步）→ 微任务（send 的 promise 链）→ watch flush（notifyTick）→ 迁移链。 */
  async function push(msg: Msg): Promise<void> {
    state.value = reduce(state.value, msg);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await nextTick();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await nextTick();
  }
  return { handle, push, sent, timers, state };
}

async function boot(msgs: Msg[]) {
  const loop = makeLoop();
  for (const m of msgs) await loop.push(m);
  return loop;
}

describe("outdated-reload loop（真实 reduce + composable，#23 P-A）", () => {
  it("agent_up 新版本 ⇒ done（request → send → awaiting → 版本帧）", async () => {
    const { handle, push, sent } = await boot([HUB_FRAME, { event: "agents", data: [card("a1")] }]);
    handle.request("a1");
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await nextTick();
    expect(handle.entryOf("a1").phase).toBe("awaiting");
    expect(sent).toEqual([{ key: "a1", args: "reload" }]);
    await push({ event: "agent_up", data: { ...card("a1", "0.10.6"), outdated: false } });
    expect(handle.entryOf("a1").phase).toBe("done");
  });

  it("agent_down（等待中目标退出）⇒ E_OFFLINE", async () => {
    const { handle, push } = await boot([HUB_FRAME, { event: "agents", data: [card("a2")] }]);
    handle.request("a2");
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await nextTick();
    expect(handle.entryOf("a2").phase).toBe("awaiting");
    await push({ event: "agent_down", data: { agentKey: "a2", reason: "quit" } });
    expect(handle.entryOf("a2")).toMatchObject({ phase: "failed", error: "E_OFFLINE" });
  });

  it("agent_stale ⇒ E_OFFLINE；同 key agent_up 新版本 ⇒ failed 收敛 done（D6 不跨 key）", async () => {
    const { handle, push } = await boot([HUB_FRAME, { event: "agents", data: [card("a3")] }]);
    handle.request("a3");
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await nextTick();
    await push({ event: "agent_stale", data: { agentKey: "a3" } });
    expect(handle.entryOf("a3")).toMatchObject({ phase: "failed", error: "E_OFFLINE" });
    // 同 key 重现（reclaim/重注册）且版本到位：mergeCard 整卡替换，down 清零
    await push({ event: "agent_up", data: { ...card("a3", "0.10.6"), outdated: false } });
    expect(handle.entryOf("a3").phase).toBe("done");
  });

  it("agent_removed ⇒ E_OFFLINE 且 entry 保留（不随卡片消失清除，D9）", async () => {
    const { handle, push } = await boot([HUB_FRAME, { event: "agents", data: [card("a4"), card("other")] }]);
    handle.request("a4");
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await nextTick();
    expect(handle.entryOf("a4").phase).toBe("awaiting");
    await push({ event: "agent_removed", data: { agentKey: "a4" } });
    expect(handle.entryOf("a4")).toMatchObject({ phase: "failed", error: "E_OFFLINE" });
    expect(handle.entryOf("a4").phase).toBe("failed"); // entry 仍在（failed 相不删）
  });

  it("agents 快照不含目标 ⇒ E_OFFLINE；快照含新版本 ⇒ done", async () => {
    const gone = await boot([HUB_FRAME, { event: "agents", data: [card("a5")] }]);
    gone.handle.request("a5");
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await nextTick();
    expect(gone.handle.entryOf("a5").phase).toBe("awaiting");
    await gone.push({ event: "agents", data: [card("someone-else")] });
    expect(gone.handle.entryOf("a5")).toMatchObject({ phase: "failed", error: "E_OFFLINE" });

    const fresh = await boot([HUB_FRAME, { event: "agents", data: [card("a6")] }]);
    fresh.handle.request("a6");
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await nextTick();
    await fresh.push({ event: "agents", data: [{ ...card("a6", "0.10.6"), outdated: false }] });
    expect(fresh.handle.entryOf("a6").phase).toBe("done");
  });

  it("parked 期间新 key 顶上 ⇒ 旧 key E_OFFLINE、不调用 sendCancel、新 key idle（D8）", async () => {
    const { handle, push, sent } = await boot([HUB_FRAME, { event: "agents", data: [card("old")] }]);
    handle.request("old");
    // 送帧后、settle 前 fleet 变忙 ⇒ parked：request 的 promise 链在 push 的微任务步里
    // settle，读到的 fleetActive 已是 1（deferred reload 的 park 路径）。
    await push({ event: "fleet", data: { agentKey: "old", runs: [{ runId: "r1", status: "running" }] } });
    expect(handle.entryOf("old").phase).toBe("parked");
    // 新进程顶上：快照换成新 key（旧 key 消失）
    await push({ event: "agents", data: [{ ...card("a-new-pid", "0.10.6"), outdated: false }] });
    expect(handle.entryOf("old")).toMatchObject({ phase: "failed", error: "E_OFFLINE" });
    expect(sent.some((s) => s.args === "reload cancel")).toBe(false); // parked 下线不发 cancel（D5）
    expect(handle.entryOf("a-new-pid").phase).toBe("idle"); // 新 key 是独立实体（D8）
  });

  it("agentOffline（D4）：不在 agents ∨ down ∨ card.state stale；live ⇒ false", async () => {
    const { handle, push, state } = await boot([HUB_FRAME, { event: "agents", data: [card("a7")] }]);
    const live = state.value.agents.get("a7");
    expect(live).toBeDefined();
    expect(agentOffline(live)).toBe(false);
    expect(agentOffline(undefined)).toBe(true);
    await push({ event: "agent_stale", data: { agentKey: "a7" } });
    expect(agentOffline(state.value.agents.get("a7"))).toBe(true);
    await push({ event: "agent_up", data: { ...card("a7", "0.9.0") } }); // down 清零但版本仍旧
    expect(agentOffline(state.value.agents.get("a7"))).toBe(false);
    expect(handle.entryOf("a7").phase).toBe("idle");
  });
});
