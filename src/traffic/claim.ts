/**
 * 认领协议（traffic-merge plan §2.4，Blocker 2）：活动录制器恰为 1，单向优先级——
 * 已证实活动的外部录制器优先，toolkit 让位；外部墓碑版（v0.3.0）只对**有效且存活、身份可校验**的
 * toolkit claim 让位。仅凭 settings 字符串不构成让位依据。
 *
 * 两个进程级符号（纯内存，不落盘；主会话与子会话同进程，共享同一份）：
 * - `Symbol.for("pi-traffic-record:claim")`：toolkit 主会话 activate 发布、shutdown 身份校验释放。
 *   `enabled=false` 的激活**永不发布**（reload 开→关 ⇒ 旧激活已释放、新激活不发布 ⇒ 无残留压制外部包）。
 * - `Symbol.for("pi-traffic-record:external-active")`：外部墓碑版成为活动录制器时发布（T8 外部侧实现）。
 *
 * 本模块 pi-free、零 IO、零模块级可变状态（一切状态都在 globalThis 符号与 claim 对象上）。
 */
export const TRAFFIC_CLAIM_KEY = Symbol.for("pi-traffic-record:claim");
export const TRAFFIC_EXTERNAL_ACTIVE_KEY = Symbol.for("pi-traffic-record:external-active");

/** 发布/释放同一模块实例内部的 kill 句柄（const symbol：跨模块实例不可见，见 releaseToolkitClaim）。 */
const KILL_KEY = Symbol("pi-toolkit:traffic-claim-kill");

/** toolkit 发布的 claim。`token` 即 wireTrafficHost 的 `owner`（同一对象）；外部墓碑版按
 * `v===1 ∧ owner==="pi-toolkit" ∧ pid===process.pid ∧ isLive()` 判定让位。 */
export interface ToolkitTrafficClaim {
  readonly v: 1;
  readonly owner: "pi-toolkit";
  readonly token: object;
  readonly pid: number;
  isLive(): boolean;
}

/** 外部墓碑版发布的活动标记（形状容错：v 必须为 1）。 */
export interface ExternalActiveMarker {
  readonly v: 1;
  readonly version?: unknown;
  readonly pid: number;
}

type GlobalBag = Record<symbol, unknown>;

function readClaim(): ToolkitTrafficClaim | undefined {
  const value = (globalThis as GlobalBag)[TRAFFIC_CLAIM_KEY] as ToolkitTrafficClaim | undefined;
  return value !== null && typeof value === "object" && value.v === 1 && value.owner === "pi-toolkit"
    ? value
    : undefined;
}

/** 形状 + 存活校验：token 必须是非空对象，isLive 必须是函数且返回 true（抛错按 false，fail closed）。
 * 同进程同权限扩展仍可伪造 token+isLive（信任边界见评审报告「共享符号」节）——这里只祥堵形状漏洞：
 * 已释放 claim（isLive=false）被挂回、或缺 token / 缺 isLive / isLive 非函数的形状不再被当有效。 */
function claimWellFormedAndLive(claim: ToolkitTrafficClaim): boolean {
  if (claim.token === null || typeof claim.token !== "object") return false;
  if (typeof claim.isLive !== "function") return false;
  try {
    return claim.isLive() === true;
  } catch {
    return false;
  }
}

/** 外部墓碑版是否已在本进程活动（§2.4 步骤 1：toolkit 整体让位、不发布 claim、零注册）。 */
export function externalActiveInProcess(): boolean {
  const value = (globalThis as GlobalBag)[TRAFFIC_EXTERNAL_ACTIVE_KEY] as ExternalActiveMarker | undefined;
  return value !== null && typeof value === "object" && value.v === 1 && value.pid === process.pid;
}

/**
 * 发布 claim（仅主会话 activate，同步）。`token` 与 `wireTrafficHost` 的 `owner` 是同一对象。
 * 若符号上已有残留 claim（理论上不可达：shutdown 必释放），覆盖发布。
 */
export function publishToolkitClaim(token: object): ToolkitTrafficClaim {
  const g = globalThis as GlobalBag;
  const state = { live: true };
  const claim: ToolkitTrafficClaim & { [KILL_KEY]?: () => void } = {
    v: 1,
    owner: "pi-toolkit",
    token,
    pid: process.pid,
    isLive: () => state.live,
    [KILL_KEY]: () => {
      state.live = false;
    },
  };
  g[TRAFFIC_CLAIM_KEY] = claim;
  return claim;
}

/**
 * 身份校验释放（§2.4）：只在符号上仍是**这个** claim（同一对象）时 isLive=false 并删除符号。
 * 返回是否真的释放。发布与释放总是同一激活（同一模块实例），kill 句柄可达；跨实例清理（不可达路径）
 * 至少删除符号——`toolkitClaimIsLive` 以符号存在为准。进程崩溃 ⇒ 内存符号随进程消失，无需兜底。
 */
export function releaseToolkitClaim(claim: ToolkitTrafficClaim): boolean {
  const g = globalThis as GlobalBag;
  if (g[TRAFFIC_CLAIM_KEY] !== claim) return false;
  (claim as { [KILL_KEY]?: () => void })[KILL_KEY]?.();
  delete g[TRAFFIC_CLAIM_KEY];
  return true;
}

/**
 * 进程级「toolkit 是活动录制器」判定：符号上存在 v=1 的 toolkit claim（本进程 pid）且
 * **形状与存活校验通过**（token 非空对象、isLive()===true；评审 #4：已释放 claim 被挂回不再有效）。
 * 子会话钩子的 isActive 共享端口读它；claim 被释放（shutdown / session_start 复核让位）后
 * 一切钩子与命令立即失效。
 */
export function toolkitClaimIsLive(): boolean {
  const claim = readClaim();
  return claim !== undefined && claim.pid === process.pid && claimWellFormedAndLive(claim);
}

/**
 * 本激活的 claim 是否仍是进程认领者（评审 #4：主会话 isActive 绑定自身 claim 对象身份，
 * 不只问「某个 toolkit claim 是否存在」——别的/伪造的 claim 在符号上时本激活必须失效）。
 */
export function claimIsOurs(claim: ToolkitTrafficClaim): boolean {
  return readClaim() === claim && claimWellFormedAndLive(claim);
}

/** 仅测试：清掉本进程的两个协议符号（不触碰 engine/tap）。 */
export function resetTrafficClaimForTest(): void {
  delete (globalThis as GlobalBag)[TRAFFIC_CLAIM_KEY];
  delete (globalThis as GlobalBag)[TRAFFIC_EXTERNAL_ACTIVE_KEY];
}

/** 仅测试：模拟外部墓碑版发布 external-active。 */
export function publishExternalActiveForTest(version = "0.3.0"): void {
  (globalThis as GlobalBag)[TRAFFIC_EXTERNAL_ACTIVE_KEY] = { v: 1, version, pid: process.pid };
}
