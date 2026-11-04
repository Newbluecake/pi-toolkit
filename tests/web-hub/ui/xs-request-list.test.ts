// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import XsRequestList from "../../../src/web-hub/ui/src/components/control/XsRequestList.vue";
import { createControl } from "../../../src/web-hub/ui/src/composables/useControl.js";
import type { XsRequestListProps, XsRequestRowView } from "../../../src/web-hub/ui/src/contracts.js";
import type { CmdOutcome } from "../../../src/web-hub/ui/src/transport/types.js";

/**
 * `control/XsRequestList.vue` + the `xsActivate` handle surface (fabric-xs-activation plan
 * §3 P4): the light request area beside QueueList. Pinned here:
 *  - empty rows ⇒ NO DOM at all (off/legacy byte-identity — not even a container);
 *  - the activate button exists ONLY under the full gate the dock passes down — a row without
 *    an `activatable` entry never renders one, no matter how eligible it looks;
 *  - fake-data enabled state renders and emits on click; in-flight disables; retryAfterAt
 *    disables with the backoff note (quota never auto-executes);
 *  - the handle's singleflight: one wire frame per business key while in flight.
 */

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
});

function view(over: Partial<XsRequestRowView> & Pick<XsRequestRowView, "messageId">): XsRequestRowView {
  return {
    phaseToken: "delivered",
    wakeToken: null,
    replyToken: null,
    noteKey: "xs.noteDelivered",
    seeded: false,
    expired: false,
    ...over,
  };
}

function mountList(props: Partial<XsRequestListProps> & Pick<XsRequestListProps, "rows">) {
  const w = mount(XsRequestList, { props: { now: 5_000, ...props } as XsRequestListProps });
  mounted.push(w);
  return w;
}

describe("XsRequestList.vue", () => {
  it("empty rows render NO DOM (not even a container)", () => {
    const w = mountList({ rows: [] });
    expect(w.find(".xs-request-list").exists()).toBe(false);
    expect(w.html()).not.toContain("xs-request");
  });

  it("renders the token main line + translated evidence note", () => {
    const w = mountList({
      rows: [
        view({
          messageId: "m1",
          phaseToken: "started",
          wakeToken: "wake↓ pair_wake_rate",
          replyToken: "reply pending",
          noteKey: "xs.noteStarted",
        }),
      ],
    });
    const item = w.find(".xs-request-item");
    expect(item.attributes("data-phase")).toBe("started");
    expect(item.find(".state-chip").text()).toBe("started");
    expect(w.find(".chip-wake").text()).toBe("wake↓ pair_wake_rate");
    expect(w.findAll(".chip-muted")[0]!.text()).toBe("reply pending");
    expect(w.find(".queue-note").text()).toContain("Started:"); // translated prose (en test env)
    expect(w.find("[data-xs-activate]").exists()).toBe(false); // no gate passed down
  });

  it("unknown rows never offer activate; the query chip renders only when queryable", () => {
    const w = mountList({
      rows: [view({ messageId: "m1", phaseToken: "unknown", noteKey: "xs.noteUnknown" })],
      queryable: new Set(["m1"]),
    });
    expect(w.find("[data-xs-activate]").exists()).toBe(false);
    expect(w.find("[data-xs-query]").exists()).toBe(true);
    const q = mountList({ rows: [view({ messageId: "m1", phaseToken: "unknown" })] });
    expect(q.find("[data-xs-query]").exists()).toBe(false);
  });

  it("fake-enabled activate state: button renders, click emits the ORIGINAL key; in-flight disables", async () => {
    const w = mountList({
      rows: [view({ messageId: "m1", activationKey: "k1" })],
      activatable: new Map([["m1", {}]]),
    });
    const btn = w.find("[data-xs-activate]");
    expect(btn.exists()).toBe(true);
    expect(btn.attributes("disabled")).toBeUndefined();
    await btn.trigger("click");
    expect(w.emitted("activate")).toEqual([["m1", "k1"]]);
    await w.setProps({ inFlight: new Set(["m1"]) });
    const busy = w.find("[data-xs-activate]");
    expect(busy.attributes("disabled")).toBeDefined();
    expect(busy.text()).toContain("Activating");
  });

  it("a retryAfterAt in the future disables the button and shows the backoff note (never auto-runs)", async () => {
    const w = mountList({
      rows: [view({ messageId: "m1", activationKey: "k1" })],
      activatable: new Map([["m1", { retryAfterAt: 14_000 }]]),
      now: 5_000,
    });
    const btn = w.find("[data-xs-activate]");
    expect(btn.attributes("disabled")).toBeDefined();
    expect(w.find(".queue-note[role='status']").text()).toContain("Quota not recovered");
    expect(w.emitted("activate")).toBeUndefined();
  });

  it("an expired activation window keeps the button hidden with the expiry note (root fix #8: the row carries its key — eligibility, not key-absence, excludes it)", () => {
    // The dock's gate (xsActivateGate) excludes an expired row even with key+surface+caps —
    // pinned at the logic level; here the component renders the expiry note it hands down.
    const w = mountList({
      rows: [view({ messageId: "m1", activationKey: "k1", expired: true, noteKey: "xs.noteDelivered" })],
      activatable: new Map(), // gate said no
    });
    expect(w.find("[data-xs-activate]").exists()).toBe(false);
    expect(w.text()).toContain("activation window has expired");
  });

  it("the visible window caps at 8 rows with a +N note", () => {
    const rows = Array.from({ length: 10 }, (_, i) => view({ messageId: `m${i}` }));
    const w = mountList({ rows });
    expect(w.findAll(".xs-request-item").length).toBe(8);
    expect(w.find(".xs-request-more").text()).toContain("2");
  });
});

describe("createControl.xsActivate (singleflight per business key)", () => {
  type Req = Parameters<
    NonNullable<import("../../../src/web-hub/ui/src/transport/types.js").HubTransport["xsActivate"]>
  >[0];

  function fakeTransport(wait: (req: Req) => Promise<CmdOutcome>) {
    return {
      command: () => Promise.resolve({ ok: true } as CmdOutcome),
      dialog: () => Promise.resolve({ ok: true } as CmdOutcome),
      xsActivate: (req: Req) => wait(req),
    };
  }

  it("absent transport ⇒ the handle exposes no surface at all", () => {
    const handle = createControl(fakeTransport(() => Promise.resolve({ ok: true })) as never, () => {});
    expect(handle.xsActivate).toBeDefined();
    const bare = createControl(
      {
        command: () => Promise.resolve({ ok: true } as CmdOutcome),
        dialog: () => Promise.resolve({ ok: true } as CmdOutcome),
      } as never,
      () => {},
    );
    expect(bare.xsActivate).toBeUndefined();
  });

  it("a double-click fires ONE wire frame; a settled attempt mints a fresh one", async () => {
    const frames: Req[] = [];
    let release: ((o: CmdOutcome) => void) | undefined;
    const handle = createControl(
      fakeTransport(
        (req) =>
          new Promise<CmdOutcome>((resolve) => {
            frames.push(req);
            release = resolve;
          }),
      ) as never,
      () => {},
    );
    const first = handle.xsActivate!("a1", { action: "activate", messageId: "m1", activationKey: "k1" });
    const second = handle.xsActivate!("a1", { action: "activate", messageId: "m1", activationKey: "k1" });
    expect(second).toBe(first); // same in-flight promise — one business key, one frame
    expect(frames.length).toBe(1);
    expect(frames[0]).toMatchObject({ agentKey: "a1", action: "activate", messageId: "m1", activationKey: "k1" });
    release!({ ok: true });
    await first;
    const third = handle.xsActivate!("a1", { action: "activate", messageId: "m1", activationKey: "k1" });
    expect(frames.length).toBe(2); // new attempt after settle — a fresh cmd id
    expect(frames[1]!.id).not.toBe(frames[0]!.id);
    release!({ ok: true });
    await third;
  });

  it("different keys fly independently", async () => {
    const frames: Req[] = [];
    const handle = createControl(
      fakeTransport(
        (req) =>
          new Promise<CmdOutcome>((resolve) => {
            frames.push(req);
            setTimeout(() => resolve({ ok: true }), 0);
          }),
      ) as never,
      () => {},
    );
    const p1 = handle.xsActivate!("a1", { action: "query", messageId: "m1" });
    const p2 = handle.xsActivate!("a1", { action: "query", messageId: "m2" });
    expect(frames.length).toBe(2);
    await Promise.all([p1, p2]);
  });

  it("query/activate share the business-key singleflight (one op per key at a time)", async () => {
    const frames: Req[] = [];
    let release: ((o: CmdOutcome) => void) | undefined;
    const handle = createControl(
      fakeTransport(
        (req) =>
          new Promise<CmdOutcome>((resolve) => {
            frames.push(req);
            release = resolve;
          }),
      ) as never,
      () => {},
    );
    const a = handle.xsActivate!("a1", { action: "activate", messageId: "m1", activationKey: "k1" });
    const q = handle.xsActivate!("a1", { action: "query", messageId: "m1", activationKey: "k1" });
    expect(q).toBe(a);
    expect(frames.length).toBe(1);
    release!({ ok: true });
    await a;
  });
});
