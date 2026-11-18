import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalControllerV2 } from "../../../src/web-hub/ui/src/components/terminal/v2/controller.js";
import type { TerminalViewFrameV2 } from "../../../src/web-hub/ui/src/components/terminal/protocol-v2.js";
import { saveTerminalV2Restore, type TerminalRestoreStorageV2 } from "../../../src/web-hub/ui/src/logic/terminal-v2.js";
import {
  attachedFrameV2,
  createTerminalMockV2,
  hubV2,
  quotaV2,
  requestV2,
  rowV2,
  scopeV2,
  termV2,
  turnV2,
  type RequestHandlerV2,
} from "./terminal-v2-fixtures.js";

class MemoryStorage implements TerminalRestoreStorageV2 {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function setup(
  options: { empty?: boolean; handler?: RequestHandlerV2; storage?: MemoryStorage; hidden?: () => boolean } = {},
) {
  const mock = createTerminalMockV2(options.handler);
  if (options.empty) {
    mock.rows.splice(0);
    for (const dimension of Object.values(mock.quota)) {
      dimension.used = 0;
      dimension.unknown = 0;
    }
  }
  const renderer = {
    write: vi.fn(async (_bytes: Uint8Array) => {}),
    reset: vi.fn(),
    dimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
  };
  const controller = createTerminalControllerV2({
    transport: mock.transport,
    scope: scopeV2,
    renderer,
    ...(options.storage ? { storage: options.storage } : {}),
    ...(options.hidden ? { hidden: options.hidden } : {}),
    now: () => 100_000,
    id: () => requestV2,
  });
  return { ...mock, renderer, controller };
}

async function openExisting(context: ReturnType<typeof setup>) {
  const pending = context.controller.open();
  await turnV2();
  expect(context.views).toHaveLength(1);
  context.views[0]!.emit(attachedFrameV2());
  await pending;
}

async function makeReady(context: ReturnType<typeof setup>, index = 0) {
  const view = context.views[index]!;
  view.emit({ t: "replay-end", offset: 0 });
  await turnV2();
  view.emit({ t: "ready", offset: 0 });
  await turnV2();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("terminal v2 explicit intent and restore", () => {
  it("construction and restore of an empty list never create or attach", async () => {
    const context = setup({ empty: true });
    expect(context.request).not.toHaveBeenCalled();
    expect(context.view).not.toHaveBeenCalled();
    expect(await context.controller.restore()).toBe(true);
    expect(context.request.mock.calls.map(([op]) => op)).toEqual(["list"]);
    expect(context.controller.state.phase).toBe("idle");
    context.controller.dispose();
  });

  it("first explicit open ensures only once across double-click; + is a distinct new intent", async () => {
    const context = setup({ empty: true });
    const first = context.controller.open();
    const second = context.controller.open();
    await turnV2();
    const creates = context.request.mock.calls.filter(([op]) => op === "create");
    expect(creates).toHaveLength(1);
    expect(creates[0]?.[1]).toMatchObject({ requestId: requestV2, mode: "ensure-empty" });
    expect(context.views).toHaveLength(1);
    const created = context.views[0]!.body.termId;
    context.views[0]!.emit(attachedFrameV2(created));
    await Promise.all([first, second]);
    await makeReady(context);
    context.request.mockClear();
    const plus = context.controller.newTerminal();
    await turnV2();
    expect(context.request.mock.calls.filter(([op]) => op === "create")).toHaveLength(1);
    expect(context.request.mock.calls.find(([op]) => op === "create")?.[1]).toMatchObject({ mode: "new" });
    const secondView = context.views[1]!;
    secondView.emit(attachedFrameV2(secondView.body.termId));
    await plus;
    expect(context.views.map((view) => view.body.termId)).toEqual([created, secondView.body.termId]);
    context.controller.dispose();
  });

  it("cold unknown remains read-only and counted while restore does not create", async () => {
    const context = setup({ empty: true });
    context.unknownResources.push({ allocationTag: "A".repeat(22), state: "cleanup-unknown" });
    for (const dimension of Object.values(context.quota)) {
      dimension.used = 1;
      dimension.unknown = 1;
    }
    await context.controller.restore();
    expect(context.controller.state.unknownResources).toHaveLength(1);
    expect(context.controller.state.quota?.session).toMatchObject({ used: 1, unknown: 1, limit: 2 });
    expect(context.request.mock.calls.some(([op]) => op === "create")).toBe(false);
    const plus = context.controller.newTerminal();
    await turnV2();
    const created = context.views[0]!.body.termId;
    context.views[0]!.emit(attachedFrameV2(created));
    await plus;
    expect(context.request.mock.calls.find(([op]) => op === "create")?.[1]).toMatchObject({ mode: "new" });
    context.controller.dispose();
  });

  it("same-hub restore queries only persisted original request IDs and never ensures empty", async () => {
    const storage = new MemoryStorage();
    saveTerminalV2Restore(
      storage,
      scopeV2,
      {
        open: true,
        hubInstance: hubV2,
        activeTermId: null,
        pendingRequestIds: [requestV2],
      },
      100_000,
    );
    const context = setup({ empty: true, storage });
    await context.controller.restore();
    expect(context.request.mock.calls.map(([op]) => op)).toEqual(["list", "creation"]);
    expect(context.request.mock.calls[1]?.[1]).toEqual({
      scope: scopeV2,
      hubInstance: hubV2,
      requestId: requestV2,
    });
    expect(context.controller.state.notice).toBe("createUnknown");
    context.controller.dispose();
  });

  it("a different hub restores no active view and issues no create", async () => {
    const storage = new MemoryStorage();
    saveTerminalV2Restore(
      storage,
      scopeV2,
      {
        open: true,
        hubInstance: "O".repeat(22),
        activeTermId: termV2,
        pendingRequestIds: [requestV2],
      },
      100_000,
    );
    const context = setup({ storage });
    await context.controller.restore();
    expect(context.request.mock.calls.map(([op]) => op)).toEqual(["list"]);
    expect(context.view).not.toHaveBeenCalled();
    expect(context.controller.state.notice).toBe("hubChanged");
    context.controller.dispose();
  });

  it("create response loss queries the original requestId and does not send another create", async () => {
    const handler: RequestHandlerV2 = (op, body) => {
      if (op === "create") return { ok: false, code: "E_DEADLINE", effect: "unknown" };
      if (op === "creation" && "requestId" in body) {
        return { ok: true, outcome: "created", termId: termV2 };
      }
      return undefined;
    };
    const context = setup({ empty: true, handler });
    // The typed mock's created projection supplies the term after the query.
    const pending = context.controller.open();
    await turnV2();
    expect(context.request.mock.calls.map(([op]) => op)).toEqual(["list", "create", "creation", "list"]);
    expect(context.request.mock.calls.filter(([op]) => op === "create")).toHaveLength(1);
    expect(context.request.mock.calls[2]?.[1]).toMatchObject({ requestId: requestV2 });
    context.views[0]?.emit(attachedFrameV2(termV2));
    await pending;
    context.controller.dispose();
  });
});

describe("terminal v2 replay, ACK and live state machine", () => {
  it("gates input before replay ACK/ready and ACKs only renderer-completed offsets", async () => {
    const context = setup();
    const writes: Array<() => void> = [];
    context.renderer.write.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          writes.push(resolve);
        }),
    );
    const opening = context.controller.open();
    await turnV2();
    const view = context.views[0]!;
    view.emit(attachedFrameV2(termV2, 0, 2));
    await opening;
    view.emit({ t: "output", offset: 0, bytesB64: "YQ==" });
    view.emit({ t: "output", offset: 1, bytesB64: "Yg==" });
    view.emit({ t: "replay-end", offset: 2 });
    context.controller.input(new Uint8Array([27]));
    await turnV2();
    expect(context.request.mock.calls.some(([op]) => op === "input" || op === "resize")).toBe(false);
    expect(context.request.mock.calls.some(([op]) => op === "ack")).toBe(false);
    writes[0]!();
    await turnV2();
    expect(context.request.mock.calls.some(([op]) => op === "ack")).toBe(false);
    writes[1]!();
    await turnV2();
    expect(context.request.mock.calls.find(([op]) => op === "ack")?.[1]).toMatchObject({
      offset: 2,
      replayComplete: true,
    });
    view.emit({ t: "ready", offset: 2 });
    await turnV2();
    expect(context.controller.state.writable).toBe(true);
    context.request.mockClear();
    view.emit({ t: "output", offset: 2, bytesB64: "Yw==" });
    view.emit({ t: "output", offset: 3, bytesB64: "ZA==" });
    await turnV2();
    expect(writes).toHaveLength(3);
    writes[2]!();
    await turnV2();
    // The second byte was received but not rendered; the first live ACK must be 3, not 4.
    expect(context.request.mock.calls.find(([op]) => op === "ack")?.[1]).toMatchObject({ offset: 3 });
    expect(context.request.mock.calls.find(([op]) => op === "ack")?.[1]).not.toMatchObject({ offset: 4 });
    writes[3]!();
    await turnV2();
    expect(context.request.mock.calls.filter(([op]) => op === "ack").at(-1)?.[1]).toMatchObject({ offset: 4 });
    context.controller.dispose();
  });

  it("supports explicit replay/live gaps and never rebuilds a shell for an exit", async () => {
    const context = setup();
    const opening = context.controller.open();
    await turnV2();
    const view = context.views[0]!;
    view.emit(attachedFrameV2(termV2, 0, 4));
    await opening;
    view.emit({ t: "output", offset: 0, bytesB64: "YQ==" });
    view.emit({ t: "gap", from: 1, to: 3 });
    view.emit({ t: "output", offset: 3, bytesB64: "Yg==" });
    view.emit({ t: "replay-end", offset: 4 });
    await turnV2();
    view.emit({ t: "ready", offset: 4 });
    await turnV2();
    view.emit({ t: "gap", from: 4, to: 6 });
    expect(context.controller.state.gap).toEqual({ from: 4, to: 6 });
    view.emit({ t: "state", termId: termV2, state: "exited", exitCode: 17 });
    expect(context.controller.state.exitCode).toBe(17);
    expect(context.controller.state.writable).toBe(false);
    expect(context.request.mock.calls.some(([op]) => op === "create")).toBe(false);
    context.controller.dispose();
  });

  it("disconnect reconnects only the same term, pauses while hidden and never replays input", async () => {
    vi.useFakeTimers();
    let hidden = true;
    const context = setup({ hidden: () => hidden });
    await openExisting(context);
    await makeReady(context);
    context.controller.input(new Uint8Array([97]));
    await turnV2();
    const writes = context.request.mock.calls.filter(([op]) => op === "input").length;
    context.views[0]!.fail();
    await turnV2();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(context.views).toHaveLength(1);
    hidden = false;
    context.controller.visibilityChanged();
    await turnV2();
    expect(context.views).toHaveLength(2);
    expect(context.views[1]!.body.termId).toBe(termV2);
    expect(context.request.mock.calls.filter(([op]) => op === "input")).toHaveLength(writes);
    expect(context.request.mock.calls.some(([op]) => op === "create")).toBe(false);
    context.controller.dispose();
  });
});

describe("terminal v2 input uncertainty and tab lifecycle", () => {
  async function readyContext(handler?: RequestHandlerV2) {
    const context = setup({ handler });
    await openExisting(context);
    await makeReady(context);
    context.request.mockClear();
    return context;
  }

  it("unknown input queries only original view/seq without bytes/kind and never writes twice", async () => {
    const handler: RequestHandlerV2 = (op, body) => {
      if (op === "input" && "bytesB64" in body) return { ok: false, code: "E_DEADLINE", effect: "unknown" };
      if (op === "input" && "queryOnly" in body) return { ok: true, acceptedThrough: body.seq };
      return undefined;
    };
    const context = await readyContext(handler);
    context.controller.input(new Uint8Array([27, 91, 65]), "user");
    await turnV2();
    const inputs = context.request.mock.calls.filter(([op]) => op === "input");
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.[1]).toMatchObject({ seq: 0, viewId: "V".repeat(22), kind: "user" });
    expect(inputs[1]?.[1]).toEqual({
      scope: scopeV2,
      hubInstance: hubV2,
      termId: termV2,
      viewId: "V".repeat(22),
      seq: 0,
      queryOnly: true,
    });
    expect(inputs[1]?.[1]).not.toHaveProperty("bytesB64");
    expect(inputs[1]?.[1]).not.toHaveProperty("kind");
    context.controller.dispose();
  });

  it("E_INPUT_UNKNOWN stays unknown, stops input and triggers no replay/new seq/create", async () => {
    const handler: RequestHandlerV2 = (op, body) => {
      if (op === "input" && "bytesB64" in body) return { ok: false, code: "E_DEADLINE", effect: "unknown" };
      if (op === "input" && "queryOnly" in body) return { ok: false, code: "E_INPUT_UNKNOWN", effect: "unknown" };
      return undefined;
    };
    const context = await readyContext(handler);
    context.controller.input(new Uint8Array([3]));
    await turnV2();
    expect(context.controller.state.notice).toBe("inputUnknown");
    expect(context.controller.state.error).toContain("E_INPUT_UNKNOWN");
    expect(context.views[0]!.signal.aborted).toBe(true);
    expect(context.request.mock.calls.filter(([op]) => op === "input")).toHaveLength(2);
    expect(context.request.mock.calls.some(([op]) => op === "create")).toBe(false);
    context.controller.dispose();
  });

  it("switch and collapse abort only their own views; explicit close is the sole close call", async () => {
    const context = setup();
    context.rows.push(rowV2("U".repeat(22), 2));
    await openExisting(context);
    await makeReady(context);
    const selecting = context.controller.select("U".repeat(22));
    await turnV2();
    expect(context.views[0]!.signal.aborted).toBe(true);
    expect(context.views).toHaveLength(2);
    context.views[1]!.emit(attachedFrameV2("U".repeat(22)));
    await selecting;
    context.controller.collapse();
    expect(context.views[1]!.signal.aborted).toBe(true);
    expect(context.request.mock.calls.some(([op]) => op === "close")).toBe(false);
    expect(context.request.mock.calls.some(([op]) => op === "create")).toBe(false);
    await context.controller.close("U".repeat(22));
    expect(context.request.mock.calls.filter(([op]) => op === "close")).toHaveLength(1);
    context.controller.dispose();
  });

  it("rename uses shared normalization and close of the last tab leaves an empty state", async () => {
    const context = setup();
    await openExisting(context);
    await context.controller.rename(termV2, "  工作😀  ");
    expect(context.request.mock.calls.find(([op]) => op === "rename")?.[1]).toMatchObject({ name: "工作😀" });
    expect(context.controller.state.rows[0]?.name).toBe("工作😀");
    await context.controller.close(termV2);
    expect(context.controller.state.rows).toEqual([]);
    expect(context.controller.state.activeTermId).toBeNull();
    expect(context.request.mock.calls.some(([op]) => op === "create")).toBe(false);
    context.controller.dispose();
  });

  it("resize waits for ready and uses its own monotonic sequence", async () => {
    const context = setup();
    await openExisting(context);
    await context.controller.resize();
    expect(context.request.mock.calls.some(([op]) => op === "resize")).toBe(false);
    await makeReady(context);
    await context.controller.resize();
    const sizes = context.request.mock.calls.filter(([op]) => op === "resize");
    expect(sizes.map(([, body]) => ("seq" in body ? body.seq : -1))).toEqual([0, 1]);
    context.controller.dispose();
  });
});
