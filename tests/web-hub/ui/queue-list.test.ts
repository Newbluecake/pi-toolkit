// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import QueueList from "../../../src/web-hub/ui/src/components/control/QueueList.vue";
import { mergeQueue } from "../../../src/web-hub/ui/src/logic/control.js";

/**
 * `control/QueueList.vue` (control-plan.md v2.1 §7.4/§7.7 — C5): the mergeQueue model — mode /
 * source / state badges, Retry+Discard on failed, Resend on notExecuted, one-shot dropped note,
 * and the unconfirmed / unknown / offline prose notes.
 */

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
});

function mountQueue(items: readonly unknown[]) {
  const wrapper = mount(QueueList, { props: { items } });
  mounted.push(wrapper);
  return wrapper;
}

describe("QueueList.vue", () => {
  it("renders nothing for an empty merge", () => {
    const w = mountQueue([]);
    expect(w.find(".queue-list").exists()).toBe(false);
  });

  it("server queue entries show mode + source badges (web ×2, terminal ×1 — control.json shape)", () => {
    const server = [
      { id: "q1", text: "keep going", deliver: "steer", source: "web", cmdId: "c1", at: 1 },
      { id: "q2", text: "then run gates", deliver: "followUp", source: "web", cmdId: "c2", at: 2 },
      { id: "q3", text: "check git status", deliver: "steer", source: "tui", at: 3 },
    ];
    const w = mountQueue(mergeQueue(server, [], []));
    const items = w.findAll(".queue-item");
    expect(items).toHaveLength(3);
    expect(items[0]!.text()).toContain("steer");
    expect(items[0]!.text()).toContain("web");
    expect(items[1]!.text()).toContain("follow-up");
    expect(items[2]!.text()).toContain("terminal");
    expect(items[2]!.text()).toContain("check git status");
  });

  it("mergeQueue drops optimistic items already mirrored server-side and queueDropped ones", () => {
    const server = [{ id: "q1", text: "a", deliver: "steer", source: "web", cmdId: "dup", at: 1 }];
    const optimistic = [
      { id: "dup", kind: "prompt", text: "a", state: "sending", at: 0 },
      { id: "gone", kind: "prompt", text: "b", state: "sending", at: 0 },
      { id: "new", kind: "prompt", text: "c", state: "sending", at: 0 },
    ];
    const w = mountQueue(mergeQueue(server, optimistic, ["gone"]));
    const texts = w.findAll(".queue-item .queue-text").map((i) => i.text());
    expect(texts).toEqual(["c", "a"]); // optimistic first ("dup" dropped as mirrored, "gone" dropped), server row after
    expect(w.findAll(".queue-item")).toHaveLength(2);
  });

  it("failed items offer Retry + Discard and map E_SESSION_CHANGED to its prose", () => {
    const items = [
      {
        id: "f1",
        kind: "prompt",
        text: "boom",
        state: "failed",
        error: "E_SESSION_CHANGED",
        retryable: false,
        at: 0,
      },
    ];
    const w = mountQueue(items);
    expect(w.text()).toContain("switched sessions");
    const buttons = w.findAll(".queue-actions button");
    expect(buttons).toHaveLength(2);
    return Promise.resolve();
  });

  it("Retry/Discard emit the item id; notExecuted offers Resend", async () => {
    const items = [
      { id: "f1", kind: "prompt", text: "boom", state: "failed", error: "E_NETWORK", at: 0 },
      { id: "n1", kind: "prompt", text: "never ran", state: "notExecuted", error: "E_UNKNOWN_ID", at: 0 },
    ];
    const w = mountQueue(items);
    const rows = w.findAll(".queue-item");
    await rows[0]!.findAll("button")[0]!.trigger("click");
    await rows[0]!.findAll("button")[1]!.trigger("click");
    expect(w.emitted("retry")).toEqual([["f1"]]);
    expect(w.emitted("discard")).toEqual([["f1"]]);
    expect(rows[1]!.text()).toContain("Resend");
    expect(rows[1]!.text()).toContain("Never reached the agent");
  });

  it("dropped items show the one-shot note and a Discard; unknown/offline show the unknown notes", () => {
    const items = [
      { id: "d1", kind: "prompt", text: "x", state: "dropped", at: 0 },
      { id: "u1", kind: "prompt", text: "y", state: "unknown", at: 0 },
      { id: "u2", kind: "prompt", text: "z", state: "unknown", offline: true, at: 0 },
      { id: "q1", kind: "prompt", text: "w", state: "querying", at: 0 },
    ];
    const w = mountQueue(items);
    const rows = w.findAll(".queue-item");
    expect(rows[0]!.text()).toContain("Returned to the terminal editor or discarded.");
    expect(rows[0]!.findAll("button")).toHaveLength(1); // discard only
    expect(rows[1]!.text()).toContain("Outcome unknown");
    expect(rows[2]!.text()).toContain("went offline");
    expect(rows[3]!.text()).toContain("checking");
  });

  it("unconfirmed/unobserved items carry the 未能确认 note (§7.7)", () => {
    const items = [{ id: "u1", kind: "prompt", text: "x", state: "unconfirmed", at: 0 }];
    const w = mountQueue(items);
    expect(w.text()).toContain("could not confirm it entered the conversation");
  });

  it("non-prompt kinds get a compact kind badge instead of a mode badge", () => {
    const items = [
      { id: "a1", kind: "abort", state: "sending", at: 0 },
      { id: "c1", kind: "command", name: "compact", state: "running", at: 0 },
    ];
    const w = mountQueue(items);
    const rows = w.findAll(".queue-item");
    expect(rows[0]!.text()).toContain("stop");
    expect(rows[1]!.text()).toContain("/compact");
    expect(rows[1]!.text()).toContain("running");
  });
});
