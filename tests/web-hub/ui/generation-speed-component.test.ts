// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import TxAssistant from "../../../src/web-hub/ui/src/components/transcript/TxAssistant.vue";
import type { AssistantView } from "../../../src/web-hub/ui/src/components/transcript/entries.js";

/**
 * task58 (web-hub-tokens-speed §6): the real `TxAssistant.vue` DOM — the cost `$` chip and
 * the `12.4 tokens/s` chip are SIBLINGS under one `.msg-meta`, each with its own `v-if`
 * (either may show alone; cost stays FIRST, speed after it), the container renders when
 * EITHER is present, streaming NEVER shows a speed number, and no other span/structure
 * changes (the pre-feature DOM stays byte-identical when no core exists).
 */

const CORE = { v: 1 as const, tokens: 124, genMs: 10000, deltaCount: 40 };

function view(partial: Partial<AssistantView>): AssistantView {
  return {
    blocks: [{ kind: "text", text: "hi" }],
    model: "m",
    costUsd: undefined,
    streaming: false,
    errorText: "",
    timestamp: 1234,
    ...partial,
  };
}

function mountTx(assistant: AssistantView) {
  return mount(TxAssistant, { props: { assistant, truncated: false } });
}

function meta(wr: ReturnType<typeof mountTx>) {
  return wr.find(".msg-meta");
}

function spans(wr: ReturnType<typeof mountTx>) {
  return meta(wr).findAll("span");
}

describe("TxAssistant.vue — generation speed chip", () => {
  it("cost + speed: two independent spans, cost FIRST, speed after, `12.4 tokens/s` fixed unit", () => {
    const wr = mountTx(view({ costUsd: 0.0123, generation: CORE }));
    expect(meta(wr).exists()).toBe(true);
    const chips = spans(wr);
    expect(chips).toHaveLength(2);
    expect(chips[0]!.text()).toBe("$0.0123");
    expect(chips[0]!.attributes("title")).toBeUndefined(); // cost span unchanged (pre-feature DOM)
    expect(chips[1]!.text()).toBe("12.4 tokens/s");
    expect(chips[1]!.classes()).toContain("tx-speed");
  });

  it("speed carries the disclosure tooltip (i18n key, default en locale)", () => {
    const wr = mountTx(view({ generation: CORE }));
    const title = spans(wr)[0]!.attributes("title");
    expect(typeof title).toBe("string");
    expect(title).toContain("Locally observed generation speed");
    expect(title).toContain("first-token wait");
    expect(title).toContain("not a GPU-throughput measure");
  });

  it("speed alone: no costUsd ⇒ the speed chip still shows, no cost span", () => {
    const wr = mountTx(view({ generation: CORE }));
    const chips = spans(wr);
    expect(chips).toHaveLength(1);
    expect(chips[0]!.text()).toBe("12.4 tokens/s");
  });

  it("cost alone: no core ⇒ EXACTLY the pre-feature DOM (one plain span, no container change)", () => {
    const wr = mountTx(view({ costUsd: 0.5 }));
    const chips = spans(wr);
    expect(chips).toHaveLength(1);
    expect(chips[0]!.text()).toBe("$0.5000"); // formatUsd keeps its own <$1 4-decimal rule — untouched
    expect(chips[0]!.classes()).toEqual([]);
    expect(chips[0]!.attributes("title")).toBeUndefined();
    expect(wr.find(".tx-speed").exists()).toBe(false);
  });

  it("neither ⇒ no .msg-meta at all", () => {
    const wr = mountTx(view({}));
    expect(meta(wr).exists()).toBe(false);
  });

  it("streaming NEVER shows a number — even if a core rode along", () => {
    const wr = mountTx(view({ streaming: true, generation: CORE }));
    expect(wr.find(".tx-speed").exists()).toBe(false);
    expect(wr.find(".msg-meta").exists()).toBe(false); // streaming messages have no cost line either
    expect(wr.find(".pill").exists()).toBe(true);
  });

  it("a defensible-but-invalid core object renders nothing (formatter fail-closed at the edge)", () => {
    const wr = mountTx(view({ generation: { v: 1, tokens: Number.NaN, genMs: 1000, deltaCount: 2 } }));
    expect(meta(wr).exists()).toBe(false);
  });

  it("every magnitude keeps exactly one decimal", () => {
    const wr = mountTx(view({ generation: { v: 1, tokens: 1000, genMs: 1000, deltaCount: 3 } }));
    expect(spans(wr)[0]!.text()).toBe("1000.0 tokens/s");
    const wr2 = mountTx(view({ generation: { v: 1, tokens: 6, genMs: 1000, deltaCount: 3 } }));
    expect(spans(wr2)[0]!.text()).toBe("6.0 tokens/s");
  });

  it("error text and truncation badge still render alongside the meta line (no structural drift)", () => {
    const wr = mount(TxAssistant, {
      props: { assistant: view({ errorText: "boom", costUsd: 0.02, generation: CORE }), truncated: true },
    });
    expect(wr.find(".msg-error").exists()).toBe(true);
    expect(wr.find(".badge-trunc").exists()).toBe(true);
    expect(spans(wr).map((s) => s.text())).toEqual(["$0.0200", "12.4 tokens/s"]);
  });
});
