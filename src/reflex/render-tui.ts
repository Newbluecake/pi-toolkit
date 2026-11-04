/**
 * jev-reflex · TUI renderer for `subagent:reflex` custom messages (R0 skeleton).
 * Returning `undefined` makes pi fall back to its default custom-message rendering (the user still sees
 * the text). R3a replaces this with the compact `reflex · <script> · <ms>ms` header + Q/body (arch §4.8).
 */
import type { MessageRenderer } from "@earendil-works/pi-coding-agent";

export const renderReflexMessage: MessageRenderer<unknown> = () => undefined;
