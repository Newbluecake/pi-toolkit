import { describe, expect, it } from "vitest";
import {
  createSessionCommandRegistry,
  createSessionMemoryCommand,
  type SessionCommandGrant,
} from "../../../src/memory/scopes/session-command.js";
import { createSessionMemoryStore } from "../../../src/memory/scopes/session-store.js";
import { createSessionPoisonRegistry } from "../../../src/memory/scopes/session-poison.js";
import type { MemoryOwner, SessionMemoryWrite } from "../../../src/memory/scopes/types.js";

function fixture(child = false) {
  let trusted = true;
  let owner: MemoryOwner = { incarnation: {}, sid: "command-session", sessionEpoch: 1, branchGen: 1 };
  const branch: unknown[] = [];
  let attempts = 0;
  let throwAppend = false;
  let locked = false;
  let duringPlan = () => {};
  const registry = createSessionCommandRegistry(() => trusted);
  const store = createSessionMemoryStore({
    currentOwner: () => owner,
    getSessionId: () => owner.sid,
    getSessionFile: () => undefined,
    isLocked: () => locked,
    getBranch: () => branch,
    now: () => {
      duringPlan();
      return "2026-11-07T00:00:00.000Z";
    },
    appendCustomEntry(type, data) {
      attempts++;
      if (throwAppend) throw new Error("unknown");
      branch.push({ type: "custom", customType: type, id: `entry${attempts}`, data });
    },
    poisonRegistry: createSessionPoisonRegistry(),
    commandGrants: registry,
    isChildSession: child,
  });
  const command = createSessionMemoryCommand({ registry, currentOwner: () => owner, store });
  return {
    store,
    registry,
    command,
    owner: () => owner,
    attempts: () => attempts,
    setTrusted: (value: boolean) => {
      trusted = value;
    },
    setLocked: () => {
      locked = true;
    },
    setOwner: () => {
      owner = { ...owner, sessionEpoch: 2 };
    },
    failAppend: () => {
      throwAppend = true;
    },
    duringPlan: (fn: () => void) => {
      duringPlan = fn;
    },
  };
}
const operation: SessionMemoryWrite["operation"] = {
  storageScope: "session",
  op: "create",
  authority: "user",
  text: "typed exactly",
};

describe("host-private native command seam", () => {
  it("add uses original single-append core and command grant, not dialog cap", async () => {
    const h = fixture();
    expect(await h.command.add("typed exactly")).toMatchObject({ ok: true, id: "n1", persistence: "memory-only" });
    expect(h.attempts()).toBe(1);
    expect(h.store.view().items[0]?.item).toMatchObject({
      text: "typed exactly",
      authority: "user",
      grant: { via: "command" },
    });
    expect(h.store.view().items[0]?.item.grant).toEqual({ via: "command" });
  });
  it("disallowed command environment refused before issue and again immediately before commit", async () => {
    const h = fixture();
    h.setTrusted(false);
    expect(await h.command.add("x")).toMatchObject({ ok: false, code: "E_AUTHORITY" });
    h.setTrusted(true);
    h.duringPlan(() => h.setTrusted(false));
    expect(await h.command.add("x")).toMatchObject({ ok: false, code: "E_AUTHORITY" });
    expect(h.attempts()).toBe(0);
  });
  it("unknown, foreign, replayed or mismatched command handle refuses", async () => {
    const h = fixture();
    const grant = h.registry.issue(operation, h.owner())!;
    expect(await h.store.enqueueCommand({ operation, owner: h.owner() }, {} as SessionCommandGrant)).toMatchObject({
      ok: false,
      code: "E_AUTHORITY",
    });
    expect(
      await h.store.enqueueCommand({ operation: { ...operation, text: "substituted" }, owner: h.owner() }, grant),
    ).toMatchObject({ ok: false, code: "E_AUTHORITY" });
    expect(await h.store.enqueueCommand({ operation, owner: h.owner() }, grant)).toMatchObject({
      ok: false,
      code: "E_AUTHORITY",
    });
    const fresh = h.registry.issue(operation, h.owner())!;
    expect(await h.store.enqueueCommand({ operation, owner: h.owner() }, fresh)).toMatchObject({ ok: true });
    expect(await h.store.enqueueCommand({ operation, owner: h.owner() }, fresh)).toMatchObject({
      ok: false,
      code: "E_AUTHORITY",
    });
    expect(h.attempts()).toBe(1);
  });
  it("capacity/size, child, secure, owner and poison share original core", async () => {
    const h = fixture();
    expect(await h.command.add("x".repeat(1025))).toMatchObject({ ok: false, code: "E_TOO_LARGE" });
    expect(h.attempts()).toBe(0);
    h.setLocked();
    expect(await h.command.add("x")).toMatchObject({ ok: false, code: "E_WRITE_GATE" });
    const child = fixture(true);
    expect(await child.command.add("x")).toMatchObject({ ok: false, code: "E_CHILD_AUTHORITY" });
    expect(child.attempts()).toBe(0);
    const stale = fixture();
    stale.duringPlan(stale.setOwner);
    expect(await stale.command.add("x")).toMatchObject({ ok: false, code: "E_STALE_SESSION" });
    expect(stale.attempts()).toBe(0);
    const fail = fixture();
    fail.failAppend();
    expect(await fail.command.add("x")).toMatchObject({ ok: false, code: "E_PERSIST_UNKNOWN" });
    expect(await fail.command.add("x")).toMatchObject({ ok: false, code: "E_PERSIST_UNKNOWN" });
    expect(fail.attempts()).toBe(1);
  });
  it("full session refuses 49th command; no truncation or second writer", async () => {
    const h = fixture();
    for (let i = 0; i < 48; i++) expect(await h.command.add(`note${i}`)).toMatchObject({ ok: true });
    expect(await h.command.add("overflow")).toMatchObject({ ok: false, code: "E_FULL" });
    expect(h.attempts()).toBe(48);
    expect(h.store.view().items).toHaveLength(48);
  });
});
