/**
 * traffic · settings (#56 batch 2 ⑧): the `traffic` block's types, frozen defaults and never-throws parser.
 * `src/config/settings.ts` imports ONLY this module for the block (the secure-domain force-off of
 * `traffic.enabled` stays in the aggregator).
 */

export interface TrafficWebSettings {
  /** 绑定地址（拍板②）：默认仅回环；`"0.0.0.0"` = LAN 显式 opt-in。 */
  host: "127.0.0.1" | "0.0.0.0";
  /** 起始端口（占用自增，最多 20 次）。 */
  port: number;
}

export interface TrafficSettings {
  /** 总开关，默认 false。off ⇒ 不调用任何 wire 函数；secure/locked 域强制 false（§6）。 */
  enabled: boolean;
  /** 子会话请求是否落库（拍板①，默认 true）：为 false 时子会话钩子仍注册（票据仍用于改写归属），只是不写行。 */
  childSessions: boolean;
  web: TrafficWebSettings;
}

export const DEFAULT_TRAFFIC_SETTINGS: TrafficSettings = {
  enabled: false,
  childSessions: true,
  web: { host: "127.0.0.1", port: 4177 },
};

/** 解析 `traffic` 组：逐字段回落默认，永不抛错（web.host 只接受两个枚举值，端口整数 1024..65535）。 */
export function parseTrafficSettings(input: unknown): TrafficSettings {
  const d = DEFAULT_TRAFFIC_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...d, web: { ...d.web } };
  const value = input as Record<string, unknown>;
  const webInput = value.web;
  const web =
    webInput && typeof webInput === "object" && !Array.isArray(webInput) ? (webInput as Record<string, unknown>) : {};
  const host = web.host;
  const port = web.port;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : d.enabled,
    childSessions: typeof value.childSessions === "boolean" ? value.childSessions : d.childSessions,
    web: {
      host: host === "0.0.0.0" ? "0.0.0.0" : d.web.host,
      port: typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : d.web.port,
    },
  };
}
