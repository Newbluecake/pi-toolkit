// @vitest-environment happy-dom
/**
 * web-hub-version plan §4 / §5.3 (V2): `@logic/version-match.js` — every finding row, its
 * level/dot mapping, the 无法验证 (unverifiable) degradation, dirty semantics, the §6
 * old-hub fallbacks, and the per-finding DISAPPEARANCE conditions (each block asserts both
 * directions). `tabAssets` (build-stamp.js) is covered here too since it feeds §4's tab
 * identity.
 */
import { describe, expect, it } from "vitest";
import { tabAssets } from "../../../src/web-hub/ui/src/logic/build-stamp.js";
import {
  compareVersions,
  parseCommitRefLoose,
  parseHubUiFrame,
  sessionStatusOf,
  versionMatch,
} from "../../../src/web-hub/ui/src/logic/version-match.js";

const ASSETS_A = ["/assets/index-aaaa1111.js", "/assets/style-aaaa2222.css"];
const ASSETS_B = ["/assets/index-bbbb3333.js", "/assets/style-bbbb4444.css"];

const UI_BUILD = { version: "0.5.5", proto: { major: 1 }, commit: "aaaaaaa111111", builtAt: "2026-10-16T00:00:00Z" };

function hubFrame(over = {}) {
  return {
    version: "0.5.5",
    buildId: "0.5.5@aaaaaaa111111",
    pid: 4242,
    startedAt: 1_700_000_000_000,
    proto: { major: 1 },
    caps: ["version.v1"],
    ui: {
      source: "package",
      version: "0.5.5",
      commit: "aaaaaaa111111",
      builtAt: "2026-10-16T00:00:00Z",
      assets: ASSETS_A,
    },
    ...over,
  };
}

function snapshot(over = {}) {
  return {
    v: 1,
    checkedAt: 1_700_000_100,
    hub: { pid: 4242, startedAt: 1_700_000_000_000 },
    repo: {
      head: { commit: "aaaaaaa111111", time: 1_700_000_050, dirty: undefined },
      packageVersion: "0.5.5",
      lastTag: "v0.5.4",
      commits: [{ commit: "aaaaaaa111111", time: 1_700_000_050, subject: "chore: x" }],
      commitsTotal: 1,
    },
    ...over,
  };
}

function match(over = {}) {
  return versionMatch({
    uiBuild: UI_BUILD,
    tabAssets: ASSETS_A,
    hub: hubFrame(),
    snapshot: undefined,
    card: undefined,
    otherCards: [],
    ...over,
  });
}

const codes = (r) => r.findings.map((f) => f.code);

describe("version-match: parse helpers", () => {
  it("parseHubUiFrame narrows defensively", () => {
    const ui = parseHubUiFrame({
      source: "external",
      version: "1.0.0",
      commit: "abcdef1234567",
      builtAt: "t",
      assets: ["/assets/a.js", 5],
    });
    expect(ui).toEqual({
      source: "external",
      version: "1.0.0",
      commit: "abcdef1234567",
      builtAt: "t",
      assets: ["/assets/a.js"],
    });
    expect(parseHubUiFrame(null)).toBe(null);
    expect(parseHubUiFrame({ source: "weird", version: "1", commit: "abc" })).toBe(null);
    expect(parseHubUiFrame({ source: "package", version: "1" })).toBe(null); // no commit
  });

  it("parseCommitRefLoose accepts bare and decorated commits", () => {
    expect(parseCommitRefLoose({ commit: "abcdef1234567" })).toEqual({ commit: "abcdef1234567" });
    expect(parseCommitRefLoose({ commit: "0.5.5@abcdef1234567*" })).toEqual({ commit: "abcdef1234567", dirty: true });
    expect(parseCommitRefLoose({ commit: "abcdef1234567", dirty: true, time: 5 })).toEqual({
      commit: "abcdef1234567",
      time: 5,
      dirty: true,
    });
    expect(parseCommitRefLoose({ commit: "nogit" })).toBe(null);
    expect(parseCommitRefLoose("x")).toBe(null);
  });

  it("compareVersions: numeric dotted only, null on junk, zero-padded lengths", () => {
    expect(compareVersions("0.5.5", "0.5.5")).toBe(0);
    expect(compareVersions("0.5", "0.5.5")).toBe(-1);
    expect(compareVersions("0.6.0", "0.5.9")).toBe(1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(compareVersions("0.5.5-beta", "0.5.5")).toBe(null);
    expect(compareVersions("unknown", "0.5.5")).toBe(null);
    expect(compareVersions(undefined, "0.5.5")).toBe(null);
  });

  it("sessionStatusOf: outdated wins, semver then commit", () => {
    expect(sessionStatusOf({ outdated: true, pluginVersion: "0.5.5" }, "0.5.5", "0.5.5@aaaaaaa111111")).toBe("older");
    expect(sessionStatusOf({ pluginVersion: "0.5.4" }, "0.5.5", "0.5.5@aaaaaaa111111")).toBe("older");
    expect(sessionStatusOf({ pluginVersion: "0.6.0" }, "0.5.5", "0.5.5@aaaaaaa111111")).toBe("newer");
    expect(
      sessionStatusOf({ pluginVersion: "0.5.5", buildId: "0.5.5@aaaaaaa111111" }, "0.5.5", "0.5.5@aaaaaaa111111"),
    ).toBe("same");
    expect(
      sessionStatusOf({ pluginVersion: "0.5.5", buildId: "0.5.5@bbbbbbb222222" }, "0.5.5", "0.5.5@aaaaaaa111111"),
    ).toBe("differ");
    expect(sessionStatusOf({ pluginVersion: "0.5.5" }, "0.5.5", "0.5.5@aaaaaaa111111")).toBe("unknown"); // no buildId
    expect(sessionStatusOf({ pluginVersion: "0.5.5", buildId: "0.5.5@nogit" }, "0.5.5", "0.5.5@nogit")).toBe("unknown");
    expect(sessionStatusOf(undefined, "0.5.5", "x")).toBe("unknown");
  });
});

describe("version-match §4 rows", () => {
  it("baseline: everything equal ⇒ no findings, no dot, statuses 一致", () => {
    const r = match({
      snapshot: snapshot(),
      card: { pluginVersion: "0.5.5", buildId: "0.5.5@aaaaaaa111111", outdated: false },
    });
    expect(r.findings).toEqual([]);
    expect(r.dot).toBe(null);
    expect(r.dirty).toBe(false);
    expect(r.uiStatus).toBe("same");
    expect(r.sessionStatus).toBe("same");
    expect(r.tabStale).toBe(false);
  });

  // ---------------------------------------------------------------- tab-stale
  it("tab-stale: assets differ ⇒ warn finding + warn dot; equal assets ⇒ disappears", () => {
    const r = match({ hub: hubFrame({ ui: { ...hubFrame().ui, assets: ASSETS_B } }) });
    expect(codes(r)).toEqual(["tab-stale"]);
    expect(r.findings[0].level).toBe("warn");
    expect(r.dot).toBe("warn");
    expect(r.tabStale).toBe(true);
    expect(r.uiStatus).toBe("differ");

    const gone = match(); // identical assets
    expect(codes(gone)).toEqual([]);
    expect(gone.dot).toBe(null);
  });

  it("tab-stale fires on an assets-only rebuild: commit AND builtAt identical (fixed SOURCE_DATE_EPOCH / dirty rebuild)", () => {
    const rebuilt = { ...hubFrame().ui, assets: ASSETS_B }; // same version/commit/builtAt
    const r = match({ hub: hubFrame({ ui: rebuilt }) });
    expect(codes(r)).toEqual(["tab-stale"]);
  });

  it("tab-stale needs no snapshot and no cap — hub.ui alone is the evidence", () => {
    const r = match({ hub: hubFrame({ caps: [] }) });
    expect(codes(r)).toEqual([]); // assets equal here; the point is nothing ELSE degrades
  });

  // ---------------------------------------------------------------- ui-unservable
  it("hub.ui missing with cap ⇒ ui-unservable (warn), NOT tab-stale/refresh advice", () => {
    const r = match({ hub: hubFrame({ ui: undefined }) });
    expect(codes(r)).toEqual(["ui-unservable"]);
    expect(r.findings[0].level).toBe("warn");
    expect(r.dot).toBe("warn");
    expect(r.tabStale).toBe(false);
    expect(r.unverifiable).toContain("tab-stale");
  });

  it("proto.major differs with no hub.ui ⇒ ui-unservable even without the cap", () => {
    const r = match({ hub: hubFrame({ ui: undefined, caps: [], proto: { major: 2 } }) });
    expect(codes(r)).toEqual(["ui-unservable"]);
  });

  it("proto.major differs but hub.ui exists ⇒ NOT ui-unservable (§4's 且无 hub.ui)", () => {
    const r = match({ hub: hubFrame({ proto: { major: 2 } }) });
    expect(codes(r)).toEqual([]);
  });

  it("ui-unservable disappears once hub.ui reappears (restart served a root)", () => {
    const before = match({ hub: hubFrame({ ui: undefined }) });
    expect(codes(before)).toEqual(["ui-unservable"]);
    const after = match({}); // ui back, assets match
    expect(codes(after)).toEqual([]);
  });

  // ---------------------------------------------------------------- hub-disk-changed
  it("hub-disk-changed: repo.head vs bootHead differ ⇒ info (ui-drift legitimately co-fires — the served bundle also lags the new HEAD); equal ⇒ both disappear; either missing ⇒ unverifiable", () => {
    const hub = hubFrame({ bootHead: { commit: "aaaaaaa111111", time: 1 } });
    const r = match({
      hub,
      snapshot: snapshot({ repo: { ...snapshot().repo, head: { commit: "bbbbbbb222222", time: 2 } } }),
    });
    expect(codes(r)).toEqual(["hub-disk-changed", "ui-drift"]);
    expect(r.findings[0].level).toBe("info");
    expect(r.dot).toBe("info");

    const same = match({ hub, snapshot: snapshot() }); // same head
    expect(codes(same)).toEqual([]);

    const noBoot = match({ hub: hubFrame({ bootHead: undefined }), snapshot: snapshot() });
    expect(codes(noBoot)).toEqual([]);
    expect(noBoot.unverifiable).toContain("hub-disk-changed");
  });

  it("hub-disk-changed is deliberately NOT「旧于」wording — branch switches fire it too (R2 #4): a BACKWARD head also differs", () => {
    const hub = hubFrame({ bootHead: { commit: "ccccccc333333" } });
    const r = match({ hub, snapshot: snapshot() }); // repo.head aaaaaaa < boot ccc — still just "differ"
    expect(codes(r)).toEqual(["hub-disk-changed"]);
  });

  // ---------------------------------------------------------------- hub-older
  it("hub-older: repo.packageVersion semver > hub.version ⇒ info; equal ⇒ decided-negative (not unverifiable); missing ⇒ unverifiable", () => {
    const r = match({ snapshot: snapshot({ repo: { ...snapshot().repo, packageVersion: "0.6.0" } }) });
    expect(codes(r)).toEqual(["hub-older"]);
    expect(r.findings[0].level).toBe("info");

    const eq = match({ snapshot: snapshot() }); // 0.5.5 == 0.5.5
    expect(codes(eq)).toEqual([]);
    expect(eq.unverifiable).not.toContain("hub-older");

    const none = match({ snapshot: snapshot({ repo: { ...snapshot().repo, packageVersion: undefined } }) });
    expect(none.unverifiable).toContain("hub-older");
  });

  // ---------------------------------------------------------------- ui-drift
  it("ui-drift: served/tab commit vs (repo.head ?? hubCommit) differ ⇒ info; suppressed by tab-stale; unknown commits ⇒ unverifiable", () => {
    // hub.ui.commit aaaaaaa vs repo.head bbbbbbb
    const r = match({
      snapshot: snapshot({ repo: { ...snapshot().repo, head: { commit: "bbbbbbb222222", time: 2 } } }),
    });
    expect(codes(r)).toContain("ui-drift");

    // same ⇒ gone
    const same = match({ snapshot: snapshot() });
    expect(codes(same)).not.toContain("ui-drift");

    // tab-stale present ⇒ ui-drift suppressed (fingerprint is strictly better evidence)
    const stale = match({
      hub: hubFrame({ ui: { ...hubFrame().ui, assets: ASSETS_B } }),
      snapshot: snapshot({ repo: { ...snapshot().repo, head: { commit: "bbbbbbb222222", time: 2 } } }),
    });
    expect(codes(stale)).toEqual(["tab-stale"]);

    // npm tab (commit "unknown") with no hub.ui ⇒ the ui-drift pair is unparseable ⇒ unverifiable
    const npm = match({
      uiBuild: { ...UI_BUILD, commit: "unknown" },
      hub: hubFrame({ ui: undefined, caps: [] }),
      snapshot: snapshot(),
    });
    expect(codes(npm)).toEqual([]);
    expect(npm.unverifiable).toContain("ui-drift");
  });

  it("ui-drift with no snapshot falls back to hubCommit (bootHead ?? buildId) — the §6 old-hub comparison", () => {
    const r = match({ hub: hubFrame({ bootHead: undefined }) }); // hubCommit = buildId aaaaaaa = ui commit
    expect(codes(r)).not.toContain("ui-drift");
    const differ = match({
      hub: hubFrame({ ui: { ...hubFrame().ui, commit: "ddddddd444444" }, bootHead: undefined }),
    });
    expect(codes(differ)).toContain("ui-drift");
  });

  // ---------------------------------------------------------------- agent rows
  it("agent-older: card.outdated ⇒ info; disappears when outdated clears", () => {
    const card = { pluginVersion: "0.5.4", outdated: true };
    const r = match({ card });
    expect(codes(r)).toContain("agent-older");
    expect(r.sessionStatus).toBe("older");

    const gone = match({ card: { pluginVersion: "0.5.4", outdated: false } });
    expect(codes(gone)).not.toContain("agent-older");
  });

  it("agent-newer: newer managed agent ⇒ agent-newer (NOT agent-older); disappears at equal version", () => {
    const card = { pluginVersion: "0.6.0", buildId: "0.6.0@eeeeeee555555", outdated: false };
    const r = match({ card });
    expect(codes(r)).toContain("agent-newer");
    expect(codes(r)).not.toContain("agent-older");
    expect(codes(r)).not.toContain("agent-drift"); // different version ⇒ no drift claim
    expect(r.sessionStatus).toBe("newer");
    expect(r.dot).toBe("info");

    const eq = match({ card: { pluginVersion: "0.5.5", buildId: "0.5.5@aaaaaaa111111", outdated: false } });
    expect(codes(eq)).not.toContain("agent-newer");
  });

  it("agent-drift: same version, different buildId ⇒ info; missing card.buildId ⇒ unverifiable", () => {
    const r = match({ card: { pluginVersion: "0.5.5", buildId: "0.5.5@bbbbbbb222222", outdated: false } });
    expect(codes(r)).toEqual(["agent-drift"]);
    expect(r.sessionStatus).toBe("differ");

    const old = match({ card: { pluginVersion: "0.5.5", outdated: false } }); // old hub: no buildId
    expect(codes(old)).toEqual([]);
    expect(old.unverifiable).toContain("agent-drift");
    expect(old.sessionStatus).toBe("unknown");

    const gone = match({ card: { pluginVersion: "0.5.5", buildId: "0.5.5@aaaaaaa111111", outdated: false } });
    expect(codes(gone)).toEqual([]);
  });

  // ---------------------------------------------------------------- dirty
  it("dirty: same HEAD with a dirty side ⇒ dirty=true but NO dot (§8.7)", () => {
    const r = match({
      uiBuild: { ...UI_BUILD, commit: "aaaaaaa111111-dirty" },
      hub: hubFrame(),
    });
    expect(r.dirty).toBe(true);
    expect(r.dot).toBe(null);
    expect(codes(r)).toEqual([]);
  });

  it("dirty via hub buildId `*` spelling against a clean snapshot head", () => {
    const r = match({
      hub: hubFrame({ buildId: "0.5.5@aaaaaaa111111*", bootHead: undefined }),
      snapshot: snapshot(),
    });
    expect(r.dirty).toBe(true);
    expect(r.dot).toBe(null);
  });

  it("dirty disappears when every identity at that HEAD is clean", () => {
    const r = match({});
    expect(r.dirty).toBe(false);
  });

  // ---------------------------------------------------------------- 无法验证 / §6 old hub
  it("old hub (no cap/ui/bootHead/card.buildId): tab-stale/hub-disk-changed/hub-older/agent-drift unverifiable; ui-drift + agent semver still work; NO endpoint data used", () => {
    const hub = hubFrame({ caps: [], ui: undefined, bootHead: undefined });
    const r = match({
      hub,
      card: { pluginVersion: "0.5.5", outdated: false },
      snapshot: undefined,
    });
    expect(codes(r)).toEqual([]); // everything comparable agrees
    for (const c of ["tab-stale", "hub-disk-changed", "hub-older", "agent-drift"]) expect(r.unverifiable).toContain(c);
    expect(r.unverifiable).not.toContain("ui-drift"); // UI_BUILD.commit vs buildId — comparable

    // and the §6 fallbacks that DO fire on an old hub:
    const older = match({ hub, card: { pluginVersion: "0.5.4", outdated: true } });
    expect(codes(older)).toEqual(["agent-older"]);
    const driftOld = match({
      hub: hubFrame({ caps: [], ui: undefined, bootHead: undefined, buildId: "0.5.5@ddddddd444444" }),
    });
    expect(codes(driftOld)).toEqual(["ui-drift"]);
  });

  it("npm/nogit install: commit rules degrade to unverifiable and never light the dot", () => {
    const r = match({
      uiBuild: { ...UI_BUILD, commit: "unknown" },
      hub: hubFrame({ buildId: "0.5.5@nogit", ui: undefined, bootHead: undefined, caps: ["version.v1"] }),
      snapshot: snapshot({ repo: undefined }),
    });
    expect(codes(r)).toEqual(["ui-unservable"]); // cap present + no hub.ui — the one rule that still fires
    expect(r.hubCommit).toBe("0.5.5@nogit"); // raw spelling kept for display; every comparison on it is unknown
    expect(r.sessionStatus).toBe("unknown");
    expect(r.dot).toBe("warn"); // from ui-unservable only — the commit rules contributed nothing
    const clean = match({
      uiBuild: { ...UI_BUILD, commit: "unknown" },
      hub: hubFrame({ buildId: "0.5.5@nogit", bootHead: undefined, caps: [] }),
      snapshot: snapshot({ repo: undefined }),
    });
    expect(codes(clean)).toEqual([]);
    expect(clean.dot).toBe(null);
  });

  // ---------------------------------------------------------------- dot + summary
  it("dot precedence: warn beats info; 无法验证 never lights anything", () => {
    const both = match({
      hub: hubFrame({ ui: undefined }), // ui-unservable warn
      card: { pluginVersion: "0.5.5", buildId: "0.5.5@bbbbbbb222222", outdated: false }, // agent-drift info
    });
    expect(both.dot).toBe("warn");
    const infoOnly = match({ card: { pluginVersion: "0.5.5", buildId: "0.5.5@bbbbbbb222222", outdated: false } });
    expect(infoOnly.dot).toBe("info");
  });

  it("summary counts OTHER sessions only (older/newer/drift), one line's worth — never dots", () => {
    const r = match({
      card: { pluginVersion: "0.5.5", buildId: "0.5.5@aaaaaaa111111", outdated: false },
      otherCards: [
        { pluginVersion: "0.5.4", outdated: true },
        { pluginVersion: "0.5.4", outdated: false }, // older by semver, no outdated flag
        { pluginVersion: "0.6.0", outdated: false },
        { pluginVersion: "0.5.5", buildId: "0.5.5@bbbbbbb222222", outdated: false },
        { pluginVersion: "0.5.5", buildId: "0.5.5@aaaaaaa111111", outdated: false }, // clean
      ],
    });
    expect(r.summary).toEqual({ older: 2, newer: 1, drift: 1 });
    expect(r.dot).toBe(null); // other sessions never light the chip dot (§4)
  });

  it("defensive: null/garbage inputs never throw and read as unverifiable", () => {
    const r = versionMatch({
      uiBuild: undefined,
      tabAssets: undefined,
      hub: null,
      snapshot: "junk",
      card: 5,
      otherCards: null,
    });
    expect(r.findings).toEqual([]);
    expect(r.dot).toBe(null);
    expect(r.uiStatus).toBe("unknown");
    expect(r.sessionStatus).toBe("unknown");
  });
});

describe("build-stamp tabAssets (§4 tab identity)", () => {
  it("collects + sorts + dedupes module scripts and stylesheets under /assets/", () => {
    const script = document.createElement("script");
    script.type = "module";
    script.setAttribute("src", "/assets/index-zzz9999.js");
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.setAttribute("href", "/assets/style-aaa1111.css");
    document.head.append(script, link);
    try {
      expect(tabAssets(document)).toEqual(["/assets/index-zzz9999.js", "/assets/style-aaa1111.css"]);
    } finally {
      script.remove();
      link.remove();
    }
  });

  it("null when nothing matches (dev server paths) — unknown, not empty-equal", () => {
    const script = document.createElement("script");
    script.type = "module";
    script.setAttribute("src", "/src/main.ts");
    document.head.append(script);
    try {
      expect(tabAssets(document)).toBe(null);
    } finally {
      script.remove();
    }
  });

  it("null for a missing document", () => {
    expect(tabAssets(null)).toBe(null);
  });
});
