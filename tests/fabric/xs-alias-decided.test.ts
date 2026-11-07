import { describe, expect, it } from "vitest";
import {
  XS_ALIAS_DECIDED_CUSTOM_TYPE,
  createXsAliasDecided,
  readXsAliasDecidedEntry,
  type XsAliasDecidedEntryData,
} from "../../src/fabric/xs/alias-decided.js";

const SID = "session-current-12345678";
const entry = (data: unknown) => ({ type: "custom", customType: XS_ALIAS_DECIDED_CUSTOM_TYPE, data });
const data = { v: 1 as const, sessionId: SID, at: 123, via: "set" as const };

describe("alias decided persistence (#72 AF4)", () => {
  it("uses the stable old runtime name; reads only valid matching sid entries", () => {
    expect(XS_ALIAS_DECIDED_CUSTOM_TYPE).toBe("subagent:xs-alias-decided");
    expect(readXsAliasDecidedEntry([entry(data)], SID)).toEqual(data);
    expect(readXsAliasDecidedEntry([entry(data)], "fork-new-12345678")).toBeUndefined();
    expect(readXsAliasDecidedEntry([], SID)).toBeUndefined();
  });

  it.each(["set", "clear", "take", "force", "inherit"] as const)("%s round-trips through append and restore", (via) => {
    const persisted: XsAliasDecidedEntryData[] = [];
    const port = createXsAliasDecided({
      sessionId: SID,
      entries: [],
      persist: (d) => persisted.push(d),
      now: () => 1000,
    });
    expect(port.decided()).toBe(false);
    port.markDecided(via);
    expect(port.decided()).toBe(true);
    expect(persisted).toEqual([{ v: 1, sessionId: SID, at: 1000, via }]);
    const restored = createXsAliasDecided({ sessionId: SID, entries: persisted.map(entry), persist: () => undefined });
    expect(restored.decided()).toBe(true);
    expect(
      createXsAliasDecided({
        sessionId: "fork-12345678",
        entries: persisted.map(entry),
        persist: () => undefined,
      }).decided(),
    ).toBe(false);
  });

  it("/tree cannot undo intent: matching entries outside the selected branch still count", () => {
    const allEntries = [entry(data), { type: "message" }, entry({ ...data, sessionId: "other", via: "clear" })];
    const selectedBranch = allEntries.slice(1);
    expect(readXsAliasDecidedEntry(selectedBranch, SID)).toBeUndefined();
    expect(readXsAliasDecidedEntry(allEntries, SID)).toEqual(data);
  });

  it("newer malformed/foreign entries never revoke an earlier valid decision", () => {
    const malformed = [
      null,
      undefined,
      [],
      5,
      "x",
      { ...data, v: 2 },
      { ...data, via: "auto" },
      { ...data, at: NaN },
      { ...data, at: Infinity },
      { ...data, at: -1 },
      { ...data, at: "1" },
      { ...data, sessionId: 7 },
    ];
    for (const d of malformed) {
      expect(readXsAliasDecidedEntry([entry(d)], SID)).toBeUndefined();
      expect(readXsAliasDecidedEntry([entry(data), entry(d)], SID)).toEqual(data);
    }
    expect(readXsAliasDecidedEntry([{ ...entry(data), type: "custom_message" }], SID)).toBeUndefined();
    expect(readXsAliasDecidedEntry([{ ...entry(data), customType: "subagent:xs-membership" }], SID)).toBeUndefined();
    expect(readXsAliasDecidedEntry([entry({ ...data, sessionId: "" })], "")).toBeUndefined();
    const latest = { ...data, via: "clear" as const, at: 10 };
    expect(readXsAliasDecidedEntry([entry(data), entry(latest)], SID)).toEqual(latest); // entry order, not timestamp
  });

  it("memory precedes persist, stays decided after failed append, and later actions are still persisted", () => {
    const seen: XsAliasDecidedEntryData[] = [];
    const port = createXsAliasDecided({
      sessionId: SID,
      entries: [],
      now: () => 999,
      persist(d) {
        expect(port.decided()).toBe(true);
        seen.push(d);
        if (seen.length === 1) throw new Error("append failure");
      },
    });
    port.markDecided("set");
    expect(port.decided()).toBe(true);
    port.markDecided("clear");
    expect(seen.map((d) => d.via)).toEqual(["set", "clear"]);
    expect(port.decided()).toBe(true);
    expect(createXsAliasDecided({ sessionId: SID, entries: [], persist: () => undefined }).decided()).toBe(false); // per stack, no globals
  });
});
