/**
 * rebind-plan r3 §4.6 (P1) — `selectSession`, the ONE resolution ladder for
 * `thr_req{op:"rebind"}.to`: 完整 sid → 唯一前缀（≥6）→ 精确别名 → 精确 name; a rung with
 * >1 distinct hits is AMBIGUOUS (no descent); a single hit is then live/read-only checked
 * (OFFLINE / AMBIGUOUS / READONLY).
 */
import { describe, expect, it } from "vitest";
import { selectSession } from "../../../../src/web-hub/hub/feishu/session-selector.js";
import type { FeishuSessionView } from "../../../../src/web-hub/hub/feishu/sessions.js";

const view = (over: Partial<FeishuSessionView> = {}): FeishuSessionView => ({
  sessionId: "session-1",
  agentKey: "agent-1",
  cwd: "/repo",
  name: "One",
  mode: "tui",
  live: true,
  state: "idle",
  ...over,
});
const NO_ALIAS = (): string | undefined => undefined;

describe("selectSession (rebind-plan r3 §4.6)", () => {
  it("full sid wins over every other rung", () => {
    const views = [view(), view({ sessionId: "session-12", agentKey: "agent-2", name: "session-1" })];
    const res = selectSession("session-1", views, NO_ALIAS);
    expect(res).toEqual({ ok: true, sessionId: "session-1", agentKey: "agent-1", label: "One" });
  });
  it("unique prefix (≥6) resolves; shorter prefixes never reach the prefix rung", () => {
    const views = [view({ sessionId: "abcdef123456" })];
    expect(selectSession("abcdef", views, NO_ALIAS)).toMatchObject({ ok: true, sessionId: "abcdef123456" });
    expect(selectSession("abcde", views, NO_ALIAS)).toEqual({ ok: false, code: "E_THR_TARGET_UNKNOWN" });
  });
  it("a prefix hitting >1 distinct sids is AMBIGUOUS and never descends to alias/name", () => {
    const views = [
      view({ sessionId: "worker-aaa", agentKey: "a1", name: "unique-name" }),
      view({ sessionId: "worker-bbb", agentKey: "a2" }),
    ];
    expect(selectSession("worker", views, NO_ALIAS)).toEqual({ ok: false, code: "E_THR_TARGET_AMBIGUOUS" });
  });
  it("exact alias matches the canonical store form (case-insensitive, @ stripped)", () => {
    const views = [view(), view({ sessionId: "session-2", agentKey: "agent-2" })];
    const aliasOf = (sid: string) => (sid === "session-2" ? "worker" : undefined);
    expect(selectSession("@Worker", views, aliasOf)).toEqual({
      ok: true,
      sessionId: "session-2",
      agentKey: "agent-2",
      label: "One",
    });
  });
  it("exact name is the last rung", () => {
    const views = [view(), view({ sessionId: "session-2", agentKey: "agent-2", name: "Worker" })];
    expect(selectSession("Worker", views, NO_ALIAS)).toMatchObject({ ok: true, sessionId: "session-2" });
    expect(selectSession("worker", views, NO_ALIAS)).toEqual({ ok: false, code: "E_THR_TARGET_UNKNOWN" }); // case-sensitive
  });
  it("two sessions sharing a name are AMBIGUOUS", () => {
    const views = [view(), view({ sessionId: "session-2", agentKey: "agent-2" })];
    expect(selectSession("One", views, NO_ALIAS)).toEqual({ ok: false, code: "E_THR_TARGET_AMBIGUOUS" });
  });
  it("a hit with no live view is OFFLINE", () => {
    const views = [view({ live: false })];
    expect(selectSession("session-1", views, NO_ALIAS)).toEqual({ ok: false, code: "E_THR_TARGET_OFFLINE" });
  });
  it("a hit with >1 live views is AMBIGUOUS", () => {
    const views = [view(), view({ agentKey: "agent-1b" })];
    expect(selectSession("session-1", views, NO_ALIAS)).toEqual({ ok: false, code: "E_THR_TARGET_AMBIGUOUS" });
  });
  it("a live read-only hit is READONLY", () => {
    const views = [view({ state: "read-only" })];
    expect(selectSession("session-1", views, NO_ALIAS)).toEqual({ ok: false, code: "E_THR_TARGET_READONLY" });
  });
  it("unknown selector ⇒ UNKNOWN", () => {
    expect(selectSession("nope", [view()], NO_ALIAS)).toEqual({ ok: false, code: "E_THR_TARGET_UNKNOWN" });
  });
  it("label derivation: name || basename(cwd) || sid6", () => {
    expect(selectSession("session-1", [view()], NO_ALIAS)).toMatchObject({ label: "One" });
    expect(selectSession("session-1", [view({ name: undefined })], NO_ALIAS)).toMatchObject({ label: "repo" });
    expect(selectSession("session-1", [view({ name: undefined, cwd: "" })], NO_ALIAS)).toMatchObject({
      label: "sessio",
    });
  });
  it("the alias rung is skipped for alias-invalid selectors (falls to name)", () => {
    // A space is alias-denied (White_Space), so the alias rung is skipped entirely; the exact
    // name rung still resolves.
    const views = [view({ name: "has space", sessionId: "session-9", agentKey: "agent-9" })];
    const aliasOf = () => "irrelevant";
    expect(selectSession("has space", views, aliasOf)).toMatchObject({ ok: true, sessionId: "session-9" });
  });
});
