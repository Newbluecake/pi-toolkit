import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import {
  XsMembership,
  stashXsMembershipHandoff,
  takeXsMembershipHandoff,
  type XsMembershipEntryData,
} from "../../src/fabric/xs/membership.js";

/**
 * /new channel-membership handoff (docs/dev/fabric-cross-session/new-session-channels-fix.md):
 * `/new` (and the web 「清空」 twin) replaces the session with a fresh sessionId in the SAME
 * process; the outgoing stack's explicit membership state (channel pref, receive pref,
 * blocklist, joinedAt) rides a consume-once process slot into the new stack, which adopts and
 * re-persists it under the NEW sessionId. fork semantics (P10) are untouched: `restore` still
 * ignores a mismatched-sessionId entry, and no handoff is stashed for a fork shutdown.
 */

const OLD_SID = "sess-old-000011112222";
const NEW_SID = "sess-new-333344445555";

function joinedOld(): { old: XsMembership; persisted: XsMembershipEntryData[] } {
  const persisted: XsMembershipEntryData[] = [];
  const old = new XsMembership({
    sessionId: OLD_SID,
    clock: new FakeClock(1_000),
    persist: (d) => persisted.push(d),
  });
  old.attach();
  old.join(["team"]);
  old.setReceive("deliver");
  old.block("sess-blocked-0001", "old-friend");
  return { old, persisted };
}

describe("XsMembership /new handoff", () => {
  it("handoffSnapshot is undefined for a pristine (never explicit) membership", () => {
    const m = new XsMembership({ sessionId: OLD_SID, persist: () => {} });
    m.attach();
    expect(m.handoffSnapshot()).toBeUndefined();
  });

  it("handoffSnapshot is undefined after a fork-style ignored restore (mismatched sessionId)", () => {
    const { old } = joinedOld();
    const entry = old.toEntryData();
    const fork = new XsMembership({ sessionId: NEW_SID, persist: () => {} });
    fork.attach();
    fork.restore(entry); // P10: ignored
    expect(fork.handoffSnapshot()).toBeUndefined();
  });

  it("adopt carries pref/receive/blocklist/joinedAt and re-persists under the NEW sessionId", () => {
    const { old } = joinedOld();
    const shot = old.handoffSnapshot();
    expect(shot).toBeDefined();
    expect(shot!.sessionId).toBe(OLD_SID);
    expect(shot!.channels).toEqual(["team"]);

    const persisted: XsMembershipEntryData[] = [];
    const next = new XsMembership({
      sessionId: NEW_SID,
      clock: new FakeClock(2_000),
      persist: (d) => persisted.push(d),
    });
    next.attach();
    next.restore(undefined); // the /new branch carries no entry
    next.adopt(shot!);
    expect(next.pref()).toEqual(["team"]);
    expect(next.effective()).toEqual(["team"]);
    expect(next.receive).toBe("deliver");
    expect(next.blockedSnapshot()).toEqual([{ sessionId: "sess-blocked-0001", nameSnapshot: "old-friend", at: 1_000 }]);
    expect(next.joinedAtAgo(5_000)).toBe(4_000); // original joinedAt kept
    // Adopted state is flushed under the NEW sessionId so a later /reload restores it. §2.4 write
    // rule: a named-only pref serializes as `joined:false` + `channels` (an old plugin fails closed).
    expect(persisted.at(-1)).toMatchObject({ sessionId: NEW_SID, joined: false, channels: ["team"] });
    // …and the adopted membership is itself explicit (a further /new chains the handoff).
    expect(next.handoffSnapshot()).toBeDefined();
  });

  it("an explicit leave is explicit state too: the handoff suppresses autoJoin downstream", () => {
    const persisted: XsMembershipEntryData[] = [];
    const old = new XsMembership({ sessionId: OLD_SID, persist: (d) => persisted.push(d) });
    old.attach();
    old.join();
    old.leave(); // explicit not-joined
    const shot = old.handoffSnapshot();
    expect(shot).toBeDefined();
    expect(shot!.joined).toBe(false);
    expect(shot!.channels).toBeUndefined();

    const next = new XsMembership({ sessionId: NEW_SID, persist: () => {} });
    next.attach();
    next.restore(undefined);
    next.adopt(shot!);
    expect(next.joined).toBe(false);
    expect(next.pref()).toEqual([]);
  });

  it("the process slot is consume-once and never stashes a pristine snapshot", () => {
    takeXsMembershipHandoff(); // drain any leftover from another test file in this process
    const pristine = new XsMembership({ sessionId: OLD_SID, persist: () => {} });
    pristine.attach();
    expect(pristine.handoffSnapshot()).toBeUndefined();

    const { old } = joinedOld();
    stashXsMembershipHandoff(old.handoffSnapshot()!);
    expect(takeXsMembershipHandoff()?.sessionId).toBe(OLD_SID);
    expect(takeXsMembershipHandoff()).toBeUndefined(); // consumed
  });
});
