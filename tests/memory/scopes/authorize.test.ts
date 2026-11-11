/** #39 P1 authorize: reject-first race, exact affirm + digest8, originKind gate, binding recheck. */
import { describe, expect, it } from "vitest";
import {
  affirmLabel,
  createOpApprovalPort,
  REJECT_LABEL,
  type ApprovalClock,
  type TuiSelectPort,
} from "../../../src/memory/scopes/authorize.js";
import { createHumanTurnTracker, createMemoryOpCapRegistry } from "../../../src/memory/scopes/op-cap.js";
import { scopedOpDigest, bodyTextDigest, sha256Hex } from "../../../src/memory/scopes/limits.js";
import type { AskUserRemotePort, AskUserRemoteSession, RemoteOutcome } from "../../../src/ask-user/remote.js";
import type { FrozenScopedOp, MemoryOwner, OpApprovalRequest } from "../../../src/memory/scopes/types.js";

const owner: MemoryOwner = { incarnation: {}, sid: "sess-1", sessionFile: "/s.json", sessionEpoch: 1, branchGen: 1 };
const operation = {
  storageScope: "session",
  op: "create",
  text: "precious user fact",
  authority: "user",
} as FrozenScopedOp;

class ManualClock implements ApprovalClock {
  timer: { fn: () => void } | undefined;
  setTimer(_ms: number, fn: () => void): unknown {
    this.timer = { fn };
    return 1;
  }
  clearTimer(): void {
    this.timer = undefined;
  }
  now(): number {
    return 0;
  }
  fire(): void {
    const t = this.timer;
    this.timer = undefined;
    t?.fn();
  }
}

class FakeSelect {
  last: { title: string; options: readonly string[] } | undefined;
  resolve: ((choice: string | undefined) => void) | undefined;
  select: TuiSelectPort = (title, options) => {
    this.last = { title, options };
    return new Promise<string | undefined>((resolve) => {
      this.resolve = resolve;
    });
  };
  answer(choice: string | undefined): void {
    this.resolve?.(choice);
  }
}

interface RemoteRecord {
  req: { toolCallId: string; question: string; attributionTitle?: string };
  onRemote?: (outcome: RemoteOutcome) => boolean;
  closed: { by: string; outcome: string }[];
}

class FakeRemote implements AskUserRemotePort {
  opens: RemoteRecord[] = [];
  broken = false;
  open(req: Parameters<AskUserRemotePort["open"]>[0]): AskUserRemoteSession | undefined {
    if (this.broken) throw new Error("hub disconnected");
    const record: RemoteRecord = {
      req: {
        toolCallId: req.toolCallId,
        question: req.questions[0]?.question ?? "",
        attributionTitle: req.attributionTitle,
      },
      closed: [],
    };
    this.opens.push(record);
    return {
      setOnRemote: (fn) => {
        record.onRemote = fn;
      },
      close: (by, outcome) => {
        record.closed.push({ by, outcome });
      },
    };
  }
  deliver(outcome: RemoteOutcome): boolean {
    const record = this.opens.at(-1);
    return record?.onRemote?.(outcome) ?? false;
  }
}

function rig(overrides: { select?: TuiSelectPort; remote?: AskUserRemotePort; localSelectForbidden?: boolean } = {}) {
  const tracker = createHumanTurnTracker();
  const registry = createMemoryOpCapRegistry(() => tracker.current());
  const clock = new ManualClock();
  const port = createOpApprovalPort({
    tracker,
    registry,
    ...(overrides.select !== undefined ? { select: overrides.select } : {}),
    ...(overrides.remote !== undefined ? { remote: overrides.remote } : {}),
    ...(overrides.localSelectForbidden !== undefined ? { localSelectForbidden: overrides.localSelectForbidden } : {}),
    clock,
    timeoutMs: 5000,
  });
  const turn = tracker.noteInteractive(owner);
  const request: OpApprovalRequest = {
    operation,
    binding: {
      owner,
      humanTurn: turn,
      toolCallId: "tc1",
      nonce: "a".repeat(32),
      opDigest: scopedOpDigest(operation),
      textDigest: bodyTextDigest("precious user fact"),
    },
    projectLabel: "pi-toolkit",
  };
  return { tracker, registry, clock, port, request };
}

const digest8 = scopedOpDigest(operation).slice(0, 8);
const AFFIRM = affirmLabel("session", digest8);

describe("preconditions (fail closed before any dialog)", () => {
  it("no human turn ⇒ E_HUB_NEEDS_HUMAN_TURN; a model string never mints a cap", async () => {
    const tracker = createHumanTurnTracker();
    const registry = createMemoryOpCapRegistry(() => tracker.current());
    const port = createOpApprovalPort({ tracker, registry, clock: new ManualClock() });
    const turnless = { ...rig().request };
    const result = await port.request({
      ...turnless,
      binding: { ...turnless.binding, humanTurn: { id: "forged".repeat(4), channel: "tui", owner } },
    });
    expect(result).toMatchObject({ approved: false, code: "E_HUB_NEEDS_HUMAN_TURN" }); // forged turn is not the tracker's
    expect(registry.stateOf({} as never)).toBe("unknown");
  });

  it("no channel at all ⇒ E_HUB_CONFIRM_UNAVAILABLE; rpc never opens the local select", async () => {
    const none = rig();
    expect(await none.port.request(none.request)).toMatchObject({ approved: false, code: "E_HUB_CONFIRM_UNAVAILABLE" });
    const rpc = rig({ select: new FakeSelect().select, localSelectForbidden: true });
    expect(await rpc.port.request(rpc.request)).toMatchObject({ approved: false, code: "E_HUB_CONFIRM_UNAVAILABLE" });
  });

  it("binding/operation digest mismatch (tamper) ⇒ E_META_INVALID without any dialog", async () => {
    const { port, request } = rig({ select: new FakeSelect().select });
    const tampered = { ...request, operation: { ...operation, text: "OTHER TEXT" } as FrozenScopedOp };
    expect(await port.request(tampered)).toMatchObject({ approved: false, code: "E_META_INVALID" });
    const badNonce = { ...request, binding: { ...request.binding, nonce: "zz" } };
    expect(await port.request(badNonce)).toMatchObject({ approved: false, code: "E_META_INVALID" });
  });
});

describe("TUI channel", () => {
  it("reject option is FIRST; the title shows the full frozen body and digest8; affirm mints a cap", async () => {
    const select = new FakeSelect();
    const { port, request, registry } = rig({ select: select.select });
    const pending = port.request(request);
    expect(select.last?.options[0]).toBe(REJECT_LABEL);
    expect(select.last?.options[1]).toBe(AFFIRM);
    expect(select.last?.title).toContain("precious user fact");
    expect(select.last?.title).toContain(digest8);
    select.answer(AFFIRM);
    const result = await pending;
    expect(result.approved).toBe(true);
    if (result.approved) {
      const reserved = registry.reserve(result.cap, owner);
      expect(reserved).toBeDefined();
      expect(reserved?.channel).toBe("tui");
    }
  });

  it("REJECT / a different string / dismissal all decline; the turn is then rejected", async () => {
    const select = new FakeSelect();
    const { port, request, tracker } = rig({ select: select.select });
    const pending = port.request(request);
    select.answer("yes please"); // not the exact affirm label
    expect(await pending).toMatchObject({ approved: false, code: "E_HUB_DECLINED" });
    expect(tracker.rejected()).toBe(true);
    expect(await port.request(request)).toMatchObject({ approved: false, code: "E_HUB_DECLINED_TURN" });
  });

  it("timeout declines and clears the timer", async () => {
    const select = new FakeSelect();
    const { port, request, clock } = rig({ select: select.select });
    const pending = port.request(request);
    clock.fire();
    expect(await pending).toMatchObject({ approved: false, code: "E_HUB_DECLINED" });
    expect(clock.timer).toBeUndefined();
    select.answer(AFFIRM); // late TUI answer is a no-op
  });

  it("an aborted signal declines and rejects the turn (no affirm ⇒ rejected)", async () => {
    const select = new FakeSelect();
    const { port, request, tracker } = rig({ select: select.select });
    const controller = new AbortController();
    const pending = port.request(request, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ approved: false, code: "E_HUB_DECLINED" });
    expect(tracker.rejected()).toBe(true);
  });
});

describe("web channel", () => {
  it("loopback/lan exact-affirm approves with channel web and who=sha8(origin)", async () => {
    const remote = new FakeRemote();
    const select = new FakeSelect();
    const { port, request, registry } = rig({ select: select.select, remote });
    const pending = port.request(request);
    expect(remote.opens[0]?.req.toolCallId).toBe(`memory-op:${"a".repeat(32)}`);
    const accepted = remote.deliver({
      kind: "answer",
      answers: { HUB: AFFIRM },
      origin: "user@127.0.0.1",
      originKind: "loopback",
    });
    expect(accepted).toBe(true);
    const result = await pending;
    expect(result.approved).toBe(true);
    if (result.approved) {
      expect(registry.reserve(result.cap, owner)?.channel).toBe("web");
      expect(registry.reserve(result.cap, owner)?.who).toBe(sha256Hex("user@127.0.0.1").slice(0, 8));
    }
  });

  it("feishu / missing originKind / wrong label ⇒ callback false, no cap; TUI can still win", async () => {
    for (const outcome of [
      { kind: "answer", answers: { SESSION: AFFIRM }, origin: "feishu", originKind: "feishu" },
      { kind: "answer", answers: { SESSION: AFFIRM }, origin: "user@lan" },
      { kind: "answer", answers: { SESSION: "别的选项" }, origin: "user@lan", originKind: "lan" },
    ] as RemoteOutcome[]) {
      const remote = new FakeRemote();
      const select = new FakeSelect();
      const { port, request } = rig({ select: select.select, remote });
      const pending = port.request(request);
      expect(remote.deliver(outcome)).toBe(false);
      select.answer(AFFIRM);
      expect((await pending).approved).toBe(true); // the race is still open to TUI
    }
  });

  it("web cancel declines and rejects the turn", async () => {
    const remote = new FakeRemote();
    const { port, request } = rig({ remote });
    const pending = port.request(request);
    expect(remote.deliver({ kind: "cancel", origin: "user@127.0.0.1", originKind: "loopback" })).toBe(true);
    expect(await pending).toMatchObject({ approved: false, code: "E_HUB_DECLINED" });
  });

  it("binding recheck: a turn invalidated mid-dialog rejects the web answer (callback false)", async () => {
    const remote = new FakeRemote();
    const select = new FakeSelect();
    const { port, request, tracker } = rig({ select: select.select, remote });
    const pending = port.request(request);
    tracker.invalidate("input"); // new input ⇒ old turn dead
    expect(remote.deliver({ kind: "answer", answers: { SESSION: AFFIRM }, origin: "u@l", originKind: "lan" })).toBe(
      false,
    );
    select.answer(AFFIRM); // TUI affirm under a dead turn also cannot mint
    const result = await pending;
    expect(result.approved).toBe(false);
  });
});

describe("rate gates and teardown", () => {
  it("a second concurrent request while one is pending ⇒ E_HUB_RATE", async () => {
    const select = new FakeSelect();
    const { port, request } = rig({ select: select.select });
    const first = port.request(request);
    const second = await port.request(request);
    expect(second).toMatchObject({
      approved: false,
      code: "E_HUB_RATE",
      message: "上一个批准请求仍在进行中；请等它结算（批准 / 拒绝 / 超时）后再重试。",
    });
    select.answer(REJECT_LABEL);
    await first;
  });

  it("the 4th dialog in one turn ⇒ E_HUB_RATE (max 3)", async () => {
    const select = new FakeSelect();
    const { port, request } = rig({ select: select.select });
    for (let i = 0; i < 3; i++) {
      const pending = port.request(request);
      select.answer(AFFIRM); // approved does not mark the turn rejected
      expect((await pending).approved).toBe(true);
    }
    const fourth = await port.request(request);
    expect(fourth).toMatchObject({
      approved: false,
      code: "E_HUB_RATE",
      message: "本回合批准请求次数已达上限，因此不能继续请求；请等待用户的新消息后再按需重试。",
    });
  });

  it("revoke/dispose clear the turn and every minted cap", async () => {
    const select = new FakeSelect();
    const { port, request, registry, tracker } = rig({ select: select.select });
    const pending = port.request(request);
    select.answer(AFFIRM);
    const result = await pending;
    expect(result.approved).toBe(true);
    port.revoke();
    expect(tracker.current()).toBeUndefined();
    if (result.approved) expect(registry.stateOf(result.cap)).toBe("revoked");
  });
});
