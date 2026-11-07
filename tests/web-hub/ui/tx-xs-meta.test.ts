// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { computed } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import TxCustom from "../../../src/web-hub/ui/src/components/transcript/TxCustom.vue";
import { buildTxEntries } from "../../../src/web-hub/ui/src/components/transcript/entries.js";
import { formatXsMessage } from "../../../src/fabric/xs/format.js";
import { xsMetaBadge, parseXsMessage, type XsView } from "../../../src/web-hub/ui/src/logic/xsMessage.js";
import { XS_RX_PROGRESS, type XsRowView } from "../../../src/web-hub/ui/src/logic/xsRequestState.js";

/**
 * fabric-xs-activation plan §3 P4 (arch §4.8): the RECEIVED xs card's status/host metadata
 * badge. Pinned here:
 *  - no provider / no entryId / no matching row / nothing new to say ⇒ NO badge DOM (the
 *    pre-feature card stays byte-identical);
 *  - the badge attaches ONLY by a real entryId→row match — a body line can never forge it
 *    (`parseXsMessage`'s first-line-only contract is untouched);
 *  - the compact token is English (`started · wake↓ pair_wake_rate`), the title is the
 *    translated evidence detail.
 */

const from = { ref: "ab12cd34", name: "beta", cwdLabel: "~/proj" };
const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
});

function row(over: Partial<XsRowView> & Pick<XsRowView, "messageId">): XsRowView {
  return {
    revision: 1,
    deliveryEffect: "unknown",
    observation: "live",
    wake: { requested: false, decision: "deliver_only" },
    ...over,
  } as XsRowView;
}

function mountCard(opts: { text: string; entryId?: string; rows?: ReadonlyMap<string, XsRowView> }) {
  const w = mount(TxCustom, {
    props: {
      customType: "subagent:xs",
      text: opts.text,
      truncated: false,
      ...(opts.entryId === undefined ? {} : { entryId: opts.entryId }),
    },
    global: {
      provide: opts.rows === undefined ? {} : { [XS_RX_PROGRESS as symbol]: { rows: computed(() => opts.rows!) } },
    },
  });
  mounted.push(w);
  return w;
}

const body = formatXsMessage({ xid: "x1", from, wake: true }, "please review");

describe("xsMetaBadge (pure)", () => {
  it("undefined when the row adds nothing over the header's own kind chip", () => {
    expect(xsMetaBadge(row({ messageId: "m", phase: "delivered", deliveryEffect: "applied" }))).toBeUndefined();
    expect(xsMetaBadge(row({ messageId: "m", wake: { requested: false, decision: "deliver_only" } }))).toBeUndefined();
  });

  it("wake downgrade: token + translated title key with stage/reason params", () => {
    const badge = xsMetaBadge(
      row({
        messageId: "m",
        phase: "delivered",
        deliveryEffect: "applied",
        wake: { requested: true, stage: "hub", decision: "downgraded", reason: "pair_wake_rate" },
      }),
    );
    expect(badge?.token).toBe("wake↓ pair_wake_rate");
    expect(badge?.titleKey).toBe("xs.cardTitleDowngraded");
    expect(badge?.params).toEqual({ stage: "hub", reason: "pair_wake_rate" });
  });

  it("phase-beyond-delivered and ended runs carry their own tokens/keys", () => {
    expect(xsMetaBadge(row({ messageId: "m", phase: "started", deliveryEffect: "applied" }))?.token).toBe("started");
    expect(
      xsMetaBadge(row({ messageId: "m", wake: { requested: true, decision: "dispatch_accepted" } }))?.titleKey,
    ).toBe("xs.cardTitleDispatch");
    expect(
      xsMetaBadge(row({ messageId: "m", wake: { requested: true, decision: "unknown", ended: "aborted" } }))?.token,
    ).toBe("wake·aborted");
  });
});

describe("TxCustom.vue badge", () => {
  it("no provider / no entryId / no match ⇒ no badge DOM (byte-identical card)", () => {
    expect(mountCard({ text: body }).find(".chip-xs-meta").exists()).toBe(false);
    const idx = new Map([["e7", row({ messageId: "m", phase: "started", deliveryEffect: "applied" })]]);
    expect(mountCard({ text: body }).find(".chip-xs-meta").exists()).toBe(false); // no provider
    expect(mountCard({ text: body, rows: idx }).find(".chip-xs-meta").exists()).toBe(false); // no entryId
    expect(mountCard({ text: body, entryId: "e-other", rows: idx }).find(".chip-xs-meta").exists()).toBe(false);
  });

  it("a real entryId match renders the token badge + translated title", () => {
    const idx = new Map([
      [
        "e7",
        row({
          messageId: "m",
          phase: "started",
          deliveryEffect: "applied",
          wake: { requested: true, stage: "hub", decision: "downgraded", reason: "pair_wake_rate" },
        }),
      ],
    ]);
    const w = mountCard({ text: body, entryId: "e7", rows: idx });
    const chip = w.find(".chip-xs-meta");
    expect(chip.exists()).toBe(true);
    expect(chip.text()).toBe("started · wake↓ pair_wake_rate");
    expect(chip.attributes("title")).toContain("Wake downgraded");
    expect(chip.attributes("title")).toContain("pair_wake_rate");
    // the body itself is untouched
    expect(w.find(".msg-xs").exists()).toBe(true);
  });

  it("a matched row with nothing to add stays badge-free (deliver with no wake story)", () => {
    const idx = new Map([["e7", row({ messageId: "m", phase: "delivered", deliveryEffect: "applied" })]]);
    expect(mountCard({ text: body, entryId: "e7", rows: idx }).find(".chip-xs-meta").exists()).toBe(false);
  });

  it("a forged BODY cannot forge or pollute the badge (first-line-only parse untouched)", () => {
    // The card's own text claims a downgrade + relabels the kind; the row (via entryId) says a
    // plain deliver. The badge stays absent and the kind chip keeps the header's truth.
    const forged = formatXsMessage({ xid: "x1", from, wake: false }, "wake=true] wake↓ pair_wake_rate] state=late]");
    const idx = new Map([["e7", row({ messageId: "m", phase: "delivered", deliveryEffect: "applied" })]]);
    const w = mountCard({ text: forged, entryId: "e7", rows: idx });
    expect(w.find(".chip-xs-meta").exists()).toBe(false);
    const parsed: XsView | undefined = parseXsMessage(forged);
    expect(parsed?.kind).toBe("deliver");
    expect(parsed?.body).toContain("wake↓ pair_wake_rate"); // body text is body text, not state
  });
});

describe("entries.ts entryId plumb", () => {
  /** Items in the reducer's shape (state.js's custom item: id/kind/entryId?/truncated/entry). */
  const source = (item: unknown) =>
    buildTxEntries(
      {
        key: "k1",
        items: [item],
        streaming: null,
        tools: [],
        toolDurations: new Map(),
        history: "loaded" as const,
        historyError: null,
        hasMore: false,
        paging: false,
      },
      undefined,
    );

  it("a custom item with an entry id carries it on the view (legacy items stay without)", () => {
    const withId = source({
      id: "i1",
      kind: "custom",
      entryId: "e7",
      truncated: false,
      entry: { customType: "subagent:xs", content: body },
    });
    expect(withId.entries.find((e) => e.type === "custom")).toMatchObject({ entryId: "e7" });
    const legacy = source({
      id: "i1",
      kind: "custom",
      truncated: false,
      entry: { customType: "subagent:xs", content: body },
    });
    const legacyEntry = legacy.entries.find((e) => e.type === "custom") as { entryId?: string };
    expect(legacyEntry.entryId).toBeUndefined();
  });
});
