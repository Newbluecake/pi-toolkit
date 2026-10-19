/**
 * `/webhub status`'s port-proxy text (web-hub-proxy plan v2 §5, package X1c). Pure formatting only
 * — no I/O, no pi imports — mirrors `privacy-status.ts`/`lan-status.ts` so `commands/webhub.ts`
 * interleaves these lines exactly like the others (first line decides the level: `proxy: on …` ⇒
 * info, everything else ⇒ warning).
 *
 * Cases:
 *  - settings off ⇒ no lines at all (the operator chose off; status stays silent);
 *  - settings on, `webHub.control:false` ⇒ one warning (the proxy is a control-plane feature,
 *    `buildHubConfig` never writes `config.proxy`);
 *  - settings on, no readable hub.json (hub not running) ⇒ the settings line + warnings only
 *    (the main status line already reports the stopped state);
 *  - settings on, hub.json present but no `proxy` key (old hub, a setting change that has not
 *    taken effect yet — non-live — or `hub/main.ts` dropped a malformed / port-overlapping
 *    `config.proxy`) ⇒ one warning;
 *  - `portsStore: "broken"` ⇒ the prose recovery note (plan §3.3: never auto-cleared; manual only);
 *  - LAN + `allowlistActive` ⇒ the first line gains the English marker ` · allowlist` (proxy listeners
 *    share the hub's client allowlist);
 *  - every `parseWebHubProxyBlock` warning ⇒ one prose line naming the fallback.
 * Compact inline markers stay English (`proxy: on · lan · 7900-7949 · max 8`); prose blocks Chinese.
 */
import type { WebHubProxyWarning } from "../../config/settings.js";

/** The `proxy` slot of `hub.json` (`hub/hub-json.ts`'s `HubRecord.proxy`; state only). */
export interface ProxyHubStatus {
  readonly portsStore: "ok" | "broken";
}

export interface FormatProxyStatusOptions {
  /** Effective agent-side `webHub.proxy` (undefined ⇒ treated as off). */
  readonly settings: { readonly enabled: boolean; readonly portRange: string; readonly maxProxies: number } | undefined;
  /** `webHub.lan.enabled` — LAN reach follows it (Q2). */
  readonly lan: boolean;
  /** `webHub.control !== false`. */
  readonly control: boolean;
  /** `parseWebHubProxyBlock`'s warnings from the raw settings file. */
  readonly warnings: readonly WebHubProxyWarning[];
  /** Whether a readable hub.json record exists at all. */
  readonly hasHubRecord: boolean;
  /** Absolute path of `<stateDir>/proxy/ports.json`, for the recovery note. */
  readonly portsFile: string;
  /**
   * LAN security §2.3 #3: the hub's client allowlist is active (`LanStatus.on.allowClients` present) —
   * every proxy listener enforces it at connection level (denied peers get no bytes). Absent/false ⇒
   * output byte-identical to before.
   */
  readonly allowlistActive?: boolean;
}

const WARNING_TEXT: Readonly<Record<WebHubProxyWarning, string>> = {
  "port-range-invalid":
    'warning：webHub.proxy.portRange 格式无效（需 "<lo>-<hi>"，端口 1024–65535，至多 256 个），已回退默认 7900-7949。',
  "port-range-overlap": "warning：webHub.proxy.portRange 与 webHub.port / webHub.lan.port 重叠，已回退默认 7900-7949。",
  "max-proxies-invalid": "warning：webHub.proxy.maxProxies 需为 1–16 的整数，已回退默认 8。",
};

export function formatProxyStatusLines(proxy: ProxyHubStatus | undefined, o: FormatProxyStatusOptions): string[] {
  const s = o.settings;
  if (s === undefined || !s.enabled) return [];
  if (!o.control) {
    return ["warning：webHub.proxy.enabled=true 但 webHub.control=false，端口代理未启用（它属于控制面）。"];
  }
  const lines = [
    `proxy: on · ${o.lan ? "lan" : "loopback"} · ${s.portRange} · max ${String(s.maxProxies)}` +
      (o.lan && o.allowlistActive === true ? " · allowlist" : ""),
  ];
  for (const w of o.warnings) lines.push(WARNING_TEXT[w]);
  if (proxy === undefined) {
    if (o.hasHubRecord) {
      lines.push(
        "warning：hub 未挂载端口代理（hub 版本早于 proxy.v1、设置改动未生效——/reload 后 /webhub restart，或端口范围与 hub/LAN 端口冲突被 hub 丢弃）。",
      );
    }
    return lines;
  }
  if (proxy.portsStore === "broken") {
    lines.push(
      `warning：端口代理的 ports.json 损坏或不可写，所有「打开本机端口」请求都会失败。手动恢复：先 /webhub stop，再删除 ${o.portsFile}（会遗忘全部 目标↔端口 绑定，浏览器可能仍保留这些端口的旧 origin 存储）。`,
    );
  }
  return lines;
}
