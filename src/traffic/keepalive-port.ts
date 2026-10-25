/**
 * traffic → cache-ttl keepalive 只读否决端口（traffic-merge plan §7.3，T5；方案作者 consult 裁定）。
 *
 * 背景（§R1 #6 Major）：cache-ttl 的 keepalive capture 发生在 traffic 改写**之前**（before_provider_request 钩子捕获
 * 原始 payload，而 traffic 在 fetch 层按票据改写），旁路 ping 重放旧前缀会产生无意义的 cache 写费用。端口让
 * cache-keepalive 的发送闸门在每次 ping 前询问 traffic：
 *
 * - `rewriteArmed()`：engine open ∧ 录制中 ∧ 内存快照里有启用规则（= `engine.rewriteArmed()`）——规则启用期间暂停 ping；
 * - `vetoCapture(sessionId, capturedAt)`：该会话最近一次**实际改写**时刻 ≥ capture 时刻 ⇒ 旧 capture 必被否决；
 *   规则停用后，下一次**未改写**的真实请求产生新 capture（capturedAt > 最近改写时刻）即自愈。
 *
 * 约束（§7.1 / §5.2 / 作者裁定 / 安全评审 T5-#3）：
 * - **pi-free、零 import**（不得拉入 engine/db 等重模块；engine 以结构化视图传入）；**零顶层副作用**；
 *   **查询绝不创建容器**——端口未注册 / engine 不存在 ⇒ 恒「未启用」。
 * - **进程级改写标记**（作者裁定 must-fix）：engine 关闭（/record off→on、reload、shutdown）后 provider cache 里的
 *   改写前缀还在，否决信息不能随 engine 消失。`noteTrafficRewrite` 写入独立于端口的 `Symbol.for` 全局 Map
 *   （容量 `REWRITE_MARKS_CAP` FIFO），进程生命周期内不清，进程退出即逝。
 * - **never-throw（安全评审 T5-#3）**：`Symbol.for` 全局可被同进程任意扩展写成畸形值。本模块所有导出
 *   （`noteTrafficRewrite` / 端口方法 / `trafficVetoPing` / `peekTrafficKeepalivePort`）在**读取共享状态时做形状
 *   校验**并全程 try/catch 兜底——辅助否决记账的任何故障都不得阻断正常 provider 请求（写侧）或 keepalive
 *   调度（读侧）；失败计入 `trafficVetoStats` 并 warn 一次。
 * - **损坏方向的 fail 策略（不对称，刻意）**：
 *   - 标记损坏（非对象 / `map` 非 Map / 读抛错 / 条目值非有限数）⇒ `vetoCapture` **偏向否决**（视为「最近
 *     有过改写」）——宁少 ping 不发旧 capture；`noteTrafficRewrite` 的下一次写入会用新的合法结构**替换**
 *     畸形值（自愈），持久损坏则持续否决（keepalive 是优化，停摆只损失缓存命中，安全方向正确）。
 *   - 端口损坏 / 未注册 ⇒ **放行**（等价 traffic off 的冻结面：traffic 没说话就不否决）。
 *   - 同进程恶意扩展本就能替换 fetch / 注册恒真端口（评审「共享符号信任边界」），本模块只隔离**畸形**状态
 *     对正常请求的影响，不提供扩展间真实性隔离。
 * - 注销身份校验（claim 同款）：旧激活迟到的 unregister 不能删除新激活注册的端口。
 * - 时钟：标记与 cache-ttl 的 `capturedAt`（`captureRequest` 的 `Date.now()`）同源——`capture.ts` 出站边界
 *   `Date.now()` 写入，均为 wall-clock 毫秒。
 */

/** engine 的结构化只读视图。刻意不 import `engine.ts`（本模块不得引入重依赖；类型结构匹配即可）。 */
export interface TrafficVetoEngineView {
  /** `"open" | "closing" | "closed"`。 */
  readonly state: string;
  readonly recording: boolean;
  readonly rulesSnapshot: { readonly rules: readonly unknown[] };
}

/** traffic 暴露给 cache-ttl keepalive 的否决端口。 */
export interface TrafficKeepaliveVetoPort {
  /** open ∧ 录制中 ∧ 有启用规则。 */
  rewriteArmed(): boolean;
  /** 该会话最近一次实际改写 ≥ capturedAt，或 rewriteArmed()。 */
  vetoCapture(sessionId: string, capturedAt: number): boolean;
}

/** 进程级端口（消费点：`cache-keepalive.ts` 发送闸门与发送前 guard；未注册 ⇒ 行为字节不变）。 */
const PORT_KEY = Symbol.for("pi-subagent:traffic-keepalive-port");

/**
 * 进程级「会话最近一次被实际改写」标记。独立于端口生命周期：端口随激活注册/注销，标记只在进程退出时消失
 * （engine 关闭 / reload 后，旧 capture 的否决仍需生效）。
 */
const MARKS_KEY = Symbol.for("pi-subagent:traffic-rewrite-marks");

/** 标记容量（会话数，FIFO 淘汰最旧；作者裁定示例值 256）。 */
export const REWRITE_MARKS_CAP = 256;

interface RewriteMarks {
  v: 1;
  /** 插入序即 FIFO 序；同会话重写时先删再插（刷新位置，最新时刻最后淘汰）。 */
  map: Map<string, number>;
}

/**
 * 诊断计数（安全评审 T5-#3「失败计数」）：**仅观测**，绝不参与控制流；模块实例生命周期
 * （/reload 重置），不落盘。畸形共享状态首次出现时 `console.warn` 一次。
 */
export const trafficVetoStats = { marksFailures: 0, portFailures: 0 };

let corruptionWarned = false;

function noteSharedStateCorruption(what: string, detail: string): void {
  if (!corruptionWarned) {
    corruptionWarned = true;
    console.warn(
      `[pi-subagent] traffic: 进程共享否决状态畸形（${what}: ${detail}），已按保守策略处理；详情见 trafficVetoStats`,
    );
  }
}

/** 共享标记的形状校验：非对象 / v≠1 / map 非 Map ⇒ 畸形。 */
function isValidMarksShape(raw: unknown): raw is RewriteMarks {
  return (
    typeof raw === "object" &&
    raw !== null &&
    (raw as { v?: unknown }).v === 1 &&
    (raw as { map?: unknown }).map instanceof Map
  );
}

/** 端口的形状校验：非对象 / 两个方法不是函数 ⇒ 畸形（按未注册处理）。 */
function isValidPortShape(raw: unknown): raw is TrafficKeepaliveVetoPort {
  return (
    typeof raw === "object" &&
    raw !== null &&
    typeof (raw as { rewriteArmed?: unknown }).rewriteArmed === "function" &&
    typeof (raw as { vetoCapture?: unknown }).vetoCapture === "function"
  );
}

type MarksRead = { kind: "absent" } | { kind: "valid"; marks: RewriteMarks } | { kind: "corrupt"; raw: unknown };

/** 读共享标记（never-throw）：畸形 ⇒ corrupt（否决方向），读取本身抛错 ⇒ 同 corrupt。 */
function readMarks(): MarksRead {
  let raw: unknown;
  try {
    raw = (globalThis as Record<symbol, unknown>)[MARKS_KEY];
  } catch (err) {
    trafficVetoStats.marksFailures++;
    noteSharedStateCorruption("marks getter", err instanceof Error ? err.message : String(err));
    return { kind: "corrupt", raw: undefined };
  }
  if (raw === undefined) return { kind: "absent" };
  if (!isValidMarksShape(raw)) {
    trafficVetoStats.marksFailures++;
    noteSharedStateCorruption("marks shape", String(raw));
    return { kind: "corrupt", raw };
  }
  return { kind: "valid", marks: raw };
}

/**
 * engine 在**出站边界**（改写后的请求即将发给下游，每次发送含重试）调用。与 `engine.lastRewrittenAt`（engine
 * 生命周期）同一时刻写入；本标记是它的进程级镜像，供端口在 engine 关闭后继续否决旧 capture。
 *
 * never-throw（安全评审 T5-#3）：畸形/缺失的共享结构用新的合法结构**替换**（下一次改写即自愈），任何一步
 * 抛错都吞掉并计数——辅助记账绝不阻断 provider 发送（`capture.ts` 调用点另有兜底 try/catch）。
 */
export function noteTrafficRewrite(sessionId: string, at: number): void {
  try {
    if (sessionId === "" || !Number.isFinite(at)) return;
    const g = globalThis as Record<symbol, unknown>;
    const read = readMarks();
    if (read.kind === "corrupt") {
      trafficVetoStats.marksFailures++; // 读侧已计一次；写侧替换动作再计（同一畸形只 warn 一次）
      noteSharedStateCorruption("marks replaced by write", String(read.raw));
    }
    const marks: RewriteMarks = read.kind === "valid" ? read.marks : { v: 1, map: new Map<string, number>() };
    const map = marks.map;
    if (map.has(sessionId)) map.delete(sessionId);
    map.set(sessionId, at);
    while (map.size > REWRITE_MARKS_CAP) {
      const oldest = map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
    // 仅在**替换**畸形结构时写回全局（合法结构的 map 已就地更新；写回本身可能撞上只读访问器 ⇒ 外层兜底）。
    if (read.kind !== "valid") g[MARKS_KEY] = marks;
  } catch (err) {
    trafficVetoStats.marksFailures++;
    noteSharedStateCorruption("marks write", err instanceof Error ? err.message : String(err));
  }
}

/** 测试隔离：清空进程级改写标记（生产代码永不调用）。 */
export function resetTrafficRewriteMarksForTest(): void {
  corruptionWarned = false;
  delete (globalThis as Record<symbol, unknown>)[MARKS_KEY];
}

/**
 * 构造端口。`readEngine` 每次调用时现读（不得缓存 engine 引用——reload 后旧 engine 必须立刻失效）。
 * `opts.isSecure` 可选（secure 会话 traffic 根本不接线，端口恒为否决关闭；传入只是纵深防御）。
 * 端口方法 never-throw：engine 读取 / 标记读取抛错均按各自保守方向处理。
 */
export function createTrafficKeepalivePort(
  readEngine: () => TrafficVetoEngineView | undefined,
  opts: { isSecure?: () => boolean } = {},
): TrafficKeepaliveVetoPort {
  const rewriteArmed = (): boolean => {
    try {
      if (opts.isSecure?.()) return false;
      const engine = readEngine();
      return !!engine && engine.state === "open" && engine.recording && engine.rulesSnapshot.rules.length > 0;
    } catch {
      // 读内存快照不应抛；抛了按「未上膛」处理（fail-open，不否决）。
      return false;
    }
  };
  return {
    rewriteArmed,
    vetoCapture(sessionId: string, capturedAt: number): boolean {
      try {
        if (rewriteArmed()) return true;
        const read = readMarks();
        // 损坏 ⇒ 否决（视为「最近有改写」：宁少 ping 不发旧 capture；下次 noteTrafficRewrite 替换结构自愈）。
        if (read.kind === "corrupt") return true;
        if (read.kind === "absent") return false;
        const at = read.marks.map.get(sessionId);
        if (at === undefined) return false;
        // 条目值损坏（非有限数）⇒ 同一保守方向：否决该 capture（该条在下次该会话改写时被覆盖修复）。
        if (typeof at !== "number" || !Number.isFinite(at)) {
          trafficVetoStats.marksFailures++;
          noteSharedStateCorruption("marks entry", String(at));
          return true;
        }
        return at >= capturedAt;
      } catch (err) {
        trafficVetoStats.marksFailures++;
        noteSharedStateCorruption("vetoCapture", err instanceof Error ? err.message : String(err));
        return true; // 读侧异常 ⇒ 保守否决
      }
    },
  };
}

/** 注册进程级端口；返回**身份校验**注销函数（全局仍是本端口时才删除，防旧激活迟到注销删新端口）。 */
export function registerTrafficKeepalivePort(port: TrafficKeepaliveVetoPort): () => void {
  const g = globalThis as Record<symbol, unknown>;
  g[PORT_KEY] = port;
  return () => {
    if (g[PORT_KEY] === port) delete g[PORT_KEY];
  };
}

/**
 * 读进程级端口（不创建任何东西）。traffic off ⇒ undefined；**畸形端口 ⇒ 同 undefined**（放行方向：
 * 等价 traffic off 冻结面——traffic 没说话就不否决），计数。
 */
export function peekTrafficKeepalivePort(): TrafficKeepaliveVetoPort | undefined {
  let raw: unknown;
  try {
    raw = (globalThis as Record<symbol, unknown>)[PORT_KEY];
  } catch (err) {
    trafficVetoStats.portFailures++;
    noteSharedStateCorruption("port getter", err instanceof Error ? err.message : String(err));
    return undefined;
  }
  if (raw === undefined) return undefined;
  if (!isValidPortShape(raw)) {
    trafficVetoStats.portFailures++;
    noteSharedStateCorruption("port shape", String(raw));
    return undefined;
  }
  return raw;
}

/**
 * 发送闸门 / 发送前 guard 消费点（`cache-keepalive.ts`）：端口未注册（traffic off）、畸形或抛错 ⇒ 恒 `false`
 * （keepalive 行为与输出字节不变）；否则询问 `vetoCapture`。
 */
export function trafficVetoPing(sessionId: string, capturedAt: number): boolean {
  const port = peekTrafficKeepalivePort();
  if (!port) return false;
  try {
    return port.vetoCapture(sessionId, capturedAt);
  } catch (err) {
    trafficVetoStats.portFailures++;
    noteSharedStateCorruption("port call", err instanceof Error ? err.message : String(err));
    return false;
  }
}
