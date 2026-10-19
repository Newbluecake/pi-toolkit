// @vitest-environment happy-dom
/**
 * `ui/src/components/shell/SettingsSessionsCard.vue` + `useLanSessions.ts` (LAN security r2
 * §3.2, package D): the 1B card against a scripted `LanSessionsDeps`. Asserts the frozen P0
 * handle contract: unsupported ⇒ renders nothing; one card per session with the current device
 * chip and no per-card revoke on it; revoke / armed revoke-others calls; the honest
 * 「部分未完成，请重试」 note when `complete:false`; error surfaces; dispose stops callbacks.
 */
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { describe, expect, it, vi } from "vitest";
import SettingsSessionsCard from "../../../src/web-hub/ui/src/components/shell/SettingsSessionsCard.vue";
import {
  useLanSessions,
  type LanSessionsDeps,
  type LanSessionsHandle,
} from "../../../src/web-hub/ui/src/composables/useLanSessions.js";
import type {
  LanSessionRevokeBody,
  LanSessionRevokeResponse,
  LanSessionsResponse,
  LanSessionWire,
} from "../../../src/web-hub/protocol/lan-sessions.js";

function session(over: Partial<LanSessionWire>): LanSessionWire {
  return {
    id: "A".repeat(16),
    current: false,
    createdAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_000_000,
    expiresAt: 1_700_000_000_000 + 720 * 60_000,
    absoluteExpiresAt: 1_700_000_000_000 + 7 * 24 * 3_600_000,
    createdIp: "192.168.32.38",
    ...over,
  };
}

function snap(sessions: LanSessionWire[]): LanSessionsResponse {
  return { idleMinutes: 720, absoluteDays: 7, max: 32, sessions };
}

const THREE = snap([
  session({ id: "C".repeat(16), current: true, ua: "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0.0.0 Safari/537.36" }),
  session({ id: "B".repeat(16), createdIp: "192.168.32.15", ua: "Mozilla/5.0 (iPhone) Version/26.0 Safari/604.1" }),
  session({ id: "A".repeat(16), createdIp: "192.168.32.51" }),
]);

interface Script {
  deps: LanSessionsDeps & { calls: Array<{ op: "list" | "revoke"; body?: LanSessionRevokeBody }> };
  revokeResults: LanSessionRevokeResponse[];
}

function scriptedDeps(opts: {
  enabled?: boolean;
  listResult?: () => Promise<LanSessionsResponse>;
  revokeResults?: LanSessionRevokeResponse[];
}): Script {
  const calls: Script["deps"]["calls"] = [];
  const revokeResults = [...(opts.revokeResults ?? [{ ok: true as const, revoked: 1, complete: true }])];
  const deps: Script["deps"] = {
    calls,
    enabled: () => opts.enabled ?? true,
    list: async () => {
      calls.push({ op: "list" });
      return (opts.listResult ?? (async () => THREE))();
    },
    revoke: async (body) => {
      calls.push({ op: "revoke", body });
      const r = revokeResults.shift();
      if (r === undefined) throw new Error("E_NETWORK");
      return r;
    },
  };
  return { deps, revokeResults };
}

function mountCard(deps: LanSessionsDeps) {
  const sessions: LanSessionsHandle = useLanSessions(deps);
  const wrapper = mount(SettingsSessionsCard, { props: { sessions } });
  return { wrapper, sessions };
}

async function flush(): Promise<void> {
  await nextTick();
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
}

describe("useLanSessions", () => {
  it("starts unsupported when the cap gate is off and never calls the transport", async () => {
    const { deps } = scriptedDeps({ enabled: false });
    const h = useLanSessions(deps);
    await flush();
    expect(h.phase.value).toBe("unsupported");
    expect(h.snapshot.value).toBeUndefined();
    await h.refresh();
    await h.revoke({ others: true });
    expect(deps.calls ?? []).toHaveLength(0);
    h.dispose();
  });

  it("loads on creation and exposes the snapshot", async () => {
    const { deps } = scriptedDeps({});
    const h = useLanSessions(deps);
    expect(h.phase.value).toBe("loading");
    await flush();
    expect(h.phase.value).toBe("ok");
    expect(h.snapshot.value?.sessions).toHaveLength(3);
    h.dispose();
  });

  it("a list failure flips to error; a later refresh recovers", async () => {
    let fail = true;
    const { deps } = scriptedDeps({
      listResult: async () => {
        if (fail) throw new Error("E_DB");
        return THREE;
      },
    });
    const h = useLanSessions(deps);
    await flush();
    expect(h.phase.value).toBe("error");
    fail = false;
    await h.refresh();
    expect(h.phase.value).toBe("ok");
    h.dispose();
  });

  it("records lastRevoke and re-lists after a successful revoke", async () => {
    const { deps } = scriptedDeps({ revokeResults: [{ ok: true, revoked: 2, complete: true }] });
    const h = useLanSessions(deps);
    await flush();
    await h.revoke({ others: true });
    expect(h.lastRevoke.value).toEqual({ ok: true, revoked: 2, complete: true });
    expect(deps.calls.map((c) => c.op)).toEqual(["list", "revoke", "list"]);
    h.dispose();
  });

  it("a revoke failure flips to error but keeps the last snapshot", async () => {
    const { deps } = scriptedDeps({ revokeResults: [] });
    const h = useLanSessions(deps);
    await flush();
    await h.revoke({ id: "B".repeat(16) });
    expect(h.phase.value).toBe("error");
    expect(h.snapshot.value?.sessions).toHaveLength(3);
    h.dispose();
  });

  it("dispose aborts in-flight work and ignores late results", async () => {
    let resolveList: ((v: LanSessionsResponse) => void) | undefined;
    const { deps } = scriptedDeps({
      listResult: () => new Promise((r) => (resolveList = r)),
    });
    const h = useLanSessions(deps);
    h.dispose();
    resolveList?.(THREE);
    await flush();
    expect(h.snapshot.value).toBeUndefined();
    // the late result is ignored: the phase never advances past the pre-dispose state
    expect(h.phase.value).not.toBe("ok");
  });
});

describe("SettingsSessionsCard", () => {
  it("renders nothing when unsupported", async () => {
    const { deps } = scriptedDeps({ enabled: false });
    const { wrapper } = mountCard(deps);
    await flush();
    expect(wrapper.find(".settings-sessions-card").exists()).toBe(false);
  });

  it("renders one card per session; current is chipped and has no revoke button", async () => {
    const { deps } = scriptedDeps({});
    const { wrapper } = mountCard(deps);
    await flush();
    const cards = wrapper.findAll(".session-card");
    expect(cards).toHaveLength(3);
    const current = wrapper.find(".session-card--current");
    expect(current.exists()).toBe(true);
    expect(current.find(".chip-current").exists()).toBe(true);
    expect(current.find(".btn-ghost").exists()).toBe(false);
    // device label parsed from UA; unknown UA falls back to the i18n string
    expect(cards[0]!.text()).toContain("Chrome 130 · Windows");
    expect(cards[1]!.text()).toContain("Safari 26 · iPhone");
    expect(cards[2]!.text().length).toBeGreaterThan(0);
    // count chip "3 / 32"
    expect(wrapper.find(".sessions-count").text()).toBe("3 / 32");
    // two non-current cards ⇒ two revoke buttons
    expect(wrapper.findAll(".session-card .btn-ghost")).toHaveLength(2);
  });

  it("per-card revoke sends {id}; revoke-others is a two-step armed confirm", async () => {
    const { deps } = scriptedDeps({
      revokeResults: [
        { ok: true, revoked: 1, complete: true },
        { ok: true, revoked: 2, complete: true },
      ],
    });
    const { wrapper } = mountCard(deps);
    await flush();
    await wrapper.findAll(".session-card .btn-ghost")[0]!.trigger("click");
    await flush();
    expect(deps.calls.find((c) => c.op === "revoke")?.body).toEqual({ id: "B".repeat(16) });

    const others = wrapper.find(".sessions-revoke-others");
    await others.trigger("click"); // arms
    expect(deps.calls.filter((c) => c.op === "revoke")).toHaveLength(1);
    await others.trigger("click"); // fires
    await flush();
    expect(deps.calls.filter((c) => c.op === "revoke").at(-1)?.body).toEqual({ others: true });
  });

  it("shows the partial note when the hub answers complete:false", async () => {
    const { deps } = scriptedDeps({ revokeResults: [{ ok: true, revoked: 5, complete: false }] });
    const { wrapper } = mountCard(deps);
    await flush();
    const others = wrapper.find(".sessions-revoke-others");
    await others.trigger("click");
    await others.trigger("click");
    await flush();
    const note = wrapper.find(".notice--warn");
    expect(note.exists()).toBe(true);
    expect(note.text()).toContain("5");
  });

  it("revoke-others is disabled when only the current session remains", async () => {
    const { deps } = scriptedDeps({ listResult: async () => snap([session({ current: true })]) });
    const { wrapper } = mountCard(deps);
    await flush();
    expect(wrapper.find(".sessions-revoke-others").attributes("disabled")).toBeDefined();
  });

  it("a load failure shows the alert with a retry that recovers", async () => {
    let fail = true;
    const { deps } = scriptedDeps({
      listResult: async () => {
        if (fail) throw new Error("E_DB");
        return THREE;
      },
    });
    const { wrapper } = mountCard(deps);
    await flush();
    const alert = wrapper.find("[role='alert']");
    expect(alert.exists()).toBe(true);
    fail = false;
    await alert.find("button").trigger("click");
    await flush();
    expect(wrapper.findAll(".session-card")).toHaveLength(3);
  });

  it("no v-html / no raw UA injection: UA text renders as plain text only", async () => {
    const evil = snap([
      session({ current: true, ua: "<img src=x onerror=alert(1)> Chrome/130.0.0.0 (Windows NT 10.0)" }),
    ]);
    const { deps } = scriptedDeps({ listResult: async () => evil });
    const { wrapper } = mountCard(deps);
    await flush();
    expect(wrapper.find(".session-card img").exists()).toBe(false);
    expect(wrapper.html()).not.toContain("<img src=x");
  });
});

describe("LAN-D integration follow-ups", () => {
  it("shows method metadata, legacy password fallback and disables every action during revoke", async () => {
    const { deps } = scriptedDeps({
      listResult: async () =>
        snap([
          session({ id: "A".repeat(16), current: true }),
          session({ id: "B".repeat(16), method: "totp" }),
          session({ id: "C".repeat(16), method: "feishu" }),
          session({ id: "D".repeat(16), method: "recovery" }),
        ]),
    });
    let finish!: (r: LanSessionRevokeResponse) => void;
    deps.revoke = vi.fn(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    const { wrapper, sessions } = mountCard(deps);
    await flush();
    expect(
      wrapper
        .findAll(".session-card-meta dd")
        .map((e) => e.text())
        .join(" "),
    ).toMatch(/密码|Password/);
    expect(wrapper.text()).toMatch(/TOTP/);
    expect(wrapper.text()).toMatch(/飞书|Feishu/);
    expect(wrapper.text()).toMatch(/恢复码|Recovery/);
    const button = wrapper.find(".session-card-top button");
    await button.trigger("click");
    await button.trigger("click");
    expect(deps.revoke).toHaveBeenCalledTimes(1);
    expect(wrapper.findAll("button").every((e) => e.attributes("disabled") !== undefined)).toBe(true);
    finish({ ok: true, revoked: 1, complete: true });
    await flush();
    expect(button.attributes("disabled")).toBeUndefined();
    wrapper.unmount();
    sessions.dispose();
  });
});
