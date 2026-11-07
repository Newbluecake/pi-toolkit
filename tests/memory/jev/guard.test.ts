// J1 (jev-plan §4 J1 / v4.1 §3.2, adopted by arch §6.2.5): guardHash
// multiset pairing — the three canonical cases plus multiset counting.

import { describe, expect, it } from "vitest";
import { touchedUserEntries } from "../../../src/memory/jev/guard.js";

const BEFORE = [
  "# 核心规则",
  "",
  "- 长命令一律加 timeout", // user entry (hand-written default)
  "- 删除只用精确路径",
  "",
  "## 发版",
  "",
  "- 发版须用户确认 <!-- mem user -->",
].join("\n");

describe("touchedUserEntries (v4.1 §3.2 三例)", () => {
  it("top-of-file insertion shifts every line but never triggers", () => {
    const after = `- 新插入的一行\n${BEFORE}`;
    expect(touchedUserEntries(BEFORE, after, true)).toEqual([]);
  });

  it("editing one character of a user entry triggers exactly that entry", () => {
    const after = BEFORE.replace("长命令一律加 timeout", "长命令一律加 timeout（含 600s 上限）");
    const touched = touchedUserEntries(BEFORE, after, true);
    expect(touched).toHaveLength(1);
    expect(touched[0]!.body).toContain("长命令");
  });

  it("deleting one of two identical duplicate user rows triggers", () => {
    const dup = ["- 重复的用户令", "- 重复的用户令", "- 其他"].join("\n");
    const after = ["- 重复的用户令", "- 其他"].join("\n");
    expect(touchedUserEntries(dup, after, true)).toHaveLength(1);
    // Both copies kept ⇒ untouched.
    expect(touchedUserEntries(dup, dup, true)).toHaveLength(0);
  });

  it("flipping the user marker (inline or file-level) changes raw ⇒ triggers", () => {
    const after = BEFORE.replace("<!-- mem user -->", "");
    expect(touchedUserEntries(BEFORE, after, true)).toHaveLength(1);
    // An agent-authored file defaults to agent authority: nothing to guard.
    expect(touchedUserEntries(BEFORE, BEFORE, false)).toEqual([]);
  });

  it("inline user entry on an agent file is guarded; pure additions never are", () => {
    const agentFile = "- agent lesson one\n- user order <!-- mem user -->\n";
    expect(touchedUserEntries(agentFile, "- agent lesson one\n", false)).toHaveLength(1);
    expect(touchedUserEntries(agentFile, `${agentFile}- brand new line\n`, false)).toHaveLength(0);
  });
});
