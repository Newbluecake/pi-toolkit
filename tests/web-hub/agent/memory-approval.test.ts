import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHumanDispatchProof, createHumanOpApproval } from "../../../src/web-hub/agent/human-dispatch-proof.js";
import { createDialogBridge } from "../../../src/web-hub/agent/dialogs.js";
import { createHumanTurnTracker, createMemoryOpCapRegistry } from "../../../src/memory/scopes/op-cap.js";
import { bodyTextDigest, scopedOpDigest } from "../../../src/memory/scopes/limits.js";
import { REJECT_LABEL } from "../../../src/memory/scopes/authorize.js";
import type { CmdFrame, CmdOrigin } from "../../../src/web-hub/protocol/messages.js";
import type { HumanTurn, MemoryOwner, OpApprovalRequest } from "../../../src/memory/scopes/types.js";

function fixture(mode: "tui" | "rpc" = "rpc", remote = true) {
  const owner: MemoryOwner = { incarnation: {}, sid: "own-sid", branchGen: 1, sessionEpoch: 1 };
  const tracker = createHumanTurnTracker(() => registry?.revoke());
  const registry = createMemoryOpCapRegistry(() => tracker.current());
  let resolveSelect: ((value: string | undefined) => void) | undefined;
  const select = vi.fn(
    () =>
      new Promise<string | undefined>((resolve) => {
        resolveSelect = resolve;
      }),
  );
  const ctx = {
    mode,
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: { select },
  } as unknown as ExtensionContext;
  const proof = createHumanDispatchProof({ owner: () => owner, context: () => ctx, enabled: () => true, tracker });
  const bridge = createDialogBridge({ enabled: true, isAttached: () => true, epoch: "epoch" });
  const approval = createHumanOpApproval({
    tracker,
    registry,
    context: () => ctx,
    ...(remote ? { remote: bridge } : {}),
  });
  proof.dispatchWeb("source", { listener: "loopback", ip: "127.0.0.1", reqId: "request" }, () => {
    proof.onInput({ source: "extension" });
    proof.onBeforeAgentStart({ messageType: "user" });
  });
  const operation = Object.freeze({
    storageScope: "hub" as const,
    authority: "user" as const,
    op: "create" as const,
    topic: "general",
    text: "FULL RAW TEXT\n换行与原文 🌍",
  });
  const request: OpApprovalRequest = {
    operation,
    binding: {
      owner,
      humanTurn: tracker.current() as HumanTurn,
      toolCallId: "exact-tool",
      nonce: "b".repeat(32),
      opDigest: scopedOpDigest(operation),
      textDigest: bodyTextDigest(operation.text),
    },
    projectLabel: "own-project",
  };
  const abort = new AbortController();
  function answer(
    origin: CmdOrigin | string,
    action: "dialog_answer" | "dialog_cancel" = "dialog_answer",
    id?: string,
  ) {
    const dialog = bridge.frame().open[0];
    if (typeof origin === "string")
      return bridge.answer(
        id ?? dialog!.dialogId,
        [{ selected: [dialog!.questions[0]!.options[1]!.label], other: null }],
        origin,
      );
    return bridge.handle({
      t: "cmd",
      rid: "r-answer",
      id: "answer",
      deadlineMs: 8000,
      origin,
      cmd:
        action === "dialog_cancel"
          ? { op: action, dialogId: id ?? dialog!.dialogId, epoch: "epoch" }
          : {
              op: action,
              dialogId: id ?? dialog!.dialogId,
              epoch: "epoch",
              answers: [{ selected: [dialog!.questions[0]!.options[1]!.label], other: null }],
            },
    } as CmdFrame);
  }
  return {
    owner,
    tracker,
    registry,
    ctx,
    select,
    proof,
    bridge,
    approval,
    request,
    abort,
    answer,
    start: () => approval.request(request, abort.signal),
    choose: (value?: string) => resolveSelect?.(value),
    close() {
      abort.abort();
      approval.dispose();
      bridge.dispose();
      proof.dispose();
    },
  };
}
const browser: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "r1" };

describe("P3b actual dialog source projection × P1 approval factory", () => {
  it.each(["loopback", "lan"] as const)(
    "trusted %s frame closes exact nonce dialog and mints one cap",
    async (listener) => {
      const f = fixture();
      const pending = f.start();
      const dialog = f.bridge.frame().open[0]!;
      expect(dialog.dialogId).toBe(`ask:memory-op:${f.request.binding.nonce}`);
      expect(dialog.questions[0]?.options[0]?.label).toBe(REJECT_LABEL);
      expect(dialog.questions[0]?.question).toContain(f.request.operation.text);
      expect(dialog.questions[0]?.options[1]?.label).toContain(f.request.binding.opDigest.slice(0, 8));
      expect(f.answer({ ...browser, listener })).toMatchObject({ ok: true });
      const result = await pending;
      expect(result.approved).toBe(true);
      if (result.approved) {
        const cap = f.registry.reserve(result.cap, f.owner);
        expect(cap?.operation).toEqual(f.request.operation);
        expect(cap?.binding).toEqual(f.request.binding);
        expect(cap?.channel).toBe("web");
        expect(f.registry.consume(result.cap)).toBe(true);
        expect(f.registry.consume(result.cap)).toBe(false);
      }
      expect(f.select).not.toHaveBeenCalled(); // rpc hasUI=true still NOT a TUI
      f.close();
    },
  );
  it.each(["legacy-string", "feishu", "unknown"])(
    "%s cannot authorize (no model-supplied originKind)",
    async (kind) => {
      const f = fixture();
      const pending = f.start();
      const origin =
        kind === "legacy-string"
          ? "loopback"
          : kind === "feishu"
            ? { ...browser, ip: "feishu" }
            : { ...browser, listener: "unknown" as never };
      expect(f.answer(origin)).toMatchObject({ ok: false, code: "E_DIALOG_CLOSED" });
      expect(f.bridge.frame().open).toHaveLength(1);
      f.abort.abort();
      expect(await pending).toEqual({ approved: false, code: "E_HUB_DECLINED" });
      f.close();
    },
  );
  it("TUI local select is available only in real tui mode, reject first, and wins the existing race", async () => {
    const f = fixture("tui");
    const pending = f.start();
    expect(f.select).toHaveBeenCalledOnce();
    const call = f.select.mock.calls[0] as unknown as [string, string[]];
    expect(call[0]).toContain(f.request.operation.text);
    expect(call[1][0]).toBe(REJECT_LABEL);
    const id = f.bridge.frame().open[0]!.dialogId;
    f.choose(call[1][1]);
    const result = await pending;
    expect(result.approved).toBe(true);
    expect(f.bridge.frame().open).toHaveLength(0);
    expect(f.bridge.answer(id, [], browser)).toMatchObject({ ok: false, code: "E_DIALOG_CLOSED" });
    f.close();
  });
  it("rpc hasUI=true with no remote is unavailable, not a proxy select confirmation", async () => {
    const f = fixture("rpc", false);
    expect(await f.start()).toEqual({ approved: false, code: "E_HUB_CONFIRM_UNAVAILABLE" });
    expect(f.select).not.toHaveBeenCalled();
    f.close();
  });
  it("mode availability is checked at request-time, not stale factory construction-time", async () => {
    const f = fixture("tui", false);
    Object.assign(f.ctx, { mode: "rpc" });
    expect(await f.start()).toEqual({ approved: false, code: "E_HUB_CONFIRM_UNAVAILABLE" });
    expect(f.select).not.toHaveBeenCalled();
    f.close();
  });
  it("binding/op digest tampering opens no dialog", async () => {
    const f = fixture();
    const result = await f.approval.request({
      ...f.request,
      operation: { ...f.request.operation, text: "changed after freeze" },
    });
    expect(result).toEqual({ approved: false, code: "E_META_INVALID" });
    expect(f.bridge.frame().open).toEqual([]);
    f.close();
  });
  it("owner/tree invalidation makes a late exact answer unclaimable", async () => {
    const f = fixture();
    const pending = f.start();
    f.proof.revoke("tree");
    expect(f.answer(browser)).toMatchObject({ ok: false, code: "E_DIALOG_CLOSED" });
    f.abort.abort();
    expect(await pending).toEqual({ approved: false, code: "E_HUB_DECLINED" });
    f.close();
  });
  it("wrong nonce / old epoch cannot answer the current popup", async () => {
    const f = fixture();
    const pending = f.start();
    expect(f.answer(browser, "dialog_answer", "ask:memory-op:wrong")).toMatchObject({
      ok: false,
      code: "E_DIALOG_CLOSED",
    });
    const dialog = f.bridge.frame().open[0]!;
    expect(
      f.bridge.handle({
        t: "cmd",
        rid: "old",
        id: "old",
        origin: browser,
        deadlineMs: 8000,
        cmd: { op: "dialog_cancel", dialogId: dialog.dialogId, epoch: "old" },
      }),
    ).toMatchObject({ ok: false, code: "E_DIALOG_CLOSED" });
    expect(f.answer(browser, "dialog_cancel")).toMatchObject({ ok: true });
    expect(await pending).toEqual({ approved: false, code: "E_HUB_DECLINED" });
    f.close();
  });
  it("cancel's origin is projected locally too (without any new wire fields)", () => {
    const bridge = createDialogBridge({ enabled: true, isAttached: () => true });
    const session = bridge.open({
      toolCallId: "cancel",
      questions: [{ question: "Q", options: [{ label: "A" }] }],
      allowCancel: true,
    })!;
    const callback = vi.fn(() => true);
    session.setOnRemote(callback);
    expect(bridge.cancel("ask:cancel", { ...browser, listener: "lan" })).toMatchObject({ ok: true });
    expect(callback).toHaveBeenCalledWith({ kind: "cancel", origin: "local@127.0.0.1", originKind: "lan" });
    bridge.dispose();
  });
});
