/**
 * `/webhub 2fa …`（LAN security r2 §5.8，package F）的 agent 侧命令实现。
 *
 * 信任边界（r1 #4 / §5.8 Gate）：除 `status` 外的每个子命令都先过
 * `ctx.mode === "tui" && !isWebInvocation(ctx)` 闸门——在发送任何 `tfa_req` 帧、渲染任何
 * QR/密钥/恢复码之前。该闸门独立于 web 命令策略（`webhub: allow` 覆盖也无效），
 * 因为 web 捕获的命令上下文保持 `mode:"tui"` 但带 `webInvocation` 标记
 * （`command-capture.ts` 的 `createCapturedCtx`）。
 *
 * 密钥纪律：本模块从不把 `otpauthUri`/`secretB32`/`recoveryCodes` 写进日志或状态行；
 * 它们只经注入的 `showEnrollment`/`showRecoveryCodes` 渲染到本地终端。
 */
import { randomUUID } from "node:crypto";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TfaReqFrame, TfaResData, TfaResFrame } from "../protocol/lan-2fa.js";
import { LAN_2FA_HUB_CAP } from "../protocol/version.js";
import { isWebInvocation } from "../../commands/capture.js";
import { runTwofaEnrollPrompt, type TwofaPromptDeps } from "./twofa-prompt.js";

export interface TwofaCommandDeps extends TwofaPromptDeps {
  notify(message: string, level: "info" | "warning" | "error"): void;
}

/** `tfa_req status` 响应的数据变体（§5.8 P0 冻结 union 的 `status` 分支）。 */
export type TfaStatusData = Extract<TfaResData, { kind: "status" }>;

/** Cap gate can be tested before F is implemented. Old hubs must never receive unknown frames. */
export function requestTfa(
  deps: Pick<TwofaPromptDeps, "hasCap" | "request">,
  frame: TfaReqFrame,
): Promise<TfaResFrame> {
  if (!deps.hasCap(LAN_2FA_HUB_CAP))
    return Promise.resolve({
      t: "tfa_res",
      rid: frame.rid,
      ok: false,
      code: "E_UNSUPPORTED",
      message: "hub 版本过旧，请 /webhub restart",
    });
  return deps.request(frame, LAN_2FA_HUB_CAP);
}

/**
 * §6 / P0-addendum-2：F 只负责「取」2FA 状态——`/webhub status` 的 lan 行渲染归 A
 * （`agent/lan-status.ts`），I 把这里取到的 `TfaStatusData` 传进去。静默语义：
 * 无 cap、传输失败、意外形状一律 `undefined`（状态行缺省不显示，绝不让状态查询炸掉 status）。
 */
export async function fetchTfaStatus(
  deps: Pick<TwofaPromptDeps, "hasCap" | "request">,
): Promise<TfaStatusData | undefined> {
  const res = await requestTfa(deps, { t: "tfa_req", rid: randomUUID(), op: "status" }).catch(() => undefined);
  if (res === undefined || !res.ok || res.data.kind !== "status") return undefined;
  return res.data;
}

/** §6 状态段：`2fa=totp+feishu（恢复码剩 7）` | `2fa=off` | `2fa=inconsistent` + repair 提示。 */
export function formatTfaStatusLines(data: TfaStatusData): string[] {
  if (data.state === "none") {
    return ["2fa=off —— LAN 登录仅校验密码；/webhub 2fa enroll 启用 TOTP，/webhub 2fa feishu on 启用飞书审批。"];
  }
  if (data.state === "inconsistent") {
    return [
      "2fa=inconsistent —— 2FA 数据不一致，新 IP 的 LAN 登录会被拒绝（503）。",
      `请执行 /webhub 2fa repair --confirm 修复（将清空 2FA 数据，之后需重新 enroll）。`,
    ];
  }
  const factors = [data.totp ? "totp" : "", data.feishu ? "feishu" : ""].filter((f) => f !== "").join("+");
  const lines = [`2fa=${factors}（恢复码剩 ${data.recoveryLeft}，30 天内已知 IP ${data.knownIps} 个）`];
  if (data.repairNeeded !== undefined) {
    lines.push(`2FA 需要修复（${data.repairNeeded}）：/webhub 2fa repair --confirm`);
  }
  return lines;
}

/** hub 侧拒绝码 → 面向用户的单行文案（从不回显用户输入的验证码/恢复码）。 */
export function formatTfaError(code: string, message: string): string {
  switch (code) {
    case "E_UNSUPPORTED":
      return message; // 请求侧已带中文提示（「hub 版本过旧，请 /webhub restart」）
    case "E_NO_LAN":
      return "LAN 未启用或当前不可用。";
    case "E_NO_USER":
      return "尚无 LAN 用户（先通过 /webhub passwd 设置密码）。";
    case "E_2FA_ENROLLED":
      return "已注册 TOTP；如需更换请使用 /webhub 2fa enroll --replace。";
    case "E_2FA_CODE":
      return "验证码不正确。";
    case "E_2FA_STALE":
      return "2FA 状态在操作期间已变化，请重新执行。";
    case "E_2FA_NONE":
      return "未启用 2FA（或没有待完成的注册）。";
    case "E_NO_FEISHU":
      return "飞书机器人未就绪：需要先 /webhub feishu setup 并确认 owner。";
    default:
      return `操作失败：${message}`;
  }
}

const TWOFA_USAGE =
  "用法：/webhub 2fa status | enroll [--replace] | feishu on|off | recovery | reset --confirm | forget-ips | repair --confirm";

/** r1 #4 / §5.8：TUI-only 闸门，独立于命令策略；必须在任何帧/渲染之前调用。 */
function isTrustedTui(ctx: ExtensionCommandContext): boolean {
  return ctx.mode === "tui" && !isWebInvocation(ctx);
}

const TUI_ONLY_REFUSAL =
  "该子命令涉及二次验证密钥/恢复码，仅允许在本地 TUI 执行；web/LAN 触发的调用一律拒绝（与命令策略无关）。";

export async function runTwofaCommand(
  args: string,
  ctx: ExtensionCommandContext,
  deps: TwofaCommandDeps,
): Promise<void> {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const sub = tokens[0];
  const rest = tokens.slice(1);
  const fail = (res: Extract<TfaResFrame, { ok: false }>): void => {
    deps.notify(formatTfaError(res.code, res.message), "warning");
  };

  switch (sub) {
    case "status": {
      // §5.8：status 不含任何密钥，web-safe，无需 TUI 闸门。
      if (rest.length > 0) {
        deps.notify("/webhub 2fa status 不接受任何参数。", "warning");
        return;
      }
      const res = await requestTfa(deps, { t: "tfa_req", rid: randomUUID(), op: "status" }).catch(
        (err: unknown): TfaResFrame => ({
          t: "tfa_res",
          rid: "-",
          ok: false,
          code: "E_INTERNAL",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      if (!res.ok) {
        fail(res);
        return;
      }
      if (res.data.kind !== "status") {
        deps.notify("hub 返回了意外的信息形状（非 status 视图）。", "error");
        return;
      }
      for (const line of formatTfaStatusLines(res.data)) deps.notify(line, "info");
      return;
    }
    case "enroll": {
      let replace = false;
      if (rest.length === 1 && rest[0] === "--replace") replace = true;
      else if (rest.length > 0) {
        deps.notify("用法：/webhub 2fa enroll [--replace]", "warning");
        return;
      }
      if (!isTrustedTui(ctx)) {
        deps.notify(TUI_ONLY_REFUSAL, "warning");
        return;
      }
      const outcome = await runTwofaEnrollPrompt(deps, replace);
      if (outcome.ok) {
        // Q16：启用不踢出现有会话，TUI 必须明示。
        deps.notify(
          outcome.newRecoveryCodes
            ? "已启用 TOTP 二次验证。恢复码仅显示一次，请立即妥善保存。"
            : "已确认 TOTP（沿用既有恢复码，未重新生成）。",
          "info",
        );
        deps.notify("提示：已有登录会话保持有效；新 IP 的下次登录将要求二次验证。", "info");
        return;
      }
      switch (outcome.reason) {
        case "no-cap":
          deps.notify("hub 版本过旧，请 /webhub restart。", "warning");
          return;
        case "cancelled":
          deps.notify("已取消：未完成注册（hub 侧的待定密钥会在 5 分钟后自动失效）。", "info");
          return;
        case "rejected":
          deps.notify(
            outcome.code !== undefined
              ? formatTfaError(outcome.code, outcome.message ?? "")
              : (outcome.message ?? "注册被拒绝。"),
            "warning",
          );
          return;
      }
      return;
    }
    case "feishu": {
      const arg = rest[0];
      if (rest.length !== 1 || (arg !== "on" && arg !== "off")) {
        deps.notify("用法：/webhub 2fa feishu on|off", "warning");
        return;
      }
      if (!isTrustedTui(ctx)) {
        deps.notify(TUI_ONLY_REFUSAL, "warning");
        return;
      }
      const on = arg === "on";
      if (on && !(await deps.hasFeishuOwner())) {
        deps.notify(formatTfaError("E_NO_FEISHU", ""), "warning");
        return;
      }
      const res = await requestTfa(deps, { t: "tfa_req", rid: randomUUID(), op: "feishu", on });
      if (!res.ok) {
        fail(res);
        return;
      }
      // P0 裁决：首次「仅飞书」启用会一并签发恢复码，响应形状是 recovery_regen。
      if (res.data.kind === "recovery_regen") {
        deps.showRecoveryCodes(res.data.recoveryCodes);
        deps.notify("已启用飞书审批。恢复码仅显示一次，请立即妥善保存。", "info");
        deps.notify("提示：已有登录会话保持有效；新 IP 的下次登录将要求二次验证。", "info");
        return;
      }
      deps.notify(on ? "已启用飞书审批。" : "已关闭飞书审批。", "info");
      if (on) deps.notify("提示：已有登录会话保持有效；新 IP 的下次登录将要求二次验证。", "info");
      return;
    }
    case "recovery": {
      if (rest.length > 0) {
        deps.notify("/webhub 2fa recovery 不接受任何参数。", "warning");
        return;
      }
      if (!isTrustedTui(ctx)) {
        deps.notify(TUI_ONLY_REFUSAL, "warning");
        return;
      }
      const res = await requestTfa(deps, { t: "tfa_req", rid: randomUUID(), op: "recovery_regen" });
      if (!res.ok) {
        fail(res);
        return;
      }
      if (res.data.kind !== "recovery_regen") {
        deps.notify("hub 返回了意外的响应形状（非 recovery_regen）。", "error");
        return;
      }
      deps.showRecoveryCodes(res.data.recoveryCodes);
      deps.notify("已重新生成 10 个恢复码（旧的全部作废）。仅显示一次，请立即妥善保存。", "info");
      return;
    }
    case "reset": {
      if (rest.length !== 1 || rest[0] !== "--confirm") {
        deps.notify("用法：/webhub 2fa reset --confirm（清除全部 2FA 因子与恢复码）", "warning");
        return;
      }
      if (!isTrustedTui(ctx)) {
        deps.notify(TUI_ONLY_REFUSAL, "warning");
        return;
      }
      const res = await requestTfa(deps, { t: "tfa_req", rid: randomUUID(), op: "reset", confirm: true });
      if (!res.ok) {
        fail(res);
        return;
      }
      deps.notify("已重置：全部 2FA 因子与恢复码已清除；新 IP 登录不再要求二次验证。", "info");
      return;
    }
    case "forget-ips": {
      if (rest.length > 0) {
        deps.notify("/webhub 2fa forget-ips 不接受任何参数。", "warning");
        return;
      }
      if (!isTrustedTui(ctx)) {
        deps.notify(TUI_ONLY_REFUSAL, "warning");
        return;
      }
      const res = await requestTfa(deps, { t: "tfa_req", rid: randomUUID(), op: "forget_ips" });
      if (!res.ok) {
        fail(res);
        return;
      }
      deps.notify("已清空登录 IP 历史：所有 IP 的下一次登录都视为新 IP（已启用 2FA 时需二次验证）。", "info");
      return;
    }
    case "repair": {
      if (rest.length !== 1 || rest[0] !== "--confirm") {
        deps.notify(
          "用法：/webhub 2fa repair --confirm（修复不一致的 2FA 表：清空 2FA 数据，保留 schema v2）",
          "warning",
        );
        return;
      }
      if (!isTrustedTui(ctx)) {
        deps.notify(TUI_ONLY_REFUSAL, "warning");
        return;
      }
      const res = await requestTfa(deps, { t: "tfa_req", rid: randomUUID(), op: "repair", confirm: true });
      if (!res.ok) {
        fail(res);
        return;
      }
      deps.notify("修复完成：2FA 数据已清空。建议立即 /webhub 2fa enroll 重新启用。", "info");
      return;
    }
    default:
      deps.notify(TWOFA_USAGE, "warning");
      return;
  }
}
