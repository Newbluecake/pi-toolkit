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

// ---------------------------------------------------------------------------
// steer-recall (web-hub-steer-recall plan §7, P-ui): the hold-row renderings —
// held / returned / recalling / handed / tooLate × recallable / unavailable, their notes,
// aria labels, the disabled state while recalling, and the DOM-identical guarantee for a
// no-cap hub (`holdEnabled: false` hides hold rows entirely). The 8 tests above are the
// pre-feature contract and stay untouched.
// ---------------------------------------------------------------------------

function mountHoldQueue(
  items: readonly unknown[],
  props: { holdEnabled?: boolean; holdLink?: "live" | "unavailable" } = {},
) {
  const wrapper = mount(QueueList, {
    props: {
      items,
      ...(props.holdEnabled !== undefined ? { holdEnabled: props.holdEnabled } : {}),
      ...(props.holdLink !== undefined ? { holdLink: props.holdLink } : {}),
    },
  });
  mounted.push(wrapper);
  return wrapper;
}

const heldRow = (over: Record<string, unknown> = {}) => ({
  held: true,
  id: "cmd-h1",
  cmdId: "cmd-h1",
  text: "please rebase main",
  deliver: "steer",
  state: "held",
  holdBase: "held",
  sessionId: "s1",
  at: 1,
  mode: "recallable",
  ...over,
});

describe("QueueList.vue — steer-recall hold rows (§7)", () => {
  it("holdEnabled:false hides hold rows entirely (old agent/hub — DOM identical to pre-feature)", () => {
    const w = mountHoldQueue([heldRow(), { id: "q1", text: "t", deliver: "steer", source: "tui", at: 1 }], {
      holdEnabled: false,
    });
    expect(w.findAll(".queue-item")).toHaveLength(1);
    expect(w.find("[data-recall]").exists()).toBe(false);
    expect(w.find(".queue-item").attributes("data-state")).toBe("queued");
  });

  it("recallable held row: held chip + heldNote + recall button with aria-label carrying the text prefix", () => {
    const w = mountHoldQueue([heldRow()], { holdEnabled: true, holdLink: "live" });
    const li = w.find(".queue-item");
    expect(li.attributes("data-state")).toBe("held");
    expect(li.find(".state-chip").text()).toBe("held");
    expect(li.find(".queue-note").text()).toContain("Held until the current turn ends");
    const btn = li.find("[data-recall]");
    expect(btn.attributes("aria-label")).toBe("Recall this held message: please rebase main");
    expect(btn.text()).toContain("Recall");
  });

  it("recallable returned row: returned chip + per-reason note + edit/discard buttons", () => {
    for (const [reason, note] of [
      ["aborted", "aborted before delivery"],
      ["session", "session ended before delivery"],
      ["reload", "reloaded before delivery"],
      ["stale", "Returned without delivery"],
    ] as const) {
      const w = mountHoldQueue([heldRow({ state: "returned", reason, holdBase: "returned", mode: "recallable" })], {
        holdEnabled: true,
        holdLink: "live",
      });
      const li = w.find(".queue-item");
      expect(li.attributes("data-state")).toBe("returned");
      expect(li.find(".queue-note").text()).toContain(note);
      expect(li.find("[data-edit]").exists()).toBe(true);
      expect(li.find("[data-discard-held]").exists()).toBe(true);
      expect(li.find("[data-recall]").exists()).toBe(false);
      expect(li.find("[data-copy-held]").exists()).toBe(false);
    }
  });

  it("unavailable row (per-row mode OR the whole link down): ONLY copy + holdUnavailable note — never recall/edit/discard", () => {
    const w = mountHoldQueue([heldRow({ mode: "unavailable" })], { holdEnabled: true, holdLink: "live" });
    const li = w.find(".queue-item");
    expect(li.attributes("data-state")).toBe("unavailable");
    expect(li.find(".state-chip").text()).toBe("unavailable");
    expect(li.find(".queue-note").text()).toContain("cannot recall");
    expect(li.find("[data-copy-held]").exists()).toBe(true);
    for (const sel of ["[data-recall]", "[data-edit]", "[data-discard-held]"]) {
      expect(li.find(sel).exists()).toBe(false);
    }
    // and with the whole link down (SSE断开) the same copy-only rendering applies — a row the
    // merge did not stamp explicitly (mode key absent) inherits the link mode:
    const row = { ...heldRow() };
    delete (row as Record<string, unknown>)["mode"];
    const w2 = mountHoldQueue([row], { holdEnabled: true, holdLink: "unavailable" });
    expect(w2.find(".queue-item").attributes("data-state")).toBe("unavailable");
    expect(w2.find("[data-copy-held]").exists()).toBe(true);
    expect(w2.find("[data-recall]").exists()).toBe(false);
  });

  it("a `gone` row (absent from the newest same-scope snapshot, Y2 ctl-truncation) is copy-only even while the link is live", () => {
    const w = mountHoldQueue([heldRow({ mode: "unavailable", gone: true })], { holdEnabled: true, holdLink: "live" });
    expect(w.find(".queue-item").attributes("data-state")).toBe("unavailable");
    expect(w.find("[data-recall]").exists()).toBe(false);
    expect(w.find("[data-copy-held]").exists()).toBe(true);
  });

  it("recalling row: buttons disabled + aria-disabled; data-state recalling; disabled never emits", async () => {
    const w = mountHoldQueue([heldRow({ state: "recalling" })], { holdEnabled: true, holdLink: "live" });
    const li = w.find(".queue-item");
    expect(li.attributes("data-state")).toBe("recalling");
    expect(li.find(".state-chip").text()).toBe("recalling");
    const btn = li.find("[data-recall]");
    expect(btn.attributes("disabled")).toBeDefined();
    expect(btn.attributes("aria-disabled")).toBe("true");
    await btn.trigger("click");
    expect(w.emitted("recall")).toBeUndefined(); // disabled native buttons never emit
  });

  it("tooLate row: handed-style state + tooLate note + copy (Q5 undifferentiated 已交付 look)", () => {
    const w = mountHoldQueue([heldRow({ state: "tooLate", holdBase: "held", mode: "recallable" })], {
      holdEnabled: true,
      holdLink: "live",
    });
    const li = w.find(".queue-item");
    expect(li.attributes("data-state")).toBe("handed");
    expect(li.find(".state-chip").text()).toBe("handed");
    expect(li.find(".queue-note").text()).toContain("Already delivered");
    expect(li.find("[data-copy-held]").exists()).toBe(true);
    expect(li.find("[data-recall]").exists()).toBe(false);
  });

  it("handed row: handedNote, no actions at all", () => {
    const w = mountHoldQueue([heldRow({ state: "handed", mode: "recallable" })], {
      holdEnabled: true,
      holdLink: "live",
    });
    const li = w.find(".queue-item");
    expect(li.attributes("data-state")).toBe("handed");
    expect(li.find(".queue-note").text()).toContain("Handed to the model");
    expect(li.find(".queue-actions button").exists()).toBe(false);
  });

  it("buttons are keyboard-operable (native Enter/Space clicks emit) and copy emits copyHeld", async () => {
    const w = mountHoldQueue([heldRow()], { holdEnabled: true, holdLink: "live" });
    await w.find("[data-recall]").trigger("click");
    expect(w.emitted("recall")).toEqual([["cmd-h1"]]);
    const w2 = mountHoldQueue(
      [heldRow({ state: "returned", reason: "stale", holdBase: "returned", mode: "recallable" })],
      {
        holdEnabled: true,
        holdLink: "live",
      },
    );
    await w2.find("[data-edit]").trigger("click");
    expect(w2.emitted("edit")).toEqual([["cmd-h1"]]);
    await w2.find("[data-discard-held]").trigger("click");
    expect(w2.emitted("discardHeld")).toEqual([["cmd-h1"]]);
    const w3 = mountHoldQueue([heldRow({ mode: "unavailable" })], { holdEnabled: true, holdLink: "live" });
    await w3.find("[data-copy-held]").trigger("click");
    expect(w3.emitted("copyHeld")).toEqual([["cmd-h1"]]);
  });

  it("follow-up badge + previous-session marker ride the hold row", () => {
    const w = mountHoldQueue(
      [
        heldRow({
          deliver: "followUp",
          prevSession: true,
          state: "returned",
          reason: "session",
          holdBase: "returned",
          mode: "recallable",
        }),
      ],
      { holdEnabled: true, holdLink: "live" },
    );
    const li = w.find(".queue-item");
    expect(li.text()).toContain("follow-up");
    expect(li.text()).toContain("from a previous session");
  });

  it("the text clips long bodies (like every queue row)", () => {
    const w = mountHoldQueue([heldRow({ text: "x".repeat(300) })], { holdEnabled: true, holdLink: "live" });
    expect(w.find(".queue-text").text().length).toBeLessThanOrEqual(160);
  });

  it("an optimistic hold item (this tab's own, full text) renders as a hold row too", () => {
    const w = mountHoldQueue(
      [
        {
          id: "cmd-own",
          kind: "prompt",
          text: "the full typed body",
          deliver: "followUp",
          state: "held",
          at: 2,
          mode: "recallable",
          holdBase: "held",
        },
      ],
      { holdEnabled: true, holdLink: "live" },
    );
    const li = w.find(".queue-item");
    expect(li.attributes("data-state")).toBe("held");
    expect(li.find(".queue-text").text()).toBe("the full typed body");
    expect(li.find("[data-recall]").attributes("aria-label")).toContain("the full typed body");
  });
});
