/**
 * 运行模式门禁（traffic-merge plan §4.1 硬规则）。
 *
 * 网页服务与重放只存在于「主会话 ∧ ctx.mode ∈ {tui, rpc}」：print/json 模式不启动服务、无重放入口；
 * 子会话不注册命令、不建服务、engine 无子会话侧重放入口。engine 在创建时一次性固定 `serviceAllowed`，
 * `replay` / `startServer` 在不允许时抛 `E_REPLAY_MODE` 作纵深防御。
 */
export type TrafficRole = "host" | "child";
export type TrafficRunMode = "tui" | "rpc" | "json" | "print";

/** 是否允许网页服务与重放。未知 mode（undefined / 新值）一律不允许（fail closed）。 */
export function serviceAllowed(role: TrafficRole, mode: string | undefined): boolean {
  return role === "host" && (mode === "tui" || mode === "rpc");
}

export const PRINT_MODE_NOTE = "print 模式不启动网页服务";

export class TrafficModeError extends Error {
  readonly code = "E_REPLAY_MODE" as const;
  constructor(what: string) {
    super(`E_REPLAY_MODE: ${what}只在主会话的交互模式（tui/rpc）可用`);
    this.name = "TrafficModeError";
  }
}
