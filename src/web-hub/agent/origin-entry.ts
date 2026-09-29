/**
 * TUI notify + `subagent:web-origin` custom entry (plan §4.7, D12/D18/D27).
 *
 * Two independent surfaces from the same origin data:
 *  - a compact TUI `notify` line for every *successful, non-prompt* write op
 *    (U6) — never for `prompt` itself (that would double up with the
 *    transcript, which already shows the message);
 *  - a `subagent:web-origin` custom entry appended *before* dispatching a
 *    prompt (D12) so a human at the terminal can tell a message came from
 *    the web without polluting the LLM context or the entry's own body with
 *    anything traceable (no request text, no IP — U10).
 *
 * D27 (K23): `registerEntryRenderer` must always return a real pi-tui
 * `Component` — a plain object crashes pi's next render pass.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { CmdOp, CmdOrigin } from "../protocol/messages.js";

export const WEB_ORIGIN_ENTRY_TYPE = "subagent:web-origin";

export interface WebOriginEntryData {
  v: 1;
  cmdId: string;
  reqId: string;
  listener: "loopback" | "lan";
  user?: string;
  op: CmdOp;
  deliver?: "steer" | "followUp";
}

export interface OriginEntryPort {
  /** D12: append the origin entry before dispatching a prompt (or a template/skill command
   * routed through the prompt path). Swallows failures — a stale ctx must never block dispatch. */
  appendOrigin(op: CmdOp, cmdId: string, origin: CmdOrigin, deliver?: "steer" | "followUp"): void;
  /** U6/D18: one compact notify line for a *successful* non-prompt write op. `opLabel` is the
   * caller-built op description (e.g. `"stop subagent r_58XP"`, `"/compact"`). No-ops outside
   * `tui && hasUI`, and swallows any failure.
   *
   * acc32-B5 pitfall (documented here, not just at the call site): pi's interactive-mode
   * `showStatus()` merges two *consecutive* chat-status lines into one when nothing else was
   * added to the transcript in between ("avoid log spam" — it compares the chat container's
   * last two children against the ones its own previous `showStatus` call added, not by
   * timing). `ctx.ui.notify(msg)` / `ctx.ui.notify(msg, "info")` both route to that merging
   * `showStatus` path; only `"warning"`/`"error"` route to `showWarning`/`showError`, which
   * *always* append unconditionally and never touch the merge-tracking state. So when a call
   * site knows some other `ctx.ui.notify` may have just landed immediately before this one (a
   * third-party command's own notify, run synchronously just above), passing
   * `opts.avoidStatusMerge: true` is the only way — short of pi changing `showStatus` — to keep
   * both lines visible instead of silently overwriting the earlier one. Ordinary callers (no
   * immediately-preceding foreign notify to protect) can omit it and keep the plain dim style. */
  notify(ctx: ExtensionContext, opLabel: string, origin: CmdOrigin, opts?: { avoidStatusMerge?: boolean }): void;
  dispose(): void;
}

/** Register the `subagent:web-origin` renderer. Call once per `activate()`. A pre-0.87-shaped
 * `pi` without `registerEntryRenderer` (or a minimal test double) degrades silently: the origin
 * entry itself would still be appended by `appendOrigin`, it would just render as plain data in
 * that case (pi's own fallback) instead of the dim notify-style line this renderer produces. */
export function registerOriginEntryRenderer(pi: ExtensionAPI): void {
  if (typeof pi.registerEntryRenderer !== "function") return;
  pi.registerEntryRenderer<WebOriginEntryData>(WEB_ORIGIN_ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data;
    const who = data?.listener === "lan" ? `lan ${data.user ?? "?"}` : "local";
    const reqId8 = (data?.reqId ?? "").slice(0, 8);
    return new Text(theme.fg("dim", `↳ web · ${who} · #${reqId8}`), 0, 0);
  });
}

function listenerAndIp(origin: CmdOrigin): string {
  if (origin.listener === "lan") return `lan ${origin.user !== undefined ? `${origin.user}@${origin.ip}` : origin.ip}`;
  return `loopback ${origin.ip}`;
}

export function createOriginEntry(pi: ExtensionAPI): OriginEntryPort {
  return {
    appendOrigin(op, cmdId, origin, deliver) {
      try {
        const data: WebOriginEntryData = { v: 1, cmdId, reqId: origin.reqId, listener: origin.listener, op };
        if (origin.user !== undefined) data.user = origin.user;
        if (deliver !== undefined) data.deliver = deliver;
        pi.appendEntry(WEB_ORIGIN_ENTRY_TYPE, data);
      } catch {
        /* stale ctx / detached session: must never block dispatch */
      }
    },
    notify(ctx, opLabel, origin, opts) {
      try {
        if (ctx.mode !== "tui" || !ctx.hasUI) return;
        const msg = `web ▸ ${opLabel} · ${listenerAndIp(origin)} · #${origin.reqId.slice(0, 8)}`;
        // acc32-B5: "warning" is the only type that bypasses pi's showStatus merge-dedup (see the
        // OriginEntryPort.notify doc comment) — used only when the caller flags a clobber risk.
        if (opts?.avoidStatusMerge === true) ctx.ui.notify(msg, "warning");
        else ctx.ui.notify(msg);
      } catch {
        /* a stale ctx / notify failure must never affect the reply already sent */
      }
    },
    dispose() {
      /* nothing owned: pi.appendEntry/registerEntryRenderer need no teardown */
    },
  };
}
