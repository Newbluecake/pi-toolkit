/**
 * web-hub session-history plan §4.5.8 (`head-pins.test.ts`): pins `head.ts`'s hard-coded
 * customType literals against the real source-of-truth constants (those modules live outside
 * the `src/web-hub/{protocol,hub}` boundary `history/*` is held to, so `head.ts` cannot import
 * them directly — this test is the cross-check).
 */
import { describe, expect, it } from "vitest";
import {
  PROMPT_SECTIONS_CUSTOM_TYPE,
  SESSION_START_CUSTOM_TYPE,
  WEB_ORIGIN_CUSTOM_TYPE,
} from "../../../../../src/web-hub/hub/spawn/history/head.js";
import { HISTORY_CHILD_MARKER_TYPE } from "../../../../../src/web-hub/protocol/session-history.js";
import { PROMPT_SECTIONS_ENTRY_TYPE } from "../../../../../src/prompt-sections/store.js";
import { SESSION_START_ENTRY_TYPE } from "../../../../../src/hud/timing.js";
import { WEB_ORIGIN_ENTRY_TYPE } from "../../../../../src/web-hub/agent/origin-entry.js";
import { SUBAGENT_CHILD_CUSTOM_TYPE } from "../../../../../src/runtime/session-driver.js";

describe("head.ts customType literals pinned against their real source-of-truth constants", () => {
  it("PROMPT_SECTIONS_CUSTOM_TYPE === src/prompt-sections/store.ts's PROMPT_SECTIONS_ENTRY_TYPE", () => {
    expect(PROMPT_SECTIONS_CUSTOM_TYPE).toBe(PROMPT_SECTIONS_ENTRY_TYPE);
  });
  it("SESSION_START_CUSTOM_TYPE === src/hud/timing.ts's SESSION_START_ENTRY_TYPE", () => {
    expect(SESSION_START_CUSTOM_TYPE).toBe(SESSION_START_ENTRY_TYPE);
  });
  it("WEB_ORIGIN_CUSTOM_TYPE === src/web-hub/agent/origin-entry.ts's WEB_ORIGIN_ENTRY_TYPE", () => {
    expect(WEB_ORIGIN_CUSTOM_TYPE).toBe(WEB_ORIGIN_ENTRY_TYPE);
  });
  it("protocol/session-history.ts's HISTORY_CHILD_MARKER_TYPE === src/runtime/session-driver.ts's SUBAGENT_CHILD_CUSTOM_TYPE", () => {
    expect(HISTORY_CHILD_MARKER_TYPE).toBe(SUBAGENT_CHILD_CUSTOM_TYPE);
  });
});
