import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalControllerV2 } from "../../../src/web-hub/ui/src/components/terminal/v2/controller.js";
import type { TerminalQuotaV2 } from "../../../src/web-hub/ui/src/components/terminal/protocol-v2.js";
import type { TerminalRestoreStorageV2 } from "../../../src/web-hub/ui/src/logic/terminal-v2.js";
import {
  attachedFrameV2,
  createTerminalMockV2,
  hubV2,
  rowV2,
  scopeV2,
  termV2,
  turnV2,
  type RequestHandlerV2,
} from "./terminal-v2-fixtures.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class Storage implements TerminalRestoreStorageV2 {
  value: string | null = null;
  getItem(): string | null {
    return this.value;
  }
  setItem(_key: string, value: string): void {
    this.value = value;
  }
}

const quotaEmpty: TerminalQuotaV2 = {
  session: { used: 0, unknown: 0, limit: 2 },
  principal: { used: 0, unknown: 0, limit: 2 },
  total: { used: 0, unknown: 0, limit: 8 },
};
const listEmpty = {
  ok: true,
  hubInstance: hubV2,
  revision: 1,
  rows: [],
  unknownResources: [],
  quota: quotaEmpty,
} as const;

const controllers: Array<{ dispose(): void }> = [];

function setup(handler?: RequestHandlerV2, hidden: () => boolean = () => false) {
  const mock = createTerminalMockV2(handler);
  const renderer = {
    write: vi.fn(async (_bytes: Uint8Array) => {}),
    reset: vi.fn(),
    dimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
  };
  const storage = new Storage();
  let id = 0;
  const controller = createTerminalControllerV2({
    transport: mock.transport,
    scope: scopeV2,
    renderer,
    storage,
    hidden,
    now: () => 100_000,
    id: () => `R${String(id++).padStart(21, "0")}`,
  });
  controllers.push(controller);
  return { ...mock, renderer, controller, storage };
}

async function openExisting(context: ReturnType<typeof setup>) {
  const opening = context.controller.open();
  await turnV2();
  const view = context.views[0]!;
  view.emit(attachedFrameV2(view.body.termId));
  await opening;
}

async function ready(context: ReturnType<typeof setup>, index = 0) {
  const view = context.views[index]!;
  view.emit({ t: "replay-end", offset: 0 });
  await turnV2();
  view.emit({ t: "ready", offset: 0 });
  await turnV2();
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
});

describe("P4 F1/F2 lifecycle barriers", () => {
  it("collapse while the first list is paused prevents the empty-list ensure", async () => {
    const list = deferred<unknown>();
    const handler: RequestHandlerV2 = (op) => {
      if (op === "list") return list.promise as never;
      if (op === "create") return { ok: false, code: "E_LIMIT", effect: "none" };
      return undefined;
    };
    const context = setup(handler);
    context.rows.splice(0);
    const opening = context.controller.open();
    await turnV2();
    context.controller.collapse();
    list.resolve(listEmpty);
    await opening;
    expect(context.request.mock.calls.some(([op]) => op === "create")).toBe(false);
    expect(context.controller.state.open).toBe(false);
  });

  it("dispose while list is paused blocks late rows, create and storage writes", async () => {
    const list = deferred<unknown>();
    const context = setup((op) => {
      if (op === "list") return list.promise as never;
      if (op === "create") return { ok: false, code: "E_LIMIT", effect: "none" };
      return undefined;
    });
    const opening = context.controller.open();
    await turnV2();
    context.controller.dispose();
    const stored = context.storage.value;
    list.resolve({ ...listEmpty, rows: [rowV2()] });
    await opening;
    expect(context.controller.state.rows).toEqual([]);
    expect(context.storage.value).toBe(stored);
    expect(context.request.mock.calls.some(([op]) => op === "create")).toBe(false);
  });

  it("an already-sent create is queried after collapse with the original ID, never marked none", async () => {
    const create = deferred<unknown>();
    const context = setup((op) => {
      if (op === "create") return create.promise as never;
      return undefined;
    });
    context.rows.splice(0);
    const opening = context.controller.open();
    await turnV2();
    const requestId = context.request.mock.calls.find(([op]) => op === "create")?.[1];
    context.controller.collapse();
    create.resolve({ ok: false, code: "E_DEADLINE", effect: "unknown" });
    await opening;
    const calls = context.request.mock.calls;
    expect(calls.filter(([op]) => op === "create")).toHaveLength(1);
    expect(calls.filter(([op]) => op === "creation")).toHaveLength(1);
    expect(calls.find(([op]) => op === "creation")?.[1]).toMatchObject({
      requestId: requestId && "requestId" in requestId ? requestId.requestId : "",
    });
  });

  it("reopening supersedes an old paused list without stale attach or rows", async () => {
    const first = deferred<unknown>();
    let lists = 0;
    const context = setup((op) => {
      if (op === "list") {
        lists++;
        if (lists === 1) return first.promise as never;
        return listEmpty;
      }
      if (op === "create") return { ok: false, code: "E_LIMIT", effect: "none" };
      return undefined;
    });
    const oldOpen = context.controller.open();
    await turnV2();
    context.controller.collapse();
    const newOpen = context.controller.open();
    await turnV2();
    await newOpen;
    first.resolve({ ...listEmpty, rows: [rowV2()] });
    await turnV2();
    if (context.views[0]) context.views[0].emit(attachedFrameV2());
    await oldOpen;
    expect(context.controller.state.rows).toEqual([]);
    expect(context.views).toHaveLength(0);
  });

  it("A's late E_SESSION_CHANGED cannot revoke or clear ready B", async () => {
    const input = deferred<unknown>();
    const context = setup((op, body) => {
      if (op === "input" && "termId" in body && body.termId === termV2 && "bytesB64" in body)
        return input.promise as never;
      return undefined;
    });
    context.rows.push(rowV2("U".repeat(22), 2));
    await openExisting(context);
    await ready(context);
    context.controller.input(new Uint8Array([97]));
    await turnV2();
    const selecting = context.controller.select("U".repeat(22));
    await turnV2();
    context.views[1]!.emit(attachedFrameV2("U".repeat(22)));
    await selecting;
    await ready(context, 1);
    expect(context.controller.state.writable).toBe(true);
    input.resolve({ ok: false, code: "E_SESSION_CHANGED", effect: "none" });
    await turnV2();
    expect(context.controller.state.writable).toBe(true);
    expect(context.controller.state.rows).toHaveLength(2);
    expect(context.views[1]!.signal.aborted).toBe(false);
  });

  it("a late list error after collapse cannot revoke a reopened session", async () => {
    const list = deferred<unknown>();
    let lists = 0;
    const context = setup((op) => {
      if (op === "list") {
        lists++;
        if (lists === 1) return list.promise as never;
        return listEmpty;
      }
      if (op === "create") return { ok: false, code: "E_LIMIT", effect: "none" };
      return undefined;
    });
    const oldOpen = context.controller.open();
    await turnV2();
    context.controller.collapse();
    const reopened = context.controller.open();
    await turnV2();
    await reopened;
    list.resolve({ ok: false, code: "E_SESSION_CHANGED", effect: "none" });
    await oldOpen;
    expect(context.controller.state.open).toBe(true);
    expect(context.controller.state.error).not.toContain("E_SESSION_CHANGED");
  });
});

describe("P4 F2 revision fences", () => {
  it("list revision rollback is ignored", async () => {
    let lists = 0;
    const context = setup((op) => {
      if (op === "list") {
        lists++;
        return {
          ...listEmpty,
          revision: lists === 1 ? 5 : 4,
          rows: lists === 1 ? [rowV2()] : [],
        };
      }
      return undefined;
    });
    await openExisting(context);
    const restoring = context.controller.restore();
    await turnV2();
    const view = context.views[1]!;
    view.emit(attachedFrameV2(view.body.termId));
    await restoring;
    expect(context.controller.state.revision).toBe(5);
    expect(context.controller.state.rows.map((row) => row.termId)).toEqual([termV2]);
  });

  it("tabs frame revision rollback cannot remove the active tab", async () => {
    const context = setup();
    await openExisting(context);
    context.views[0]!.emit({ t: "tabs", revision: 0, rows: [], unknownResources: [], quota: quotaEmpty });
    expect(context.controller.state.revision).toBe(1);
    expect(context.controller.state.rows).toHaveLength(1);
    expect(context.views[0]!.signal.aborted).toBe(false);
  });

  it("rename response revision rollback is ignored", async () => {
    const context = setup((op) => {
      if (op === "list") return { ...listEmpty, revision: 5, rows: [rowV2()] };
      if (op === "rename") return { ok: true, row: { ...rowV2(), name: "stale" }, revision: 4 };
      return undefined;
    });
    await openExisting(context);
    await context.controller.rename(termV2, "fresh");
    expect(context.controller.state.revision).toBe(5);
    expect(context.controller.state.rows[0]?.name).toBe("bash 1");
  });
});

describe("P4 F3 ACK/ready independent-channel merge", () => {
  it("ready may arrive while replay ACK HTTP is paused; input/resize wait for both", async () => {
    const ack = deferred<unknown>();
    const context = setup((op) => (op === "ack" ? (ack.promise as never) : undefined));
    await openExisting(context);
    context.views[0]!.emit({ t: "replay-end", offset: 0 });
    await turnV2();
    context.views[0]!.emit({ t: "ready", offset: 0 });
    await turnV2();
    context.controller.input(new Uint8Array([27]));
    await context.controller.resize();
    expect(context.controller.state.error).toBe("");
    expect(context.controller.state.writable).toBe(false);
    expect(context.request.mock.calls.some(([op]) => op === "input" || op === "resize")).toBe(false);
    ack.resolve({ ok: true, offset: 0 });
    await turnV2();
    expect(context.controller.state.writable).toBe(true);
    expect(context.request.mock.calls.some(([op]) => op === "resize")).toBe(true);
  });

  it("ACK-first still waits for ready and accepts exactly one cutover", async () => {
    const context = setup();
    await openExisting(context);
    context.views[0]!.emit({ t: "replay-end", offset: 0 });
    await turnV2();
    expect(context.controller.state.writable).toBe(false);
    context.views[0]!.emit({ t: "ready", offset: 0 });
    await turnV2();
    expect(context.controller.state.writable).toBe(true);
    expect(context.request.mock.calls.filter(([op]) => op === "ack")).toHaveLength(1);
  });

  it("early ready plus ACK failure never enables input and preserves the ACK failure", async () => {
    const context = setup((op) => (op === "ack" ? { ok: false, code: "E_DEADLINE", effect: "unknown" } : undefined));
    await openExisting(context);
    context.views[0]!.emit({ t: "replay-end", offset: 0 });
    context.views[0]!.emit({ t: "ready", offset: 0 });
    await turnV2();
    context.controller.input(new Uint8Array([27]));
    expect(context.controller.state.writable).toBe(false);
    expect(context.controller.state.error).toContain("E_DEADLINE");
    expect(context.request.mock.calls.some(([op]) => op === "input")).toBe(false);
  });

  it("early ready permits bounded live output while ACK response is pending", async () => {
    const ack = deferred<unknown>();
    let replayAck = true;
    const context = setup((op) => {
      if (op === "ack" && replayAck) {
        replayAck = false;
        return ack.promise as never;
      }
      return undefined;
    });
    await openExisting(context);
    context.views[0]!.emit({ t: "replay-end", offset: 0 });
    context.views[0]!.emit({ t: "ready", offset: 0 });
    context.views[0]!.emit({ t: "output", offset: 0, bytesB64: "YQ==" });
    await turnV2();
    expect(context.renderer.write).toHaveBeenCalledOnce();
    expect(context.controller.state.error).toBe("");
    expect(context.controller.state.writable).toBe(false);
    ack.resolve({ ok: true, offset: 0 });
    await turnV2();
    expect(context.controller.state.writable).toBe(true);
  });

  it("a stale replay ACK response after switching to B cannot abort B", async () => {
    const ack = deferred<unknown>();
    const context = setup((op, body) => {
      if (op === "ack" && "termId" in body && body.termId === termV2) return ack.promise as never;
      return undefined;
    });
    context.rows.push(rowV2("U".repeat(22), 2));
    await openExisting(context);
    context.views[0]!.emit({ t: "replay-end", offset: 0 });
    await turnV2();
    const selecting = context.controller.select("U".repeat(22));
    await turnV2();
    context.views[1]!.emit(attachedFrameV2("U".repeat(22)));
    await selecting;
    await ready(context, 1);
    ack.resolve({ ok: false, code: "E_SESSION_CHANGED", effect: "none" });
    await turnV2();
    expect(context.controller.state.writable).toBe(true);
    expect(context.views[1]!.signal.aborted).toBe(false);
  });
});

describe("P4 F4/F5 unresolved intent and visibility", () => {
  it("newTerminal with an unresolved create only queries the original ID", async () => {
    const context = setup((op) => {
      if (op === "create") return { ok: false, code: "E_DEADLINE", effect: "unknown" };
      if (op === "creation") return { ok: true, outcome: "unknown" };
      return undefined;
    });
    context.rows.splice(0);
    await context.controller.open();
    await context.controller.newTerminal();
    expect(context.request.mock.calls.filter(([op]) => op === "create")).toHaveLength(1);
    expect(context.request.mock.calls.filter(([op]) => op === "creation")).toHaveLength(2);
  });

  it("a failed original query settles it before the next explicit new action", async () => {
    let creates = 0;
    const context = setup((op) => {
      if (op === "create" && creates++ === 0) return { ok: false, code: "E_DEADLINE", effect: "unknown" };
      if (op === "creation") return { ok: true, outcome: "failed", code: "E_BACKEND" };
      return undefined;
    });
    context.rows.splice(0);
    await context.controller.open();
    // The original open has already learned failed; one later explicit action may create.
    const next = context.controller.newTerminal();
    await turnV2();
    const attached = context.views[0]!;
    attached.emit(attachedFrameV2(attached.body.termId));
    await next;
    expect(context.request.mock.calls.filter(([op]) => op === "create")).toHaveLength(2);
  });

  it("cold unknown alone does not arm the current-intent gate", async () => {
    const context = setup();
    context.rows.splice(0);
    context.unknownResources.push({ allocationTag: "A".repeat(22), state: "cleanup-unknown" });
    expect(context.controller.state.creationUnsettled).toBe(false);
    await context.controller.restore();
    expect(context.controller.state.creationUnsettled).toBe(false);
  });

  it("a reconnect timer rechecks hidden before attach and visible resumes the same term", async () => {
    vi.useFakeTimers();
    let hidden = false;
    const context = setup(undefined, () => hidden);
    await openExisting(context);
    await ready(context);
    context.views[0]!.fail();
    await turnV2();
    hidden = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(context.views).toHaveLength(1);
    hidden = false;
    context.controller.visibilityChanged();
    await turnV2();
    expect(context.views).toHaveLength(2);
    expect(context.views[1]!.body.termId).toBe(termV2);
  });
});

describe("P4 additional late-response and bounded-merge fences", () => {
  it("late rename revocation after collapse cannot clear rows or persist a new error", async () => {
    const rename = deferred<unknown>();
    const context = setup((op) => (op === "rename" ? (rename.promise as never) : undefined));
    await openExisting(context);
    const pending = context.controller.rename(termV2, "late");
    await turnV2();
    context.controller.collapse();
    const stored = context.storage.value;
    rename.resolve({ ok: false, code: "E_SESSION_CHANGED", effect: "none" });
    await pending;
    expect(context.controller.state.rows).toHaveLength(1);
    expect(context.controller.state.error).toBe("");
    expect(context.storage.value).toBe(stored);
  });

  it("late close success after collapse cannot trigger a follow-up list or attach", async () => {
    const close = deferred<unknown>();
    const context = setup((op) => (op === "close" ? (close.promise as never) : undefined));
    await openExisting(context);
    const pending = context.controller.close(termV2);
    await turnV2();
    context.controller.collapse();
    close.resolve({ ok: true, state: "closed", revision: 2 });
    await pending;
    expect(context.request.mock.calls.filter(([op]) => op === "list")).toHaveLength(1);
    expect(context.views).toHaveLength(1);
    expect(context.controller.state.open).toBe(false);
  });

  it("reopen with an unresolved create queries the original ID instead of ensure-empty", async () => {
    const context = setup((op) => {
      if (op === "create") return { ok: false, code: "E_DEADLINE", effect: "unknown" };
      if (op === "creation") return { ok: true, outcome: "unknown" };
      return undefined;
    });
    context.rows.splice(0);
    await context.controller.open();
    context.controller.collapse();
    await context.controller.open();
    expect(context.request.mock.calls.filter(([op]) => op === "create")).toHaveLength(1);
    expect(context.request.mock.calls.filter(([op]) => op === "creation")).toHaveLength(2);
  });

  it("stops after five same-term reconnect attempts", async () => {
    vi.useFakeTimers();
    const context = setup();
    await openExisting(context);
    await ready(context);
    for (const delay of [1000, 2000, 4000, 8000, 16000]) {
      context.views.at(-1)!.fail();
      await turnV2();
      await vi.advanceTimersByTimeAsync(delay);
      await turnV2();
      const current = context.views.at(-1)!;
      current.emit(attachedFrameV2(current.body.termId));
      await turnV2();
    }
    expect(context.views).toHaveLength(6);
    context.views.at(-1)!.fail();
    await turnV2();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(context.views).toHaveLength(6);
    expect(context.request.mock.calls.some(([op]) => op === "create")).toBe(false);
  });

  it("a duplicate early ready frame is rejected instead of creating a second cutover", async () => {
    const context = setup();
    await openExisting(context);
    context.views[0]!.emit({ t: "replay-end", offset: 0 });
    context.views[0]!.emit({ t: "ready", offset: 0 });
    await turnV2();
    expect(() => context.views[0]!.emit({ t: "ready", offset: 0 })).toThrow("E_NOT_READY");
    expect(context.views[0]!.signal.aborted).toBe(true);
  });

  it("early-ready live frames retain the 64KiB renderer queue cap while ACK is pending", async () => {
    const ack = deferred<unknown>();
    const context = setup((op) => (op === "ack" ? (ack.promise as never) : undefined));
    context.renderer.write.mockImplementation(() => new Promise<void>(() => {}));
    await openExisting(context);
    context.views[0]!.emit({ t: "replay-end", offset: 0 });
    context.views[0]!.emit({ t: "ready", offset: 0 });
    const bytesB64 = btoa(String.fromCharCode(...new Uint8Array(8192)));
    for (let index = 0; index < 8; index++) context.views[0]!.emit({ t: "output", offset: index * 8192, bytesB64 });
    await turnV2();
    expect(context.renderer.write).toHaveBeenCalledOnce();
    expect(() => context.views[0]!.emit({ t: "output", offset: 65_536, bytesB64 })).toThrow("E_UNAVAILABLE");
    expect(context.views[0]!.signal.aborted).toBe(true);
    expect(context.renderer.write).toHaveBeenCalledOnce();
  });
});
