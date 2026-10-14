/**
 * droid 协议常量（external-agent plan §6.2 P3 冻结导出；§9「所有 spike 相关取值只在这里」）。
 *
 * 取值依据 docs/dev/external-agent/droid-protocol.md（§13 S1–S13 spike，本机 droid 0.241.1 实测）。
 * 标注「P5 固化」的常量由 tests/conformance/droid-protocol.test.ts 实测确认/回填。
 */

/** 信封版本（S6：droid 每条入站消息都带自身版本；请求侧版本 droid 不校验，但我方恒发钉住值）。 */
export const DROID_PROTOCOL_VERSION = "1.264.0";
export const DROID_API_VERSION = "1.0.0";
/** 仅信息展示：本适配器实测通过的 droid 版本。 */
export const DROID_TESTED_VERSIONS: readonly string[] = ["0.241.1"];

/** U2′：所有角色一律最高自治档（S8：echo autonomyLevel:"high" 可验证，全操作免确认）。 */
export const DROID_AUTONOMY_FULL = "high";
/** U2′/S2：显式关掉 droid 的「默认 ~1s 自动 cancel」，反向权限请求由 host 同步批准（§4.3）。 */
export const DROID_AUTO_REJECT_PERMISSIONS = false;
/** S2 实测应答形状：批准 = response result {selectedOption:"proceed_once"}。 */
export const DROID_PERMISSION_REPLY = { selectedOption: "proceed_once" } as const;
/** §4.3（review #3 定值）：批准后等 permission_resolved/tool_result/turn 结束回执的上界。 */
export const DROID_PERMISSION_ACK_TIMEOUT_MS = 10_000;
/** S12：挡住运行中自更新（= 中途协议漂移）。尽力而为；强保证由用户侧 update-policy.json 提供。 */
export const DROID_CHILD_ENV = {
  DISABLE_AUTO_UPDATE: "1",
  FACTORYD_DISABLE_AUTO_UPDATE: "1",
} as const;
/** S3：idle 关 stdin ~1s 自退。turn 中途 EOF 未实测 ⇒ P5 conformance D10 固化；不成立则改 false 启用哨兵。 */
export const DROID_EXITS_ON_STDIN_EOF = true;
/** E1（未实测，P5 D12 固化）：thinking token 已含在 output 计费口径内（true ⇒ 不按 output 重复计价）。 */
export const DROID_THINKING_IN_OUTPUT = true;
/** E3（未实测，P5 D13 固化）：cumulativeTokenUsage 不含 droid 原生子 agent 用量。 */
export const DROID_CUMULATIVE_INCLUDES_CHILD = false;

// ── 以下为本适配器内部取值（非冻结导出，但同属 spike 衍生，集中在此） ──

/** initialize_session 的 machineId（§4.4）。 */
export const DROID_MACHINE_ID = "pi-toolkit";
/** §4.1：一 run 一个 `droid exec` RPC 进程的固定 argv。 */
export const DROID_EXEC_ARGS = [
  "exec",
  "--input-format",
  "stream-jsonrpc",
  "--output-format",
  "stream-jsonrpc",
] as const;
/** arch §9 requestAbort：interrupt 后等 agent_turn_completed 的上界（reaper 外层另有 abortGraceMs 兜底）。 */
export const DROID_INTERRUPT_WAIT_MS = 5_000;
/** arch §8.1：get_context_stats 节流 / 单次超时 / 连败停用。 */
export const DROID_CONTEXT_STATS_THROTTLE_MS = 15_000;
export const DROID_CONTEXT_STATS_TIMEOUT_MS = 3_000;
export const DROID_CONTEXT_STATS_MAX_FAILURES = 3;
/** arch §8.1：credits 变化时 external_meta 的节流间隔。 */
export const DROID_EXTERNAL_META_THROTTLE_MS = 5_000;
/** §4.7：目录探测总上界（single-flight、unref、失败静默）。 */
export const DROID_CATALOG_PROBE_TIMEOUT_MS = 20_000;
/** plan r3（§14）：异常退出对账读 ~/.factory/sessions/<slug>/<sessionId>.settings.json 的字节上限。 */
export const DROID_SETTINGS_FILE_MAX_BYTES = 256 * 1024;
/** §4.8：首条消息 <agent-role> 里的工具名对照提示（pi 名 ≈ droid 名）。 */
export const DROID_TOOL_NAME_HINT =
  "pi read/bash/edit ≈ droid Read/Execute/Edit·ApplyPatch; pi grep/glob ≈ droid Grep/Glob; pi write ≈ droid Create";

/** 方法名（droid-protocol §2 实测 + 二进制证据）。 */
export const DROID_METHODS = {
  initializeSession: "droid.initialize_session",
  addUserMessage: "droid.add_user_message",
  interruptSession: "droid.interrupt_session",
  closeSession: "droid.close_session",
  updateSessionSettings: "droid.update_session_settings",
  getContextStats: "droid.get_context_stats",
  sessionNotification: "droid.session_notification",
  /** 反向请求（droid → host）。 */
  requestPermission: "droid.request_permission",
} as const;

/** host 对不支持的反向请求（droid.ask_user 等）的应答（§4.3）。 */
export const DROID_UNSUPPORTED_REQUEST_REPLY = {
  code: -32601,
  message: "not supported by pi-toolkit host",
} as const;

/** arch §5.3：resume 时向 transcript 追加的 custom 标记类型。 */
export const DROID_RESUME_CUSTOM_TYPE = "subagent:external-resume";

/** droid reasoningEffort 全档位（arch §8.3，低档→高档）。 */
export const DROID_EFFORT_ORDER = ["none", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
