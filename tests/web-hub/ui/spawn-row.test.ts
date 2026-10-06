// @vitest-environment happy-dom
import { mount, flushPromises } from "@vue/test-utils";
import { ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import SpawnRow from "../../../src/web-hub/ui/src/components/spawn/SpawnRow.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { SpawnRecordPublic } from "../../../src/web-hub/protocol/spawn.js";

/**
 * `spawn/SpawnRow.vue` — default-model plan F1 coverage: the `model` inline badge (D3), the
 * `model-rejected` hint mapping (D5), and the faithful retry (`rec.model ?? ""` on the wire
 * ONLY under `spawn.model.v1`, D4). The existing detail/dismiss mechanics are covered
 * elsewhere; this file pins only the F1 surface.
 */

const BASE_REC: SpawnRecordPublic = {
  spawnId: "sp1",
  state: "failed",
  createdAt: 1000,
  updatedAt: 1000,
  cwdLabel: "proj",
  origin: { listener: "loopback", reqId: "req-1" },
};

interface FakeHub {
  hub: unknown;
  submits: Array<Record<string, unknown>>;
}

function fakeHub(opts: { caps: string[]; ownerCwd?: string }): FakeHub {
  const submits: Array<Record<string, unknown>> = [];
  const hub = {
    state: ref({ hub: { caps: opts.caps }, agents: new Map() }),
    dispatch: () => {},
    spawn: {
      list: async () => ({
        ok: true as const,
        policy: { allowed: true },
        items: [{ ...BASE_REC, ...(opts.ownerCwd !== undefined ? { cwd: opts.ownerCwd } : {}) }],
      }),
      dirs: async () => ({ ok: true as const, recent: [] }),
      start: async () => ({ ok: false as const, error: "E_UNSUPPORTED", retryable: false }),
      stop: async () => ({ ok: true as const, state: "stopping" as const }),
      newSession: {
        submit: async (input: Record<string, unknown>) => {
          submits.push(input);
          return true;
        },
      },
    },
  };
  return { hub, submits };
}

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  document.body.innerHTML = "";
});

function mountRow(rec: SpawnRecordPublic, f: FakeHub) {
  const wrapper = mount(SpawnRow, {
    props: { rec },
    attachTo: document.body,
    global: { provide: { [HUB_CTX as symbol]: f.hub } },
  });
  mounted.push(wrapper);
  return wrapper;
}

describe("SpawnRow.vue — model badge (default-model plan F1 D3)", () => {
  it("a record with an effective model shows it as an inline chip; without one, no chip", () => {
    const f = fakeHub({ caps: ["spawn.v1", "spawn.model.v1"] });
    const withModel = mountRow({ ...BASE_REC, model: "anthropic/claude-opus-4-5" }, f);
    expect(withModel.find(".chip-mono").text()).toBe("anthropic/claude-opus-4-5");
    withModel.unmount();
    const without = mountRow(BASE_REC, f);
    expect(without.find(".chip-mono").exists()).toBe(false);
  });
});

describe("SpawnRow.vue — model-rejected hint (default-model plan F1 D5)", () => {
  it('hint "model-rejected" renders its i18n copy via spawnHintKey', () => {
    const f = fakeHub({ caps: [] });
    const w = mountRow({ ...BASE_REC, hint: "model-rejected" }, f);
    expect(w.find(".spawn-row-hint").text()).toContain("The model was rejected by pi");
  });

  it("an unknown future hint still degrades to the raw string (safe fallback preserved)", () => {
    const f = fakeHub({ caps: [] });
    const w = mountRow({ ...BASE_REC, hint: "some-future-hint" as never }, f);
    expect(w.find(".spawn-row-hint").text()).toBe("some-future-hint");
  });
});

describe("SpawnRow.vue — faithful retry (default-model plan F1 D2/D4)", () => {
  async function retry(f: FakeHub, rec: SpawnRecordPublic): Promise<void> {
    const w = mountRow(rec, f);
    const btn = w.findAll("button").find((b) => b.text() === "Retry")!;
    await btn.trigger("click");
    await flushPromises();
  }

  it("spawn.model.v1 present ⇒ retry resubmits with the record's effective model", async () => {
    const f = fakeHub({ caps: ["spawn.v1", "spawn.model.v1"], ownerCwd: "/real/proj" });
    await retry(f, { ...BASE_REC, model: "openai/gpt-5" });
    expect(f.submits).toEqual([{ cwd: "/real/proj", model: "openai/gpt-5" }]);
  });

  it('cap present but the record has no model ⇒ retry sends the explicit "" (pi default) tri-state', async () => {
    const f = fakeHub({ caps: ["spawn.v1", "spawn.model.v1"], ownerCwd: "/real/proj" });
    await retry(f, BASE_REC);
    expect(f.submits).toEqual([{ cwd: "/real/proj", model: "" }]);
  });

  it("an old hub (no spawn.model.v1) ⇒ the retry body has NO model key at all", async () => {
    const f = fakeHub({ caps: ["spawn.v1"], ownerCwd: "/real/proj" });
    await retry(f, { ...BASE_REC, model: "openai/gpt-5" });
    expect(f.submits).toHaveLength(1);
    expect("model" in f.submits[0]!).toBe(false);
  });
});
