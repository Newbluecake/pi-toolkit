import { afterEach, describe, expect, it } from "vitest";
import { XsHarness, joinedPair, list, until, type Peer } from "./helpers/fabric-xs-harness.js";

/**
 * MW: reply-plan §12.2 item 10 — `@session` addressing on real hub child × real activate-built
 * stacks × real sockets. The TUI path drives the registered `input` handlers; the web path drives
 * the hub's `cmd{op:"prompt"}` into the agent's command handler (both share MentionRouteDeps).
 */
let h: XsHarness;
afterEach(async () => {
  await h?.close();
}, 20_000);

const mention = (peer: Peer, text: string): Promise<Array<{ action: string } | null>> => peer.rpc("mention", { text });
const complete = (peer: Peer, text: string) =>
  peer.rpc<{ items: Array<{ value: string; description?: string }> } | null>("complete", { text });
const answer = (b: Peer, to: string, text: string, q: string) =>
  b.rpc("tool", { name: "message_session", params: { to, text, replyTo: q } });
const wasHandled = (results: Array<{ action: string } | null>) => results.some((r) => r?.action === "handled");
const sessionNotices = (state: any) =>
  state.mentionNotices.filter((n: any) => n.customType === "subagent:mention-session");
const errorNotices = (state: any) => state.mentionNotices.filter((n: any) => n.customType === "subagent:mention-error");

describe("MW @session mention wiring (real hub × real stacks)", () => {
  it("TUI explicit form: B gets a reply_to wake at level 0; B's reply wakes A when A receives in wake mode (RX7 R4 revision)", async () => {
    h = new XsHarness();
    const { hub, a, b, aid, bid } = await joinedPair(h);
    await a.rpc("prime");
    await b.rpc("prime");
    const turnsBefore = (await a.rpc("inspect")).turns;

    const results = await mention(a, `@session:${bid.slice(0, 8)} please answer`);
    expect(wasHandled(results)).toBe(true);

    const request = (await b.rpc("inspect")).messages.at(-1);
    expect(request).toMatchObject({ triggerTurn: true, details: { xsWake: true } });
    expect(request.content).toContain("please answer");
    expect(request.content).toContain("reply_to");
    const frame = (await hub.rpc("inspect")).deliveries.at(-1).frame;
    expect(frame.level).toBe(0); // human origin ⇒ causal level 0, never the requester's own level
    expect(frame.reply?.requestId).toMatch(/^q/);
    const q: string = frame.reply.requestId;
    expect(request.content).toContain(q);

    // §9.6 success notice: display-only, never a turn
    const sent = sessionNotices(await a.rpc("inspect"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ display: true, triggerTurn: false, details: { source: "mention-session" } });
    expect(sent[0].content).toContain(q);

    await b.rpc("settle");
    expect(await answer(b, aid, "forty-two", q)).toMatchObject({ effect: "applied", replyTo: { accepted: true } });
    const state = await a.rpc("inspect");
    const shown = state.messages.at(-1);
    expect(shown.content).toContain("forty-two");
    // RX7 R4 revision (reply-plan §10.2): a human-origin reply is a solicited reply — A (wake) is woken, at level 0.
    expect(shown).toMatchObject({ triggerTurn: true, display: true, details: { inReplyTo: q } });
    expect(state.turns).toBe(turnsBefore + 1);
    expect(state.replyTickets.find((t: any) => t.requestId === q)).toMatchObject({
      origin: "human",
      wakeOnReply: true,
      state: "replied",
    });
  }, 40_000);

  it("RX7 R4: a human-origin reply to a deliver-mode A is shown (display:true) but never wakes A", async () => {
    h = new XsHarness();
    const hub = await h.boot("hub");
    const [a, b] = await Promise.all([
      h.boot("agent", "alpha", undefined, true, false, { XW_RECEIVE: "deliver" }),
      h.boot("agent", "beta"),
    ]);
    await Promise.all([a.rpc("cmd", { args: "join" }), b.rpc("cmd", { args: "join" })]);
    const aid: string = (await a.rpc("inspect")).sessionId;
    const bid: string = (await b.rpc("inspect")).sessionId;
    await until(
      () => list(a),
      (l) => l.rows?.some((r: any) => bid.startsWith(r.ref)),
      "membership publish",
    );
    void hub;
    await a.rpc("prime");
    await b.rpc("prime");
    const turnsBefore = (await a.rpc("inspect")).turns;
    expect(wasHandled(await mention(a, `@session:${bid.slice(0, 8)} please answer`))).toBe(true);
    const q: string = (await b.rpc("inspect")).messages.at(-1).content.match(/reply_to="(q[^"]+)"/)[1];
    await b.rpc("settle");
    expect(await answer(b, aid, "quiet-answer", q)).toMatchObject({ effect: "applied" });
    const state = await a.rpc("inspect");
    expect(state.messages.at(-1)).toMatchObject({ triggerTurn: false, display: true, details: { inReplyTo: q } });
    expect(state.messages.at(-1).content).toContain("quiet-answer");
    expect(state.turns).toBe(turnsBefore);
  }, 40_000);

  it("web composer path: `@session:<ref> msg` is routed (never reaches the native prompt) with the same semantics", async () => {
    h = new XsHarness();
    const { hub, a, b, aid, bid } = await joinedPair(h);
    await a.rpc("prime");
    await b.rpc("prime");
    const turnsBefore = (await a.rpc("inspect")).turns;

    const result = await hub.rpc("webPrompt", { sessionId: aid, text: `@session:${bid.slice(0, 8)} via web` });
    expect(result).toMatchObject({
      ok: true,
      data: { op: "prompt", delivery: "observed", mention: { action: "session", effect: "applied" } },
    });
    const q: string = result.data.mention.requestId;
    expect(q).toMatch(/^q/);
    expect((await a.rpc("inspect")).userMessages).toEqual([]); // not forwarded to the model
    const request = (await b.rpc("inspect")).messages.at(-1);
    expect(request.content).toContain("via web");
    expect(request.content).toContain(q);
    expect((await hub.rpc("inspect")).deliveries.at(-1).frame.level).toBe(0);

    await b.rpc("settle");
    await answer(b, aid, "web answer", q);
    const state = await a.rpc("inspect");
    expect(state.messages.at(-1)).toMatchObject({ triggerTurn: true, display: true }); // RX7 R4: A (wake) is woken
    expect(state.messages.at(-1).content).toContain("web answer");
    expect(state.turns).toBe(turnsBefore + 1);
  }, 40_000);

  it("bare `@name msg`: a unique cache hit routes (cache warmed by completion); completion inserts the bare name", async () => {
    h = new XsHarness();
    const hub = await h.boot("hub");
    const [a, b] = await Promise.all([
      h.boot("agent", "alpha", undefined, true, false, { XW_UI: "1", XW_SESSION_NAME: "1" }),
      h.boot("agent", "beta", undefined, true, false, { XW_SESSION_NAME: "1" }),
    ]);
    await Promise.all([a.rpc("cmd", { args: "join" }), b.rpc("cmd", { args: "join" })]);
    const bid: string = (await b.rpc("inspect")).sessionId;
    await until(
      () => list(a),
      (l) => l.rows?.some((r: any) => bid.startsWith(r.ref)),
      "membership publish",
    ); // the directory refresh is throttled (30s): never let its first fetch see an empty hub
    await until(
      async () => (await complete(a, "@be"))?.items?.length ?? 0,
      (n) => n > 0,
      "directory warm",
    );
    expect(hub).toBeDefined();
    const items = (await complete(a, "@be"))?.items ?? [];
    expect(items.map((i) => i.value)).toContain("@beta");
    const row = items.find((i) => i.value === "@beta");
    expect(row?.description).toMatch(/^session · /);
    await until(
      async () => wasHandled(await mention(a, "@beta hello bare")),
      (ok) => ok,
      "bare name routes once the cache is warm",
    );
    expect((await b.rpc("inspect")).messages.at(-1).content).toContain("hello bare");
    expect(bid.length).toBeGreaterThan(0);
  }, 40_000);

  it("a cwd file with the same name wins over a session: bare form passes through, completion inserts the explicit ref", async () => {
    h = new XsHarness();
    const hub = await h.boot("hub");
    // cwd is the repo root, where `src` is a real directory
    const [a, c] = await Promise.all([
      h.boot("agent", "alpha", undefined, true, false, { XW_UI: "1" }),
      h.boot("agent", "src", undefined, true, false, { XW_SESSION_NAME: "1" }),
    ]);
    await Promise.all([a.rpc("cmd", { args: "join" }), c.rpc("cmd", { args: "join" })]);
    const cid = (await c.rpc("inspect")).sessionId;
    await until(
      () => list(a),
      (l) => l.rows?.some((r: any) => cid.startsWith(r.ref)),
      "membership publish",
    );
    const items = await until(
      async () => (await complete(a, "@"))?.items ?? [],
      (list) => list.some((i) => i.value.startsWith("@session:") && cid.startsWith(i.value.slice("@session:".length))),
      "completion lists the file-conflicting session by explicit ref",
    );
    expect(items.map((i) => i.value)).not.toContain("@src");
    expect(wasHandled(await mention(a, "@src hello"))).toBe(false);
    expect((await c.rpc("inspect")).messages).toEqual([]);
    expect(hub).toBeDefined();
  }, 40_000);

  it("off states: not joined / left ⇒ every `@` passes through (TUI + web)", async () => {
    h = new XsHarness();
    const { hub, a, b, aid, bid } = await joinedPair(h);
    await a.rpc("cmd", { args: "leave" });
    const text = `@session:${bid.slice(0, 8)} nobody home`;
    const tui = await mention(a, text);
    expect(wasHandled(tui)).toBe(false);
    const web = await hub.rpc("webPrompt", { sessionId: aid, text });
    expect(web.data?.mention).toBeUndefined();
    const state = await a.rpc("inspect");
    expect(state.mentionNotices).toEqual([]);
    expect(state.userMessages).toEqual([text]); // web fell through to the native prompt path
    expect((await b.rpc("inspect")).messages).toEqual([]);
  }, 40_000);

  it("xs off: the port is never injected — `@session:` is released verbatim", async () => {
    h = new XsHarness();
    await h.boot("hub");
    const a = await h.boot("agent", "solo", undefined, false);
    const results = await mention(a, "@session:abcd1234 hi");
    expect(wasHandled(results)).toBe(false);
    expect((await a.rpc("inspect")).mentionNotices).toEqual([]);
  }, 40_000);

  it("errors surface as subagent:mention-error{source:mention-session}, display-only", async () => {
    h = new XsHarness();
    const { a } = await joinedPair(h);
    const results = await mention(a, "@session:nosuchsession hello");
    expect(wasHandled(results)).toBe(true); // explicit form is always intercepted
    const errors = errorNotices(await a.rpc("inspect"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ display: true, triggerTurn: false, details: { source: "mention-session" } });
    expect(errors[0].content).toContain("找不到会话");
  }, 40_000);
  it("a subagent label wins over a same-named session (cache warm, session unique): routed to the subagent, B untouched", async () => {
    h = new XsHarness();
    await h.boot("hub");
    const [a, b] = await Promise.all([
      h.boot("agent", "alpha", undefined, true, false, { XW_UI: "1", XW_SESSION_NAME: "1" }),
      h.boot("agent", "beta", undefined, true, false, { XW_SESSION_NAME: "1" }),
    ]);
    await Promise.all([a.rpc("cmd", { args: "join" }), b.rpc("cmd", { args: "join" })]);
    const bid: string = (await b.rpc("inspect")).sessionId;
    await until(
      () => list(a),
      (l) => l.rows?.some((r: any) => bid.startsWith(r.ref)),
      "membership publish",
    );
    await until(
      async () => ((await complete(a, "@")) as any)?.items?.some((i: any) => i.value === "@beta") ?? false,
      (ok) => ok,
      "directory warm (bare @beta is session-routable)",
    );
    // register a real subagent run labelled `beta` on A (fake driver: the run itself is irrelevant)
    const run = await a.rpc("tool", {
      name: "Agent",
      params: { prompt: "x", description: "beta", subagent_type: "general-purpose" },
    });
    expect(run.label).toBe("beta");
    const results = await mention(a, "@beta hello subagent");
    expect(wasHandled(results)).toBe(true); // routed (steer/resume/error) by the SUBAGENT branch
    const state = await a.rpc("inspect");
    expect(sessionNotices(state)).toEqual([]); // never the @session branch
    expect(errorNotices(state).every((n: any) => n.details?.source !== "mention-session")).toBe(true);
    expect((await b.rpc("inspect")).messages).toEqual([]);
  }, 40_000);
});
