/**
 * `/webhub 2fa enroll` 的交互编排（LAN security r2 §5.8，package F）。
 *
 * Pi-free by convention（同 `passwd-prompt.ts`/`feishu-admin.ts`）：连接、提示、渲染全部注入，
 * 整个流程可在无 pi 环境下单测。密钥纪律（§5.8 "Secret transport boundary"）：
 * `otpauthUri`/`secretB32`/`recoveryCodes` 只经由 `showEnrollment`/`showRecoveryCodes`
 * 两个注入回调渲染到本地 TUI——本模块自身从不把它们写进 notify 以外的任何通道，
 * 且 `runTwofaEnrollPrompt` 只能被 `twofa-cmd.ts` 在 TUI-only 闸门之后调用。
 */
import { randomUUID } from "node:crypto";
import { TOTP_CODE_RE, type TfaReqFrame, type TfaResFrame } from "../protocol/lan-2fa.js";
import { LAN_2FA_HUB_CAP } from "../protocol/version.js";

export interface TwofaPromptDeps {
  hasCap(cap: string): boolean;
  request(frame: TfaReqFrame, requiredCap: string): Promise<TfaResFrame>;
  promptCode(title: string): Promise<string | undefined>;
  /** F supplies renderQr + base32 fallback; no browser/Feishu output. */
  showEnrollment(input: { otpauthUri: string; secretB32: string }): void;
  showRecoveryCodes(codes: readonly string[]): void;
  hasFeishuOwner(): Promise<boolean>;
}

export type TwofaPromptOutcome =
  // `newRecoveryCodes:false` — B contract (P0 addendum #4): the user already had a recovery set,
  // so commitTotp answered the `{kind:"ok"}` variant and nothing new was shown.
  | { ok: true; newRecoveryCodes: boolean }
  | { ok: false; reason: "no-cap" | "cancelled" | "rejected"; code?: string; message?: string };

function transportMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * enroll 流程：`totp_begin`（可选 replace）→ 渲染 QR + base32 兜底 → 掩码输入 6 位验证码 →
 * `totp_confirm` → 恢复码只渲染一次。用户中途取消时 hub 侧的 pending secret 有 5 分钟 TTL，
 * 无需（也无法）显式撤销——帧 union 里没有 cancel 变体（P0 冻结）。
 */
export async function runTwofaEnrollPrompt(deps: TwofaPromptDeps, replace = false): Promise<TwofaPromptOutcome> {
  if (!deps.hasCap(LAN_2FA_HUB_CAP)) return { ok: false, reason: "no-cap" };
  let begin: TfaResFrame;
  try {
    begin = await deps.request(
      { t: "tfa_req", rid: randomUUID(), op: "totp_begin", ...(replace ? { replace: true } : {}) },
      LAN_2FA_HUB_CAP,
    );
  } catch (err) {
    return { ok: false, reason: "rejected", message: transportMessage(err) };
  }
  if (!begin.ok) return { ok: false, reason: "rejected", code: begin.code, message: begin.message };
  if (begin.data.kind !== "totp_begin") {
    return { ok: false, reason: "rejected", message: "hub 返回了意外的响应形状（非 totp_begin）。" };
  }
  deps.showEnrollment({ otpauthUri: begin.data.otpauthUri, secretB32: begin.data.secretB32 });
  const code = (await deps.promptCode("输入验证器中的 6 位验证码"))?.trim();
  if (code === undefined || code === "") return { ok: false, reason: "cancelled" };
  // §5.3：格式在本地先校验， malformed 输入不产生任何验证尝试（不消耗 attempts，不发 IPC）。
  if (!TOTP_CODE_RE.test(code)) {
    return { ok: false, reason: "rejected", message: "验证码必须是 6 位数字。" };
  }
  let confirm: TfaResFrame;
  try {
    confirm = await deps.request({ t: "tfa_req", rid: randomUUID(), op: "totp_confirm", code }, LAN_2FA_HUB_CAP);
  } catch (err) {
    return { ok: false, reason: "rejected", message: transportMessage(err) };
  }
  if (!confirm.ok) return { ok: false, reason: "rejected", code: confirm.code, message: confirm.message };
  if (confirm.data.kind === "totp_confirm") {
    // 「codes printed once」（§10 F 行）：恢复码只在这里渲染一次，之后只能 recovery_regen 重新生成。
    deps.showRecoveryCodes(confirm.data.recoveryCodes);
    return { ok: true, newRecoveryCodes: true };
  }
  if (confirm.data.kind === "ok") {
    // B contract (P0 addendum #4): 已有恢复码集合被保留——确认成功，但没有新恢复码可显示。
    return { ok: true, newRecoveryCodes: false };
  }
  return { ok: false, reason: "rejected", message: "hub 返回了意外的响应形状（非 totp_confirm/ok）。" };
}
