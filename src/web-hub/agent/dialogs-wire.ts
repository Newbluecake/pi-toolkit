/**
 * Dialog bridge wiring (source-governance batch2 ⑨-H1).
 *
 * Pure extraction out of `index.ts`'s `wireWebHub` closure: the `remoteAskUserEnabled` gate and
 * the `createDialogBridge` assembly. Bodies are verbatim; the closure-captured `conn` /
 * `attached` / `ctx` became explicit call-time getters, so reconnect/detach/session-switch
 * semantics are unchanged. No module-scope mutable state (I4), no timers (I5 trivially).
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HubConnection } from "./connection.js";
import { createDialogBridge, type DialogBridge } from "./dialogs.js";

export interface DialogsWireDeps {
  /** The two `WebHubSettings` flags the gate reads (structural). */
  settings: { control?: boolean; remoteAskUser?: boolean };
  /** D14/§3.1: `askUser.enabled` in the host settings; unset ⇒ treated as enabled. */
  askUserEnabled: (() => boolean) | undefined;
  /** Late-bound read of the current link (the pre-extraction closure's captured `conn`). */
  conn(): HubConnection | undefined;
  isAttached(): boolean;
  /** Late-bound read of the session ctx (the pre-extraction closure's captured `ctx`). */
  getCtx(): ExtensionContext | undefined;
  now(): number;
  /** MODULE_INSTANCE of this activation. */
  epoch: string;
}

export interface DialogsWire {
  remoteAskUserEnabled(): boolean;
  dialogBridge: DialogBridge;
}

export function wireDialogs(args: DialogsWireDeps): DialogsWire {
  const { settings, askUserEnabled, conn, isAttached, getCtx, now, epoch } = args;
  const remoteAskUserEnabled = (): boolean =>
    settings.control !== false && settings.remoteAskUser !== false && (askUserEnabled?.() ?? true);
  const dialogBridge = createDialogBridge({
    setSlot: (kind, f) => conn()?.setSlot(kind, f),
    isAttached,
    notify: (message) => {
      const x = getCtx();
      try {
        if (x === undefined || x.mode !== "tui" || !x.hasUI) return;
        x.ui.notify(message);
      } catch {
        /* a stale ctx / notify failure must never affect the reply already sent */
      }
    },
    now,
    enabled: remoteAskUserEnabled(),
    epoch,
    send: (frame) => conn()?.send(frame),
    // ask-user-async §7.2 (P3): live hub caps — drives the by:"background" → "abort" downgrade
    // in dialogs.ts while the connected hub lacks `dialog.bg.v1` (empty until hello_ack lands).
    hubCaps: () => conn()?.caps ?? [],
  });
  return { remoteAskUserEnabled, dialogBridge };
}
