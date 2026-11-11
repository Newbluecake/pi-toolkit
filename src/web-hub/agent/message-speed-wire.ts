/** Enabled web-hub host adapter: public raw port plus synchronous per-event scalar binding. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EventTap } from "./event-tap.js";
import { messageSpeedBinding } from "./message-speed-binding.js";
import type { MessageSpeed } from "./message-speed.js";
import { WEB_MESSAGE_SPEED_ENTRY_TYPE } from "../protocol/message-generation.js";

export function wireMessageSpeed(
  pi: ExtensionAPI,
  speed: MessageSpeed,
  active: (ctx: ExtensionContext) => boolean,
): {
  forward(tap: EventTap, event: { type: string } & Record<string, unknown>): void;
} {
  pi.on("provider_stream_event", (event, ctx) => {
    if (!active(ctx)) return;
    try {
      speed.raw(event);
    } catch {
      speed.reset();
    }
  });
  if (typeof pi.registerEntryRenderer === "function")
    pi.registerEntryRenderer(WEB_MESSAGE_SPEED_ENTRY_TYPE, () => undefined);
  return {
    forward(tap, event) {
      // Binding belongs to THIS synchronous delta call; never cached/reused by the adapter.
      const binding = event.type === "message_update" ? messageSpeedBinding(event) : undefined;
      tap.handle(event, binding);
    },
  };
}
