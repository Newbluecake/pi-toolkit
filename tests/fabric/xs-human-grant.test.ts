import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHumanGrantHost,
  createHumanGrantPort,
  HUMAN_GRANT_CAP,
  HUMAN_GRANT_TTL_MS,
  noteHumanWebDispatch,
  takeHumanWebDispatch,
  revokeHumanWebDispatch,
  type InvocationRef,
} from "../../src/fabric/xs/human-grant.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:xs-human-web-inputs")];
});
const call = (id = "c1", runKey = "root-run", owner = "host"): InvocationRef => ({
  sessionId: "s1",
  runKey,
  contextSeq: 1,
  toolCallId: id,
  toolName: "message_session",
  owner,
});
function grant() {
  const port = createHumanGrantPort();
  const ref = port.issue({ inputId: "i1", sessionId: "s1", via: "interactive", issuedAt: Date.now(), owner: "host" })!;
  expect(port.bindContext(ref, "root-run", 1)).toBe(true);
  port.registerInvocation(call());
  return { port, ref };
}
describe("P2 host grant CAS and lifetime", () => {
  it("only a registered exact call resolves, including owner/context/tool/session", () => {
    const { port, ref } = grant();
    expect(port.resolve(call())).toEqual(ref);
    for (const wrong of [
      { owner: "reload" },
      { contextSeq: 2 },
      { toolName: "Agent" },
      { toolCallId: "fake" },
      { sessionId: "s2" },
      { runKey: "auto" },
    ])
      expect(port.resolve({ ...call(), ...wrong })).toBeUndefined();
  });
  it("parallel calls share exactly one reservation; consumed unknown cannot re-enter", () => {
    const { port, ref } = grant();
    port.registerInvocation(call("c2"));
    const first = port.reserve(ref, call(), "target");
    expect(first).toBeDefined();
    expect(port.reserve(ref, call("c2"), "other")).toBeUndefined();
    port.commit(first!);
    expect(port.reserve(ref, call(), "target")).toBeUndefined();
  });
  it("none release only permits the original call AND target; explicit commit is before send", () => {
    const { port, ref } = grant();
    const first = port.reserve(ref, call(), "target")!;
    port.commit(first);
    port.releaseNone(first);
    expect(port.reserve(ref, call(), "different")).toBeUndefined();
    port.registerInvocation(call("c2"));
    expect(port.reserve(ref, call("c2"), "target")).toBeUndefined();
    expect(port.reserve(ref, call(), "target")).toEqual(first);
  });
  it("forged claim cannot release a different reservation", () => {
    const { port, ref } = grant();
    const first = port.reserve(ref, call(), "target")!;
    port.commit(first);
    port.releaseNone({ ...first, targetSessionId: "other" });
    expect(port.reserve(ref, call(), "target")).toBeUndefined();
  });
  it("cap refuses live eviction, lazy TTL frees slots, expired refs never bind", () => {
    const port = createHumanGrantPort();
    const refs = Array.from({ length: HUMAN_GRANT_CAP }, (_, n) =>
      port.issue({ inputId: `i${n}`, sessionId: "s1", owner: "h", via: "rpc", issuedAt: Date.now() }),
    );
    expect(refs.every(Boolean)).toBe(true);
    expect(
      port.issue({ inputId: "overflow", sessionId: "s1", owner: "h", via: "rpc", issuedAt: Date.now() }),
    ).toBeUndefined();
    vi.advanceTimersByTime(HUMAN_GRANT_TTL_MS);
    expect(port.bindContext(refs[0]!, "r", 1)).toBe(false);
    expect(port.issue({ inputId: "new", sessionId: "s1", owner: "h", via: "rpc", issuedAt: Date.now() })).toBeDefined();
  });
  it("real admitted spawn edge AND exact Agent result are both required, nested shares same ref", () => {
    const { port, ref } = grant();
    const parent = { ...call("spawn"), toolName: "Agent" };
    port.registerInvocation(parent);
    port.linkInvocation(parent, "child");
    expect(port.bindContext(ref, "child", 1)).toBe(false);
    port.observeSpawnEdge("s1", "root", "child");
    port.linkInvocation(parent, "child");
    expect(port.bindContext(ref, "child", 1)).toBe(true);
    const child = { ...call("nested", "child"), toolName: "Agent" };
    port.registerInvocation(child);
    port.observeSpawnEdge("s1", "child", "nested-child");
    port.linkInvocation(child, "nested-child");
    expect(port.bindContext(ref, "nested-child", 1)).toBe(true);
    port.registerInvocation(call("send", "nested-child"));
    expect(port.resolve(call("send", "nested-child"))).toEqual(ref);
    expect(port.reserve(ref, call("send", "nested-child"), "target")).toBeDefined();
    expect(port.reserve(ref, call(), "target")).toBeUndefined();
  });
  it("end of root does not authorize automatic continuation; revoke removes child lineage", () => {
    const { port, ref } = grant();
    port.endRun("s1", "root-run");
    expect(port.resolve(call())).toBeUndefined();
    expect(port.bindContext(ref, "automatic", 1)).toBe(false);
    port.revokeSession("s1");
    expect(port.bindContext(ref, "root-run", 1)).toBe(false);
  });
});

describe("P2 input → actual user context → precise host tool call", () => {
  it.each(["interactive", "rpc"])(
    "%s input is not authority until its actual user message appears in context",
    (source) => {
      const port = createHumanGrantPort();
      const host = createHumanGrantHost(port, "host");
      const user = { role: "user", content: "please send", timestamp: 1 };
      host.input({ source, text: "please send" }, "s1");
      host.context({ messages: [] }, "s1");
      host.toolCall("old", "message_session", "s1");
      expect(port.resolve(host.invocation("old", "message_session")!)).toBeUndefined();
      host.message(user, "s1");
      host.context({ messages: [user] }, "s1");
      host.toolCall("new", "message_session", "s1");
      expect(port.resolve(host.invocation("new", "message_session")!)).toBeDefined();
      expect(port.resolve(host.invocation("old", "message_session")!)).toBeUndefined();
      host.end("s1");
      host.context({ messages: [user] }, "s1");
      host.toolCall("auto", "message_session", "s1");
      expect(port.resolve(host.invocation("auto", "message_session")!)).toBeUndefined();
    },
  );
  it("busy queued human input cannot upgrade old assistant calls", () => {
    const port = createHumanGrantPort();
    const host = createHumanGrantHost(port, "h");
    host.context({ messages: [{ role: "user", content: "automatic" }] }, "s1");
    host.input({ source: "rpc", text: "new request" }, "s1");
    host.toolCall("running", "message_session", "s1");
    expect(port.resolve(host.invocation("running", "message_session")!)).toBeUndefined();
  });
  it("copied text or model source is not context identity; extension notifications never issue", () => {
    const port = createHumanGrantPort();
    const host = createHumanGrantHost(port, "h");
    const user = { role: "user", content: "human", timestamp: 2 };
    host.input({ source: "interactive", text: "human" }, "s1");
    host.message(user, "s1");
    host.context({ messages: [{ ...user, source: "human" }] }, "s1");
    host.toolCall("fake", "message_session", "s1");
    expect(port.resolve(host.invocation("fake", "message_session")!)).toBeUndefined();
    host.input({ source: "extension", text: "notification" }, "s1");
    const notification = { role: "user", content: "notification" };
    host.message(notification, "s1");
    host.context({ messages: [notification] }, "s1");
    host.toolCall("notify", "message_session", "s1");
    expect(port.resolve(host.invocation("notify", "message_session")!)).toBeUndefined();
  });
  it("web proof is scoped, unique, once-only; wrong session/owner disposal/ambiguity refuse", () => {
    const proof = { inputId: "cmd", sessionId: "s1", owner: "web-owner", text: "ask", at: Date.now() };
    noteHumanWebDispatch(proof);
    expect(takeHumanWebDispatch("s2", "ask")).toBeUndefined();
    expect(takeHumanWebDispatch("s1", "ask")).toMatchObject({ inputId: "cmd", owner: "web-owner" });
    expect(takeHumanWebDispatch("s1", "ask")).toBeUndefined();
    noteHumanWebDispatch({ ...proof, inputId: "a" });
    noteHumanWebDispatch({ ...proof, inputId: "b", owner: "other" });
    expect(takeHumanWebDispatch("s1", "ask")).toBeUndefined();
    expect(takeHumanWebDispatch("s1", "ask")).toBeUndefined();
    noteHumanWebDispatch({ ...proof, inputId: "disposed" });
    revokeHumanWebDispatch("web-owner");
    expect(takeHumanWebDispatch("s1", "ask")).toBeUndefined();
  });
  it("authorized web input binds once; topic-switch replay does not receive a new grant", () => {
    const port = createHumanGrantPort();
    const host = createHumanGrantHost(port, "h");
    noteHumanWebDispatch({ inputId: "cmd", sessionId: "s1", owner: "web", text: "ask", at: Date.now() });
    const user = { role: "user", content: "ask" };
    host.input({ source: "extension", text: "ask" }, "s1");
    host.message(user, "s1");
    host.context({ messages: [user] }, "s1");
    host.toolCall("first", "message_session", "s1");
    expect(port.resolve(host.invocation("first", "message_session")!)).toBeDefined();
    host.end("s1");
    host.input({ source: "extension", text: "ask" }, "s1");
    host.message(user, "s1");
    host.context({ messages: [user] }, "s1");
    host.toolCall("replay", "message_session", "s1");
    expect(port.resolve(host.invocation("replay", "message_session")!)).toBeUndefined();
  });
});

describe("P2 handled input does not leave a reusable root authorization", () => {
  it("many direct mentions do not exhaust the grant park or authorize later same-text context", () => {
    const port = createHumanGrantPort();
    const host = createHumanGrantHost(port, "host");
    for (let n = 0; n < HUMAN_GRANT_CAP + 10; n++) {
      host.input({ source: "rpc", text: "@session:peer body" }, "s1");
      host.handled("@session:peer body", "s1");
    }
    const old = { role: "user", content: "@session:peer body" };
    host.message(old, "s1");
    host.context({ messages: [old] }, "s1");
    host.toolCall("unproven", "message_session", "s1");
    expect(port.resolve(host.invocation("unproven", "message_session")!)).toBeUndefined();
    const user = { role: "user", content: "new delegation" };
    host.input({ source: "rpc", text: "new delegation" }, "s1");
    host.message(user, "s1");
    host.context({ messages: [user] }, "s1");
    host.toolCall("proven", "message_session", "s1");
    expect(port.resolve(host.invocation("proven", "message_session")!)).toBeDefined();
  });
});
