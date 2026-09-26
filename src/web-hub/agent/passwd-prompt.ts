/**
 * `/webhub passwd` (plan §9.3; LE). TUI-only, requires the hub to advertise
 * `lan.v1`. Two independently testable halves:
 *  - `MaskedInputComponent`: a minimal masked single-line input (append /
 *    backspace / enter / escape only — password entry is blind, so editing
 *    from the end is the normal flow). `render()` **never** includes the
 *    typed characters, only one bullet per code point (plan §11 LE row:
 *    "掩码组件从不渲染明文");
 *  - `runPasswdPrompt`: the orchestration (username → password twice →
 *    `lan_req passwd`), driven entirely through injected callbacks so it has
 *    no pi-tui / `ExtensionUIContext` dependency of its own — `wireWebHub`
 *    (agent/index.ts) supplies `promptPassword` by wrapping `ctx.ui.custom`
 *    around `MaskedInputComponent`.
 */
import { randomUUID } from "node:crypto";
import { type Component, matchesKey, parseKey } from "@earendil-works/pi-tui";
import type { LanReqFrame, LanResFrame } from "../protocol/messages.js";

const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 256;
const MASK_CHAR = "•";

export interface MaskedInputTuiLike {
  requestRender(): void;
}

function stripControl(data: string): string {
  let out = "";
  for (const ch of data) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) out += ch;
  }
  return out;
}

export class MaskedInputComponent implements Component {
  private value = "";
  private done: ((v: string | undefined) => void) | undefined;

  constructor(
    private readonly title: string,
    private readonly tui: MaskedInputTuiLike,
    done: (v: string | undefined) => void,
  ) {
    this.done = done;
  }

  /** Test seam: the raw value is never exposed through `render()`, only here. */
  get length(): number {
    return this.value.length;
  }

  invalidate(): void {
    /* nothing cached to drop */
  }

  render(width: number): string[] {
    const line = `${this.title}: ${MASK_CHAR.repeat(this.value.length)}`;
    return [line.length > width ? line.slice(line.length - width) : line];
  }

  handleInput(data: string): void {
    const keyId = parseKey(data);
    if (keyId !== undefined) {
      if (matchesKey(data, "enter")) {
        this.finish(this.value);
      } else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        this.finish(undefined);
      } else if ((matchesKey(data, "backspace") || matchesKey(data, "delete")) && this.value.length > 0) {
        this.value = this.value.slice(0, -1);
        this.tui.requestRender();
      } else if (keyId.length === 1 && keyId >= " " && keyId <= "~") {
        // parseKey's fallback branch returns the literal character for any single printable
        // ASCII byte (32..126) it doesn't otherwise recognize — that IS the typed key, not a
        // named special key (mirrors ask-user/component.ts's identical fallthrough).
        this.value += keyId;
        this.tui.requestRender();
      }
      // any other recognized keyId (arrows, tab, other ctrl/alt combos, …): intentionally ignored
      return;
    }
    // No recognized keyId (e.g. a multi-byte non-ASCII character, or a pasted multi-char chunk):
    // strip any residual control/escape bytes and append the rest as typed text.
    const printable = stripControl(data);
    if (printable !== "") {
      this.value += printable;
      this.tui.requestRender();
    }
  }

  private finish(v: string | undefined): void {
    const d = this.done;
    this.done = undefined;
    d?.(v);
  }
}

export interface PasswdPromptDeps {
  /** Whether the hub's `hello_ack.caps` includes `"lan.v1"`. */
  hasCap: (cap: string) => boolean;
  /** `ctx.ui.input("用户名")`-shaped: plain text, username isn't secret. */
  promptUsername: () => Promise<string | undefined>;
  /** Masked prompt (wraps `ctx.ui.custom` around `MaskedInputComponent`). */
  promptPassword: (title: string) => Promise<string | undefined>;
  request: (frame: LanReqFrame, cap: string) => Promise<LanResFrame>;
}

export type PasswdOutcome =
  | { ok: true }
  | { ok: false; reason: "no-cap" | "cancelled" | "mismatch" | "invalid-length" }
  | { ok: false; reason: "rejected"; code: string; message: string };

export async function runPasswdPrompt(deps: PasswdPromptDeps): Promise<PasswdOutcome> {
  if (!deps.hasCap("lan.v1")) return { ok: false, reason: "no-cap" };
  const usernameRaw = await deps.promptUsername();
  const username = usernameRaw?.trim();
  if (username === undefined || username === "") return { ok: false, reason: "cancelled" };
  const p1 = await deps.promptPassword("新密码");
  if (p1 === undefined) return { ok: false, reason: "cancelled" };
  const p2 = await deps.promptPassword("确认新密码");
  if (p2 === undefined) return { ok: false, reason: "cancelled" };
  if (p1 !== p2) return { ok: false, reason: "mismatch" };
  if (p1.length < MIN_PASSWORD_LENGTH || p1.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, reason: "invalid-length" };
  }
  const frame: LanReqFrame = { t: "lan_req", rid: randomUUID(), op: "passwd", username, password: p1 };
  const res = await deps.request(frame, "lan.v1");
  if (res.ok) return { ok: true };
  return { ok: false, reason: "rejected", code: res.code, message: res.message };
}

export function formatPasswdOutcomeMessage(outcome: PasswdOutcome): string {
  if (outcome.ok) {
    return "已更新；已有局域网会话与页面全部失效；初始密码已删除。";
  }
  switch (outcome.reason) {
    case "no-cap":
      return "当前 hub 不支持密码修改（缺少 lan.v1 能力，或 hub 不在线）。";
    case "cancelled":
      return "已取消。";
    case "mismatch":
      return "两次输入的密码不一致，未修改。";
    case "invalid-length":
      return `密码长度必须在 ${MIN_PASSWORD_LENGTH}..${MAX_PASSWORD_LENGTH} 之间。`;
    case "rejected":
      return `修改失败：${outcome.message}`;
  }
}
