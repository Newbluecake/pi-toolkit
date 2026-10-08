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

describe("SpawnRow.vue — restore (spawn-restore plan §9.1)", () => {
  it("a restore in flight shows the `restoring` token chip and a phase hint line (attempt > 1 annotated)", () => {
    const f = fakeHub({ caps: ["spawn.v1"] });
    const w = mountRow(
      { ...BASE_REC, state: "starting", restore: { phase: "reaping", attempt: 0, prevAgentKey: "a-old" } },
      f,
    );
    const chip = w.find(".chip-spawn");
    expect(chip.text()).toBe("restoring");
    expect(chip.attributes("data-state")).toBe("restoring");
    expect(w.find('[data-restore="phase"]').text()).toBe("Stopping the previous process…");
    w.unmount();
    const w2 = mountRow(
      { ...BASE_REC, state: "starting", restore: { phase: "forking", attempt: 2, prevAgentKey: "a-old" } },
      f,
    );
    expect(w2.find('[data-restore="phase"]').text()).toBe("Starting pi on the saved session… (attempt 2)");
  });

  it("a plain starting row is unchanged (no restore slot ⇒ `starting`, no phase line)", () => {
    const w = mountRow({ ...BASE_REC, state: "starting" }, fakeHub({ caps: ["spawn.v1"] }));
    expect(w.find(".chip-spawn").text()).toBe("starting");
    expect(w.find(".chip-spawn").attributes("data-state")).toBe("starting");
    expect(w.find('[data-restore="phase"]').exists()).toBe(false);
  });

  it("a failed restore shows the localized restore.failure line; unknown codes fall back to the raw code", () => {
    const f = fakeHub({ caps: ["spawn.v1"] });
    const w = mountRow({ ...BASE_REC, state: "failed", restore: { attempt: 1, failure: "session-missing" } }, f);
    expect(w.find(".chip-spawn").text()).toBe("failed");
    expect(w.find('[data-restore="failure"]').text()).toBe("The session file no longer exists — cannot restore");
    w.unmount();
    const w2 = mountRow(
      {
        ...BASE_REC,
        state: "failed",
        restore: { attempt: 1, failure: "future-code" as unknown as "exhausted" },
      },
      f,
    );
    expect(w2.find('[data-restore="failure"]').text()).toBe("future-code");
  });
});

// ---------------------------------------------------------------------------
// session-history plan PD15: the `from` marker — retry hidden, hint + badge shown
// ---------------------------------------------------------------------------

describe("SpawnRow.vue — the from marker (session-history plan PD15)", () => {
  it('a record with from:"history" shows the badge and the fromRetryHidden hint, and hides Retry', () => {
    const f = fakeHub({ caps: ["spawn.v1"] });
    const w = mountRow({ ...BASE_REC, from: "history" }, f);
    const chips = w.findAll(".chip-mono");
    expect(chips.map((c) => c.text())).toContain("history");
    expect(w.text()).toContain("This session was opened from history");
    const buttons = w.findAll("button").map((b) => b.text());
    expect(buttons).not.toContain("Retry");
    expect(buttons).toContain("Details"); // the other actions stay
  });

  it('from:"fork" hides retry too; a from-less record keeps it', () => {
    const f = fakeHub({ caps: ["spawn.v1"] });
    const forked = mountRow({ ...BASE_REC, from: "fork" }, f);
    expect(forked.findAll("button").map((b) => b.text())).not.toContain("Retry");
    expect(forked.findAll(".chip-mono").map((c) => c.text())).toContain("fork");
    forked.unmount();
    const plain = mountRow(BASE_REC, f);
    expect(plain.findAll("button").map((b) => b.text())).toContain("Retry");
    expect(plain.findAll(".chip-mono")).toHaveLength(0);
  });

  it("the hint renders for a starting record too (not only failed)", () => {
    const f = fakeHub({ caps: ["spawn.v1"] });
    const w = mountRow({ ...BASE_REC, state: "starting", from: "history" }, f);
    expect(w.text()).toContain("This session was opened from history");
    expect(w.findAll(".chip-mono").map((c) => c.text())).toContain("history");
  });
});
