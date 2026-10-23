/**
 * LAN security r2 §5.7 (package E): the Feishu login-approval port.
 *
 * Pins the §13 fence: a `request` that times out at 5s never issues nonces even when the late
 * sendCard settles (the card is patched 「已失效」); decisions arriving after cancel/close are
 * void; a successful decision consumes the sibling nonce and calls the core exactly once with
 * the challenge gen; dispose clears every entry; the per-IP/global card caps are enforced.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoginApprovalPort } from "../../../../src/web-hub/hub/feishu/security.js";
import { loginApprovalCard } from "../../../../src/web-hub/hub/feishu/service.js";
import { createFeishuState, type FeishuState } from "../../../../src/web-hub/hub/feishu/state.js";
import { systemFeishuClock } from "../../../../src/web-hub/hub/feishu/http.js";
import { createFakeClock, settle, type FakeClock } from "../../../fixtures/feishu/fake-http.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function makeState(clock: FakeClock): Promise<FeishuState> {
  const dir = await mkdtemp(join(tmpdir(), "lan-approval-"));
  const state = createFeishuState({ dir, groupCommitMs: 0, clock: { ...systemFeishuClock, now: clock.now } });
  await state.load();
  await state.adoptInstall({ appId: "cli_test", ownerOpenId: "ou_owner" });
  await state.commit();
  cleanups.push(async () => {
    state.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  return state;
}

interface Rig {
  clock: FakeClock;
  state: FeishuState;
  sendCard: ReturnType<typeof vi.fn>;
  patchCard: ReturnType<typeof vi.fn>;
  onDecision: ReturnType<typeof vi.fn>;
  port: ReturnType<typeof createLoginApprovalPort>;
}

async function makeRig(opts: { sendCard?: (...args: unknown[]) => unknown } = {}): Promise<Rig> {
  const clock = createFakeClock(0);
  const state = await makeState(clock);
  let msgSeq = 0;
  const sendCard = vi.fn(async () => ({ chatId: "chat", messageId: `msg-${++msgSeq}` }));
  const patchCard = vi.fn(async () => {});
  const onDecision = vi.fn();
  const work = { run: (task: () => Promise<unknown>) => (void task(), true) };
  const port = createLoginApprovalPort({
    state,
    clock,
    work,
    installation: () => ({ gen: 1, ownerOpenId: "ou_owner", tenantKey: "tenant" }),
    sendCard: opts.sendCard ?? sendCard,
    patchCard,
    onDecision,
  });
  return { clock, state, sendCard, patchCard, onDecision, port };
}

const req = (
  clock: FakeClock,
  over: Partial<Parameters<ReturnType<typeof createLoginApprovalPort>["request"]>[0]> = {},
) => ({
  challengeId: "c1",
  gen: 1,
  ip: "1.2.3.4",
  device: "Chrome",
  user: "alice",
  expiresAt: clock.now() + 120_000,
  ...over,
});

describe("Feishu login approval (§5.7)", () => {
  it("a request that misses the 5s fence issues no nonces; the late card is patched expired", async () => {
    let resolveSend: ((v: { chatId: string; messageId: string } | undefined) => void) | undefined;
    const sendCard = vi.fn(
      () =>
        new Promise<{ chatId: string; messageId: string } | undefined>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const { clock, state, patchCard, port } = await makeRig({ sendCard });
    const result = port.request(req(clock));
    clock.advance(5_000); // the logical 5s fence fires
    await expect(result).resolves.toBe("unavailable");
    // The real sendCard settles late: closed ⇒ no nonces, card patched 「已失效」.
    resolveSend!({ chatId: "chat", messageId: "msg-late" });
    await settle();
    expect(state.nonces.size).toBe(0);
    expect(patchCard).toHaveBeenCalledWith("msg-late", "expired", undefined);
  });

  it("a commit that lands after the 5s fence redeems both nonces and patches expired (never pending)", async () => {
    const { clock, state, patchCard } = await makeRig();
    // Wrap the real state with a controllable slow commit; nonce issue/redeem stay in-memory.
    let resolveCommit: ((v: boolean) => void) | undefined;
    const slowCommit = (): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        resolveCommit = resolve;
      });
    const slowState: FeishuState = { ...state, commit: slowCommit };
    const work = { run: (task: () => Promise<unknown>) => (void task(), true) };
    const port = createLoginApprovalPort({
      state: slowState,
      clock,
      work,
      installation: () => ({ gen: 1, ownerOpenId: "ou_owner", tenantKey: "tenant" }),
      sendCard: vi.fn(async () => ({ chatId: "chat", messageId: "msg-slow" })),
      patchCard,
      onDecision: vi.fn(),
    });
    const result = port.request(req(clock));
    await settle();
    expect(slowState.nonces.size).toBe(2); // both nonces issued before commit settled
    clock.advance(5_000); // the logical 5s fence fires
    await expect(result).resolves.toBe("unavailable");
    resolveCommit!(true); // the slow commit finally lands
    await settle();
    expect(slowState.nonces.size).toBe(0); // both nonces redeemed
    expect(patchCard).toHaveBeenCalledWith("msg-slow", "expired", undefined);
    expect(patchCard).not.toHaveBeenCalledWith("msg-slow", "pending", expect.anything());
  });

  it("an unavailable installation returns unavailable without a card", async () => {
    const { clock, sendCard, port } = await makeRig();
    // no installation
    const noInstall = createLoginApprovalPort({
      state: {} as never,
      clock,
      work: { run: () => true },
      installation: () => undefined,
      sendCard,
      patchCard: vi.fn(),
      onDecision: vi.fn(),
    });
    await expect(noInstall.request(req(clock))).resolves.toBe("unavailable");
    expect(sendCard).not.toHaveBeenCalled();
  });

  it("renders deny and approve as visually distinct, side-by-side buttons (deny first)", () => {
    const json = loginApprovalCard({ user: "alice", ip: "1.2.3.4", device: "Chrome" }, "pending", {
      approve: "n-approve",
      deny: "n-deny",
    });
    const card = JSON.parse(json) as { body: { elements: Array<Record<string, unknown>> } };
    const row = card.body.elements.find((e) => e["tag"] === "column_set") as
      | { columns: Array<{ elements: Array<{ type: string; text: { content: string }; behaviors: unknown }> }> }
      | undefined;
    expect(row).toBeDefined();
    const buttons = row!.columns.map((c) => c.elements[0]!);
    expect(buttons.map((b) => b.type)).toEqual(["danger_filled", "primary_filled"]);
    expect(buttons[0]!.text.content).toContain("拒绝");
    expect(buttons[1]!.text.content).toContain("批准");
    expect(JSON.stringify(buttons[0]!.behaviors)).toContain("n-deny");
    expect(JSON.stringify(buttons[1]!.behaviors)).toContain("n-approve");
    // no bare top-level buttons left behind; settled cards carry no buttons at all
    expect(card.body.elements.some((e) => e["tag"] === "button")).toBe(false);
    const settled = JSON.parse(loginApprovalCard({ user: "a", ip: "i", device: "d" }, "approved")) as {
      body: { elements: Array<Record<string, unknown>> };
    };
    expect(settled.body.elements.map((e) => e["tag"])).toEqual(["markdown"]);
  });

  it("issues both nonces and a successful decision consumes the sibling and notifies the core once", async () => {
    const { clock, state, onDecision, port } = await makeRig();
    await expect(port.request(req(clock))).resolves.toBe("sent");
    expect(state.nonces.size).toBe(2);
    const approve = state.nonces.list().find((n) => n.action === "login-approve")!;
    expect(state.nonces.list().find((n) => n.action === "login-deny")).toBeDefined();
    // inbound already redeemed the clicked nonce; E redeems the sibling and forwards.
    state.nonces.redeem({
      nonce: approve.nonce,
      operatorOpenId: "ou_owner",
      chatId: approve.chatId,
      messageId: approve.messageId,
      tenantKey: "tenant",
      installGen: 1,
    });
    port.onDecision({ challengeId: "c1", allowed: true, gen: 1, operatorOpenId: "ou_owner", installGen: 1 });
    expect(onDecision).toHaveBeenCalledWith("c1", true, 1);
    expect(state.nonces.size).toBe(0);
  });

  it("a decision after close is void (core never notified)", async () => {
    const { clock, onDecision, port } = await makeRig();
    await expect(port.request(req(clock))).resolves.toBe("sent");
    port.close("c1", "cancel");
    port.onDecision({ challengeId: "c1", allowed: true, gen: 1, operatorOpenId: "ou_owner", installGen: 1 });
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("a stale gen or a non-owner operator is ignored", async () => {
    const { clock, onDecision, port } = await makeRig();
    await expect(port.request(req(clock))).resolves.toBe("sent");
    port.onDecision({ challengeId: "c1", allowed: true, gen: 999, operatorOpenId: "ou_owner", installGen: 1 });
    port.onDecision({ challengeId: "c1", allowed: true, gen: 1, operatorOpenId: "ou_other", installGen: 1 });
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("enforces the per-IP card cap (≤3 per 10 min)", async () => {
    const { clock, port } = await makeRig();
    for (let i = 0; i < 3; i++)
      await expect(port.request(req(clock, { challengeId: `c${i}`, gen: i + 1 }))).resolves.toBe("sent");
    await expect(port.request(req(clock, { challengeId: "c9", gen: 9 }))).resolves.toBe("unavailable");
  });

  it("dispose clears every entry", async () => {
    const { clock, state, port } = await makeRig();
    await expect(port.request(req(clock))).resolves.toBe("sent");
    expect(state.nonces.size).toBe(2);
    port.dispose();
    expect(state.nonces.size).toBe(0);
  });
});
