/**
 * `/webhub status`'s privacy-lock text (web-hub-privacy plan v2.1, P3). Pure formatting only —
 * no I/O, no pi imports — mirrors `lan-status.ts`/`ui-status.ts`'s shape so
 * `commands/webhub.ts` can interleave these lines with the others exactly the same way.
 *
 * `formatPrivacyStatusLines` covers four cases:
 *  - the feature is settings-off ⇒ no lines at all (the operator chose off; status stays silent
 *    rather than advertising a disabled feature).
 *  - `privacy` is `undefined` because there is no readable hub.json (hub not running) ⇒ no
 *    lines: `formatStatus`'s main line already reports the stopped state.
 *  - `privacy` is `undefined` but hub.json IS there (old hub predating the field, or a
 *    settings change that hasn't taken effect yet — the setting is non-live) ⇒ one warning
 *    line saying the lock is unavailable until the hub is current.
 *  - present ⇒ one info line stating the two-listener behavior difference (plan「接口」N1:
 *    LAN re-verifies with the LAN password, loopback/token has no second credential so the
 *    lock screen is a click-to-confirm), plus a warning when the store booted degraded
 *    (privacy.json was corrupt → renamed `.bak`, marks cleared).
 */
import type { PrivacyHubStatus } from "../protocol/privacy.js";

export interface FormatPrivacyStatusOptions {
  /** Agent-side settings value (`webHub.privacy`, default true) — the same value the hub's
   * `HubConfig.privacy` is derived from. */
  readonly settingsEnabled: boolean;
  /** Whether a readable hub.json record exists at all (hub running or crashed-and-stale). */
  readonly hasHubRecord: boolean;
}

export function formatPrivacyStatusLines(
  privacy: PrivacyHubStatus | undefined,
  o: FormatPrivacyStatusOptions,
): string[] {
  if (!o.settingsEnabled) return [];
  if (privacy === undefined) {
    if (!o.hasHubRecord) return [];
    return ["warning：hub 未挂载隐私锁（hub 版本早于 privacy.v1，或设置改动未生效——/reload 后 /webhub restart）。"];
  }
  const lines = ["privacy=on —— LAN 查看锁定会话需输密码；loopback（token）无第二凭证，锁屏为点击确认。"];
  if (privacy.degraded === true) {
    lines.push("warning：privacy.json 损坏已改名 .bak，锁标记已清空（详见 hub 日志）。");
  }
  return lines;
}
