import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import type { Clock } from "../../src/core/clock.js";
import {
  CONFIRM_PREVIEW_MAX_CODEPOINTS,
  buildConfirmText,
  confirmSwitch,
  type ConfirmCtx,
} from "../../src/topic-switch/confirm.js";
import type { AskUserRemotePort, AskUserRemoteSession, RemoteOutcome } from "../../src/ask-user/remote.js";

const TIMEOUT_MS = 30_000;
const HOLD_ID = "h1";

const text = buildConfirmText({
  confidence: 0.86,
  estUsd: 0.82,
  request: "写一首关于秋天的七言绝句",
  imageCount: 0,
});

class FakeSession implements AskUserRemoteSession {
  readonly request: unknown;
  readonly closeCalls: Array<{ by: string; outcome: string }> = [];
  private callback?: (outcome: RemoteOutcome) => boolean;
  constructor(request: unknown) {
    this.request = request;
  }
  setOnRemote(callback: (outcome: RemoteOutcome) => boolean): void {
    this.callback = callback;
  }
  close(by: "tui" | "abort" | "error" | "background", outcome: "answered" | "cancelled" | "aborted"): void {
    this.closeCalls.push({ by, outcome });
  }
  fire(outcome: RemoteOutcome): boolean {
    return this.callback?.(outcome) ?? false;
  }
  get closed(): { by: string; outcome: string } | undefined {
    return this.closeCalls[0];
  }
}

class NoCallbackSession implements AskUserRemoteSession {
  readonly closeCalls: Array<{ by: string; outcome: string }> = [];
  setOnRemote(): void {
    throw new Error("port cannot take callbacks");
  }
  close(by: "tui" | "abort" | "error" | "background", outcome: "answered" | "cancelled" | "aborted"): void {
    this.closeCalls.push({ by, outcome });
  }
}

function makeRemote(open?: (request: unknown) => AskUserRemoteSession | undefined) {
  const opened: unknown[] = [];
  let session: AskUserRemoteSession | undefined;
  const port: AskUserRemotePort = {
    open: (request) => {
      opened.push(request);
      if (open !== undefined) {
        session = open(request);
      } else {
        session = new FakeSession(request);
      }
      return session;
    },
  };
  return {
    port,
    opened,
    get session() {
      return session;
    },
  };
}

interface SelectCall {
  title: string;
  options: string[];
  opts?: { signal?: AbortSignal; timeout?: number } | undefined;
}

function makeSelect(fault?: "reject" | "throw") {
  const calls: SelectCall[] = [];
  let resolveSelect!: (value: string | undefined) => void;
  let rejectSelect!: (error: unknown) => void;
  const select = (
    title: string,
    options: string[],
    opts?: { signal?: AbortSignal; timeout?: number },
  ): Promise<string | undefined> => {
    calls.push({ title, options, opts });
    if (fault === "throw") throw new Error("select threw");
    return new Promise<string | undefined>((resolve, reject) => {
      resolveSelect = resolve;
      rejectSelect = reject;
      opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    });
  };
  return {
    select,
    calls,
    answer: (value: string | undefined) => resolveSelect(value),
    fail: () => rejectSelect(new Error("select failed")),
  };
}

function opts(
  clock: Clock,
  signal?: AbortSignal,
): { timeoutMs: number; clock: Clock; id: string; signal: AbortSignal } {
  return { timeoutMs: TIMEOUT_MS, clock, id: HOLD_ID, signal: signal ?? new AbortController().signal };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("buildConfirmText", () => {
  it("renders the planned Chinese copy", () => {
    expect(text.title).toBe(
      "这条请求看起来与当前会话无关（置信度 0.86）。缓存已过期，在本会话继续预计这一次就要 ≈$0.82。",
    );
    expect(text.switchLabel).toBe("切到新会话处理这条请求");
    expect(text.stayLabel).toBe("留在当前会话（本会话不再提示）");
    expect(text.header).toBe("新会话?");
    expect(text.preview).toBe("写一首关于秋天的七言绝句");
  });

  it("caps the preview at 120 code points (astral characters count as one)", () => {
    const request = "秋🌷风".repeat(100); // 300 code points, emoji is one code point
    const built = buildConfirmText({ confidence: 0.7, estUsd: 12.345, request, imageCount: 0 });
    expect(Array.from(built.preview)).toHaveLength(CONFIRM_PREVIEW_MAX_CODEPOINTS);
    expect(built.preview).toBe(Array.from(request).slice(0, CONFIRM_PREVIEW_MAX_CODEPOINTS).join(""));
  });

  it("mentions attached images and clamps non-finite inputs", () => {
    const built = buildConfirmText({ confidence: 5, estUsd: Number.NaN, request: "x", imageCount: 1 });
    expect(built.title).toContain("这条请求附带 1 张图片。");
    expect(built.title).toContain("置信度 1.00");
    expect(built.title).toContain("$0.00");
  });
});

describe("confirmSwitch — tui channel", () => {
  it("opens both channels in parallel and maps a tui switch answer", async () => {
    const clock = new FakeClock();
    const remote = makeRemote();
    const ui = makeSelect();
    const ctx: ConfirmCtx = { mode: "tui", hasUI: true, ui: { select: ui.select } };
    const pending = confirmSwitch(ctx, remote.port, text, opts(clock));
    expect(remote.opened).toEqual([
      {
        toolCallId: "topic-switch:" + HOLD_ID,
        questions: [
          {
            question: text.title + "\n\n" + text.preview,
            header: text.header,
            options: [{ label: text.switchLabel }, { label: text.stayLabel }],
            allowOther: false,
          },
        ],
        allowCancel: true,
      },
    ]);
    expect(ui.calls).toHaveLength(1);
    expect(ui.calls[0]?.title).toBe(text.title + "\n\n" + text.preview);
    expect(ui.calls[0]?.options).toEqual([text.switchLabel, text.stayLabel]);
    expect(ui.calls[0]?.opts?.timeout).toBe(TIMEOUT_MS);
    expect(ui.calls[0]?.opts?.signal).toBeDefined();
    ui.answer(text.switchLabel);
    await expect(pending).resolves.toEqual({ kind: "switch", by: "tui" });
    expect((remote.session as FakeSession).closeCalls).toEqual([{ by: "tui", outcome: "answered" }]);
    expect(clock.pendingTimers).toBe(0);
  });

  it("maps a tui stay answer", async () => {
    const clock = new FakeClock();
    const remote = makeRemote();
    const ui = makeSelect();
    const pending = confirmSwitch(
      { mode: "tui", hasUI: true, ui: { select: ui.select } },
      remote.port,
      text,
      opts(clock),
    );
    ui.answer(text.stayLabel);
    await expect(pending).resolves.toEqual({ kind: "stay", by: "tui" });
    expect((remote.session as FakeSession).closed).toEqual({ by: "tui", outcome: "answered" });
    expect(clock.pendingTimers).toBe(0);
  });

  it("maps an Esc dismissal to cancel", async () => {
    const clock = new FakeClock();
    const remote = makeRemote();
    const ui = makeSelect();
    const pending = confirmSwitch(
      { mode: "tui", hasUI: true, ui: { select: ui.select } },
      remote.port,
      text,
      opts(clock),
    );
    clock.advance(1_000);
    ui.answer(undefined);
    await expect(pending).resolves.toEqual({ kind: "cancel" });
    expect((remote.session as FakeSession).closed).toEqual({ by: "tui", outcome: "cancelled" });
    expect(clock.pendingTimers).toBe(0);
  });

  it("resolves timeout from the self-managed timer", async () => {
    const clock = new FakeClock();
    const remote = makeRemote();
    const ui = makeSelect();
    const pending = confirmSwitch(
      { mode: "tui", hasUI: true, ui: { select: ui.select } },
      remote.port,
      text,
      opts(clock),
    );
    clock.advance(TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ kind: "timeout" });
    expect((remote.session as FakeSession).closed).toEqual({ by: "abort", outcome: "aborted" });
    expect(ui.calls[0]?.opts?.signal?.aborted).toBe(true);
    expect(clock.pendingTimers).toBe(0);
    ui.answer(undefined); // late dismissal is a no-op
    await expect(pending).resolves.toEqual({ kind: "timeout" });
  });

  it("classifies a select auto-dismiss within the skew window as timeout", async () => {
    const clock = new FakeClock();
    const remote = makeRemote();
    const ui = makeSelect();
    const pending = confirmSwitch(
      { mode: "tui", hasUI: true, ui: { select: ui.select } },
      remote.port,
      text,
      opts(clock),
    );
    clock.advance(TIMEOUT_MS - 100); // pi's countdown dismisses just before our timer
    ui.answer(undefined);
    await expect(pending).resolves.toEqual({ kind: "timeout" });
    expect((remote.session as FakeSession).closed).toEqual({ by: "abort", outcome: "aborted" });
    expect(clock.pendingTimers).toBe(0);
  });
});

describe("confirmSwitch — web channel", () => {
  it("lets a web switch answer win and never closes the session itself", async () => {
    const clock = new FakeClock();
    const remote = makeRemote();
    const ui = makeSelect();
    const pending = confirmSwitch(
      { mode: "tui", hasUI: true, ui: { select: ui.select } },
      remote.port,
      text,
      opts(clock),
    );
    const claimed = (remote.session as FakeSession).fire({
      kind: "answer",
      answers: { [text.header]: text.switchLabel },
      origin: "web",
    });
    expect(claimed).toBe(true);
    await expect(pending).resolves.toEqual({ kind: "switch", by: "web" });
    // the bridge finishes the record on a true return; our own close must stay silent
    expect((remote.session as FakeSession).closeCalls).toEqual([]);
    expect(ui.calls[0]?.opts?.signal?.aborted).toBe(true);
    expect(clock.pendingTimers).toBe(0);
    ui.answer(undefined); // late select dismissal is a no-op
    await expect(pending).resolves.toEqual({ kind: "switch", by: "web" });
  });

  it("maps a web stay answer and a web cancel", async () => {
    const clock = new FakeClock();
    const remote = makeRemote();
    const ui = makeSelect();
    const first = confirmSwitch(
      { mode: "tui", hasUI: true, ui: { select: ui.select } },
      remote.port,
      text,
      opts(clock),
    );
    expect(
      (remote.session as FakeSession).fire({ kind: "answer", answers: { q: text.stayLabel }, origin: "web" }),
    ).toBe(true);
    await expect(first).resolves.toEqual({ kind: "stay", by: "web" });

    const secondRemote = makeRemote();
    const second = confirmSwitch(
      { mode: "tui", hasUI: true, ui: { select: ui.select } },
      secondRemote.port,
      text,
      opts(clock),
    );
    expect((secondRemote.session as FakeSession).fire({ kind: "cancel", origin: "web" })).toBe(true);
    await expect(second).resolves.toEqual({ kind: "cancel" });
  });

  it("treats an answer matching neither label as cancel (defensive)", async () => {
    const clock = new FakeClock();
    const remote = makeRemote();
    const pending = confirmSwitch({ mode: "rpc", hasUI: true }, remote.port, text, opts(clock));
    expect((remote.session as FakeSession).fire({ kind: "answer", answers: { q: "别的" }, origin: "web" })).toBe(true);
    await expect(pending).resolves.toEqual({ kind: "cancel" });
  });

  it("rejects a late web answer after the tui answer claimed the race", async () => {
    const clock = new FakeClock();
    const remote = makeRemote();
    const ui = makeSelect();
    const pending = confirmSwitch(
      { mode: "tui", hasUI: true, ui: { select: ui.select } },
      remote.port,
      text,
      opts(clock),
    );
    ui.answer(text.stayLabel);
    await flush(); // let the select microtask claim "tui"
    expect(
      (remote.session as FakeSession).fire({ kind: "answer", answers: { q: text.switchLabel }, origin: "web" }),
    ).toBe(false);
    await expect(pending).resolves.toEqual({ kind: "stay", by: "tui" });
  });

  it("web callback claiming synchronously wins over a select resolution queued in the same tick", async () => {
    const clock = new FakeClock();
    const remote = makeRemote();
    const ui = makeSelect();
    const pending = confirmSwitch(
      { mode: "tui", hasUI: true, ui: { select: ui.select } },
      remote.port,
      text,
      opts(clock),
    );
    ui.answer(text.switchLabel); // queues the microtask, does not run it yet
    expect(
      (remote.session as FakeSession).fire({ kind: "answer", answers: { q: text.stayLabel }, origin: "web" }),
    ).toBe(true); // synchronous claim runs first
    await expect(pending).resolves.toEqual({ kind: "stay", by: "web" });
  });
});

describe("confirmSwitch — rpc channel policy", () => {
  it("rpc with a remote uses the web channel only", async () => {
    const clock = new FakeClock();
    const remote = makeRemote();
    const ui = makeSelect();
    const ctx: ConfirmCtx = { mode: "rpc", hasUI: true, ui: { select: ui.select } };
    const pending = confirmSwitch(ctx, remote.port, text, opts(clock));
    expect(ui.calls).toHaveLength(0);
    expect(
      (remote.session as FakeSession).fire({ kind: "answer", answers: { q: text.switchLabel }, origin: "web" }),
    ).toBe(true);
    await expect(pending).resolves.toEqual({ kind: "switch", by: "web" });
  });

  it("rpc web-only times out and closes the dialog", async () => {
    const clock = new FakeClock();
    const remote = makeRemote();
    const pending = confirmSwitch({ mode: "rpc", hasUI: true }, remote.port, text, opts(clock));
    clock.advance(TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ kind: "timeout" });
    expect((remote.session as FakeSession).closeCalls).toEqual([{ by: "abort", outcome: "aborted" }]);
    expect(clock.pendingTimers).toBe(0);
  });

  it("rpc without a remote falls back to select", async () => {
    const clock = new FakeClock();
    const ui = makeSelect();
    const pending = confirmSwitch(
      { mode: "rpc", hasUI: true, ui: { select: ui.select } },
      { open: () => undefined },
      text,
      opts(clock),
    );
    expect(ui.calls).toHaveLength(1);
    ui.answer(text.switchLabel);
    await expect(pending).resolves.toEqual({ kind: "switch", by: "tui" });
  });

  it("rpc with a throwing open falls back to select", async () => {
    const clock = new FakeClock();
    const ui = makeSelect();
    const port: AskUserRemotePort = {
      open: () => {
        throw new Error("hub gone");
      },
    };
    const pending = confirmSwitch({ mode: "rpc", hasUI: true, ui: { select: ui.select } }, port, text, opts(clock));
    expect(ui.calls).toHaveLength(1);
    ui.answer(text.stayLabel);
    await expect(pending).resolves.toEqual({ kind: "stay", by: "tui" });
  });
});

describe("confirmSwitch — degraded environments", () => {
  it("returns unavailable without prompting when hasUI is false", async () => {
    const clock = new FakeClock();
    const remote = makeRemote();
    const ui = makeSelect();
    const ctx: ConfirmCtx = { mode: "print", hasUI: false, ui: { select: ui.select } };
    const pending = confirmSwitch(ctx, remote.port, text, opts(clock));
    await expect(pending).resolves.toEqual({ kind: "unavailable" });
    expect(remote.opened).toHaveLength(0);
    expect(ui.calls).toHaveLength(0);
    expect(clock.pendingTimers).toBe(0);
  });

  it("returns unavailable when neither channel exists (ui absent, no remote)", async () => {
    const clock = new FakeClock();
    const pending = confirmSwitch({ mode: "tui", hasUI: true, ui: {} }, undefined, text, opts(clock));
    await expect(pending).resolves.toEqual({ kind: "unavailable" });
  });

  it("degrades to web-only when ui.select is absent but a remote is attached", async () => {
    const clock = new FakeClock();
    const remote = makeRemote();
    const pending = confirmSwitch({ mode: "tui", hasUI: true, ui: {} }, remote.port, text, opts(clock));
    expect(remote.opened).toHaveLength(1);
    expect((remote.session as FakeSession).fire({ kind: "cancel", origin: "web" })).toBe(true);
    await expect(pending).resolves.toEqual({ kind: "cancel" });
  });

  it("a port whose setOnRemote throws degrades to local-only (tui)", async () => {
    const clock = new FakeClock();
    const ui = makeSelect();
    const remote = makeRemote(() => new NoCallbackSession());
    const pending = confirmSwitch(
      { mode: "tui", hasUI: true, ui: { select: ui.select } },
      remote.port,
      text,
      opts(clock),
    );
    expect(ui.calls).toHaveLength(1);
    ui.answer(text.switchLabel);
    await expect(pending).resolves.toEqual({ kind: "switch", by: "tui" });
    expect((remote.session as NoCallbackSession).closeCalls).toEqual([{ by: "error", outcome: "aborted" }]);
  });

  it("a port whose setOnRemote throws leaves rpc without any channel ⇒ unavailable", async () => {
    const clock = new FakeClock();
    const remote = makeRemote(() => new NoCallbackSession());
    const pending = confirmSwitch({ mode: "rpc", hasUI: true }, remote.port, text, opts(clock));
    await expect(pending).resolves.toEqual({ kind: "unavailable" });
    expect((remote.session as NoCallbackSession).closeCalls).toEqual([{ by: "error", outcome: "aborted" }]);
    expect(clock.pendingTimers).toBe(0);
  });

  it("a rejecting select resolves error and closes the session", async () => {
    const clock = new FakeClock();
    const remote = makeRemote();
    const ui = makeSelect("reject");
    const pending = confirmSwitch(
      { mode: "tui", hasUI: true, ui: { select: ui.select } },
      remote.port,
      text,
      opts(clock),
    );
    ui.fail();
    await expect(pending).resolves.toEqual({ kind: "error" });
    expect((remote.session as FakeSession).closed).toEqual({ by: "error", outcome: "aborted" });
    expect(clock.pendingTimers).toBe(0);
  });

  it("a synchronously throwing select resolves error", async () => {
    const clock = new FakeClock();
    const remote = makeRemote();
    const ui = makeSelect("throw");
    const pending = confirmSwitch(
      { mode: "tui", hasUI: true, ui: { select: ui.select } },
      remote.port,
      text,
      opts(clock),
    );
    await expect(pending).resolves.toEqual({ kind: "error" });
    expect((remote.session as FakeSession).closed).toEqual({ by: "error", outcome: "aborted" });
    expect(clock.pendingTimers).toBe(0);
  });
});

describe("confirmSwitch — external abort", () => {
  it("aborts both sides immediately while the select is open", async () => {
    const clock = new FakeClock();
    const remote = makeRemote();
    const ui = makeSelect();
    const controller = new AbortController();
    const pending = confirmSwitch(
      { mode: "tui", hasUI: true, ui: { select: ui.select } },
      remote.port,
      text,
      opts(clock, controller.signal),
    );
    controller.abort();
    await expect(pending).resolves.toEqual({ kind: "aborted" });
    expect((remote.session as FakeSession).closeCalls).toEqual([{ by: "abort", outcome: "aborted" }]);
    expect(ui.calls[0]?.opts?.signal?.aborted).toBe(true);
    expect(clock.pendingTimers).toBe(0);
    ui.answer(undefined); // late dismissal
    expect(
      (remote.session as FakeSession).fire({ kind: "answer", answers: { q: text.switchLabel }, origin: "web" }),
    ).toBe(false); // late answer rejected
    await expect(pending).resolves.toEqual({ kind: "aborted" });
  });

  it("aborts a web-only dialog (rpc, no select)", async () => {
    const clock = new FakeClock();
    const remote = makeRemote();
    const controller = new AbortController();
    const pending = confirmSwitch({ mode: "rpc", hasUI: true }, remote.port, text, opts(clock, controller.signal));
    controller.abort();
    await expect(pending).resolves.toEqual({ kind: "aborted" });
    expect((remote.session as FakeSession).closeCalls).toEqual([{ by: "abort", outcome: "aborted" }]);
    expect(clock.pendingTimers).toBe(0);
  });

  it("an already-aborted signal resolves aborted without opening anything", async () => {
    const clock = new FakeClock();
    const remote = makeRemote();
    const ui = makeSelect();
    const controller = new AbortController();
    controller.abort();
    const pending = confirmSwitch(
      { mode: "tui", hasUI: true, ui: { select: ui.select } },
      remote.port,
      text,
      opts(clock, controller.signal),
    );
    await expect(pending).resolves.toEqual({ kind: "aborted" });
    expect(remote.opened).toHaveLength(0);
    expect(ui.calls).toHaveLength(0);
    expect(clock.pendingTimers).toBe(0);
  });
});
