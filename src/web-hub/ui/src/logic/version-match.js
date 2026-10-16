/**
 * web-hub-version plan §4 (V2, pure logic): the UI↔hub↔agent version/compat matcher behind the
 * top-bar version chip's dot and the version panel's 「建议」 section. DOM-free, Vue-free,
 * never throws — every input is defensively narrowed exactly like `@logic/agents.js` treats
 * raw `AgentCard`s (the hub frame arrives as a wholesale-mirrored `Record<string, unknown>`,
 * `AgentState.card`; an old hub simply lacks `ui`/`bootHead`/`card.buildId` and those checks
 * degrade to "unverifiable", never to "一致").
 *
 * Status terms (plan §4): 一致 (same) / 不一致 (differ — commit evidence only, direction
 * unknown) / 旧于 (older — ONLY with ordering evidence: semver, or the R2-split
 * boot-vs-disk rules) / 无法验证 (unknown — never lights the dot, never shown as 一致).
 *
 * The finding codes are the §4 table verbatim:
 *   tab-stale         hub.ui.assets ≠ tab.assets (content fingerprint — catches dirty /
 *                     fixed-builtAt rebuilds)                        → warn, 「刷新页面」
 *   ui-unservable     cap present but no hub.ui, or proto differs    → warn, /webhub restart
 *   hub-disk-changed  snapshot repo.head vs hub.bootHead differ (branch switches fire too —
 *                     deliberately NOT called 「旧于」, R2 #4)         → info, /webhub restart
 *   hub-older         repo.packageVersion semver > hub.version (the ONE ordering proof) → info
 *   ui-drift          no tab-stale; ui commit vs (repo.head ?? hubCommit) differ → info
 *   agent-older       card.outdated === true                          → info, /reload
 *   agent-newer       card.pluginVersion semver > hub.version (managed agents bypass
 *                     supersede — this is NOT agent-older/「/reload」) → info, /webhub restart
 *   agent-drift       same version && compareCommit(card.buildId, hubCommit) differ → info
 *   dirty             any two identities share a commit while at least one is dirty — panel
 *                     info only, NEVER a dot (bundle deltas are tab-stale's fingerprint's job)
 *
 * `hubCommit` per §4 is `bootHead ?? buildId`. Findings render in the table's order above.
 */
import { compareCommit, normalizeCommit } from "@protocol/version-info.ts";

/** @typedef {import("@protocol/version-info.ts").VersionInfoWire} VersionInfoWire */
/** @typedef {import("@protocol/version-info.ts").HubUiBuildWire} HubUiBuildWire */

/**
 * @typedef {object} VersionMatchFinding
 * @property {string} code   one of the §4 table codes above
 * @property {"warn" | "info"} level
 */

/**
 * @typedef {object} VersionMatchResult
 * @property {boolean} cap                    hub frame advertises `version.v1`
 * @property {HubUiBuildWire | null} hubUi    defensively parsed `hub.ui` (null when absent/malformed)
 * @property {{ commit: string, time?: number, dirty?: true } | null} bootHead  parsed `hub.bootHead`
 * @property {string | undefined} hubCommit   `bootHead ?? buildId` raw spelling (§4)
 * @property {VersionMatchFinding[]} findings actionable 「建议」 rows, §4 table order
 * @property {boolean} dirty                  「工作树有未提交改动」 info row (never a dot)
 * @property {boolean} tabStale               §4-PROVEN tab-stale (VersionLoadError's 「已过期」 gate)
 * @property {"same" | "differ" | "unknown"} uiStatus        tab bundle vs served bundle (§4 terms)
 * @property {"same" | "older" | "newer" | "differ" | "unknown"} sessionStatus  selected card vs hub
 * @property {string[]} unverifiable          checks that could not run (missing inputs / old hub)
 * @property {null | "warn" | "info"} dot     the chip dot; null when nothing provable
 * @property {{ older: number, newer: number, drift: number }} summary  OTHER sessions' counts (§4:
 *                                             one aggregated line, never extra dots)
 */

/** @param {unknown} v @returns {string | undefined} non-empty string or undefined */
function str(v) {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** @param {unknown} v @returns {string[] | undefined} */
function strArray(v) {
  if (!Array.isArray(v)) return undefined;
  const out = [];
  for (const x of v) if (typeof x === "string" && x !== "") out.push(x);
  return out;
}

/** @param {unknown} v @returns {boolean} */
function isObj(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Defensive `HubInfo.ui` parse (the hub frame is a wholesale mirror — an old hub has no `ui`,
 * a malformed one must degrade to "absent", never throw). Shape per `HubUiBuildWire`.
 * @param {unknown} v
 * @returns {HubUiBuildWire | null}
 */
export function parseHubUiFrame(v) {
  if (!isObj(v)) return null;
  const source = v["source"] === "package" || v["source"] === "external" ? v["source"] : null;
  const version = str(v["version"]);
  const commit = str(v["commit"]);
  if (source === null || version === undefined || commit === undefined) return null;
  const assets = strArray(v["assets"]) ?? [];
  return { source, version, commit, builtAt: str(v["builtAt"]) ?? "", assets };
}

/**
 * Defensive `HubInfo.bootHead` / `VersionRepoWire.head` parse (`CommitRef`): accepts the bare
 * hex the wire specifies AND leniently re-normalizes decorated spellings via `normalizeCommit`.
 * @param {unknown} v
 * @returns {{ commit: string, time?: number, dirty?: true } | null}
 */
export function parseCommitRefLoose(v) {
  if (!isObj(v)) return null;
  const n = normalizeCommit(v["commit"]);
  if (n === null) return null;
  /** @type {{ commit: string, time?: number, dirty?: true }} */
  const ref = { commit: n.hex };
  if (n.dirty) ref.dirty = true;
  const time = v["time"];
  if (typeof time === "number" && Number.isFinite(time) && time >= 0) ref.time = time;
  if (v["dirty"] === true) ref.dirty = true;
  return ref;
}

/**
 * Strict-ish semver comparator for plain dotted-numeric versions (`0.5.5`). Non-numeric
 * segments (prerelease text, garbage) ⇒ `null` = unknown — callers must treat that as
 * 「无法验证」, never as equality.
 * @param {unknown} a @param {unknown} b @returns {-1 | 0 | 1 | null}
 */
export function compareVersions(a, b) {
  if (typeof a !== "string" || typeof b === "undefined" || typeof b !== "string") return null;
  const pa = a.split(".");
  const pb = b.split(".");
  if (pa.length === 0 || pb.length === 0) return null;
  const na = [];
  const nb = [];
  for (const part of pa) {
    if (!/^\d+$/.test(part)) return null;
    na.push(Number(part));
  }
  for (const part of pb) {
    if (!/^\d+$/.test(part)) return null;
    nb.push(Number(part));
  }
  const n = Math.max(na.length, nb.length);
  for (let i = 0; i < n; i++) {
    const x = na[i] ?? 0;
    const y = nb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** @param {string[] | null | undefined} a @param {string[] | null | undefined} b @returns {boolean} */
function assetsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * §4 status of the selected session's card vs the hub. `older` FIRST via the hub-side
 * `outdated` flag (works on old hubs), then semver; equal versions fall through to the commit
 * comparison — `differ` needs BOTH ids (same version, different commit), `unknown` when either
 * commit is unusable (old hub without `card.buildId`, `nogit`).
 * @param {Record<string, unknown> | undefined} card
 * @param {string | undefined} hubVersion
 * @param {string | undefined} hubCommit
 * @returns {"same" | "older" | "newer" | "differ" | "unknown"}
 */
export function sessionStatusOf(card, hubVersion, hubCommit) {
  if (card === undefined || hubVersion === undefined) return "unknown";
  if (card["outdated"] === true) return "older";
  const pv = str(card["pluginVersion"]);
  if (pv === undefined) return "unknown";
  const cmp = compareVersions(pv, hubVersion);
  if (cmp === null) return "unknown";
  if (cmp < 0) return "older";
  if (cmp > 0) return "newer";
  const cb = str(card["buildId"]);
  if (cb === undefined || hubCommit === undefined) return "unknown";
  const cc = compareCommit(cb, hubCommit);
  return cc === "same" ? "same" : cc === "differ" ? "differ" : "unknown";
}

/**
 * The §4 matcher. All inputs optional/defensive; the result is a plain frozen-ish object
 * (never throws, safe to recompute on every reactive tick — allocation-light by design).
 *
 * @param {{
 *   uiBuild?: { version?: unknown, proto?: { major?: unknown }, commit?: unknown, builtAt?: unknown },
 *   tabAssets?: string[] | null,
 *   hub?: Record<string, unknown> | null,
 *   snapshot?: VersionInfoWire | undefined,
 *   card?: Record<string, unknown> | undefined,
 *   otherCards?: Iterable<Record<string, unknown>>,
 * }} input
 * @returns {VersionMatchResult}
 */
export function versionMatch(input) {
  const uiBuild = isObj(input?.uiBuild) ? input.uiBuild : {};
  const uiProto = isObj(uiBuild["proto"]) ? uiBuild["proto"] : {};
  const tabAssets = Array.isArray(input?.tabAssets) ? input.tabAssets : null;
  const hub = isObj(input?.hub) ? input.hub : null;
  const snapshot = isObj(input?.snapshot) ? input.snapshot : undefined;
  const card = isObj(input?.card) ? input.card : undefined;

  const capsRaw = Array.isArray(hub?.["caps"]) ? hub["caps"] : [];
  const cap = capsRaw.includes("version.v1");
  const hubUi = parseHubUiFrame(hub?.["ui"]);
  const bootHead = parseCommitRefLoose(hub?.["bootHead"]);
  const hubCommit = bootHead !== null ? bootHead.commit : str(hub?.["buildId"]);
  const hubVersion = str(hub?.["version"]);

  // snapshot.repo success form ({error} form carries no comparable data)
  const repoRaw = snapshot !== undefined ? snapshot["repo"] : undefined;
  const repo = isObj(repoRaw) && repoRaw["error"] === undefined ? repoRaw : undefined;
  const repoHead = parseCommitRefLoose(repo?.["head"]);

  // ------------------------------------------------------------------ conditions
  let tabStale = false;
  if (hubUi !== null) {
    if (tabAssets === null)
      tabStale = false; // unknown tab fingerprint — no claim either way
    else if (!assetsEqual(hubUi.assets, tabAssets)) tabStale = true;
  }

  const hubProtoMajor =
    isObj(hub?.["proto"]) && typeof hub["proto"]["major"] === "number" ? hub["proto"]["major"] : undefined;
  const tabProtoMajor = typeof uiProto["major"] === "number" ? uiProto["major"] : undefined;
  const protoDiffers = hubProtoMajor !== undefined && tabProtoMajor !== undefined && hubProtoMajor !== tabProtoMajor;
  // §4: hub.ui missing while the cap exists (no servable root), OR proto differs with no hub.ui
  const uiUnservable = hubUi === null && (cap || protoDiffers);

  const hubDiskChanged =
    repoHead !== null && bootHead !== null && compareCommit(repoHead.commit, bootHead.commit) === "differ";

  const pkgVersion = str(repo?.["packageVersion"]);
  let hubOlder = false;
  if (pkgVersion !== undefined && hubVersion !== undefined) {
    const cmp = compareVersions(pkgVersion, hubVersion);
    hubOlder = cmp !== null && cmp > 0;
  }

  // ui-drift: suppressed by tab-stale (the fingerprint is strictly better evidence); the
  // served-side commit wins the tab's own (what the hub ships is what a refresh would get).
  let uiDrift = false;
  if (!tabStale) {
    const left = hubUi !== null ? hubUi.commit : str(uiBuild["commit"]);
    const right = repoHead !== null ? repoHead.commit : hubCommit;
    if (left !== undefined && right !== undefined && compareCommit(left, right) === "differ") uiDrift = true;
  }

  const agentOlder = card !== undefined && card["outdated"] === true;
  let agentNewer = false;
  let agentDrift = false;
  if (card !== undefined && hubVersion !== undefined) {
    const pv = str(card["pluginVersion"]);
    if (pv !== undefined) {
      const cmp = compareVersions(pv, hubVersion);
      if (cmp !== null && cmp > 0) agentNewer = true;
      else if (cmp === 0) {
        const cb = str(card["buildId"]);
        if (cb !== undefined && hubCommit !== undefined && compareCommit(cb, hubCommit) === "differ") agentDrift = true;
      }
    }
  }

  // dirty: any two identities share a commit while at least one is dirty (§4: info only).
  /** @type {{ hex: string, dirty: boolean }[]} */
  const ids = [];
  const collect = (raw) => {
    const n = normalizeCommit(raw);
    if (n !== null) ids.push(n);
  };
  collect(uiBuild["commit"]);
  if (hubUi !== null) collect(hubUi.commit);
  collect(hub?.["buildId"]);
  if (bootHead !== null) collect(bootHead.commit);
  if (repoHead !== null) collect(repoHead.commit);
  if (card !== undefined) collect(card["buildId"]);
  let dirty = false;
  outer: for (let i = 0; i < ids.length && !dirty; i++) {
    if (!ids[i].dirty) continue;
    for (let j = 0; j < ids.length; j++) {
      if (i === j) continue;
      const n = Math.min(ids[i].hex.length, ids[j].hex.length);
      if (ids[i].hex.slice(0, n) === ids[j].hex.slice(0, n)) {
        dirty = true;
        break outer;
      }
    }
  }

  // ------------------------------------------------------------------ findings (§4 table order)
  /** @type {VersionMatchFinding[]} */
  const findings = [];
  if (tabStale) findings.push({ code: "tab-stale", level: "warn" });
  if (uiUnservable) findings.push({ code: "ui-unservable", level: "warn" });
  if (hubDiskChanged) findings.push({ code: "hub-disk-changed", level: "info" });
  if (hubOlder) findings.push({ code: "hub-older", level: "info" });
  if (uiDrift) findings.push({ code: "ui-drift", level: "info" });
  if (agentOlder) findings.push({ code: "agent-older", level: "info" });
  if (agentNewer) findings.push({ code: "agent-newer", level: "info" });
  if (agentDrift) findings.push({ code: "agent-drift", level: "info" });

  let dot = null;
  for (const f of findings) {
    if (f.level === "warn") {
      dot = "warn";
      break;
    }
    dot = "info";
  }

  // ------------------------------------------------------------------ unverifiable bookkeeping
  // Which §4 checks could not run (missing inputs / old hub). The panel renders these as gray
  // 无法验证 ONLY in their natural section (uiStatus / sessionStatus); the array itself is
  // data for tests and never implies 「一致」.
  /** @type {string[]} */
  const unverifiable = [];
  if (!tabStale && (hubUi === null || tabAssets === null)) unverifiable.push("tab-stale");
  if (repoHead === null || bootHead === null) unverifiable.push("hub-disk-changed");
  // hub-older: unverifiable only when the semver pair cannot be compared at all (missing
  // inputs / non-numeric); a decided "not older" is a verified negative, never unverifiable.
  if (pkgVersion === undefined || hubVersion === undefined || compareVersions(pkgVersion, hubVersion) === null)
    unverifiable.push("hub-older");
  if (!uiDrift && !tabStale) {
    const l = hubUi !== null ? hubUi.commit : str(uiBuild["commit"]);
    const r = repoHead !== null ? repoHead.commit : hubCommit;
    if (l === undefined || r === undefined || compareCommit(l, r) === "unknown") unverifiable.push("ui-drift");
  }
  if (card !== undefined && hubVersion !== undefined && !agentDrift && !agentNewer) {
    const pv = str(card["pluginVersion"]);
    if (pv !== undefined && compareVersions(pv, hubVersion) === 0 && str(card["buildId"]) === undefined)
      unverifiable.push("agent-drift");
  }

  // ------------------------------------------------------------------ other-session summary (§4)
  const summary = { older: 0, newer: 0, drift: 0 };
  for (const c of input?.otherCards ?? []) {
    if (!isObj(c)) continue;
    if (c["outdated"] === true) {
      summary.older += 1;
      continue;
    }
    const pv = str(c["pluginVersion"]);
    if (pv === undefined || hubVersion === undefined) continue;
    const cmp = compareVersions(pv, hubVersion);
    if (cmp === null) continue;
    if (cmp < 0) {
      // same evidence class as the selected session's `older` (sessionStatusOf counts
      // semver-older even without the hub-side outdated flag)
      summary.older += 1;
      continue;
    }
    if (cmp > 0) {
      summary.newer += 1;
      continue;
    }
    const cb = str(c["buildId"]);
    if (cb !== undefined && hubCommit !== undefined && compareCommit(cb, hubCommit) === "differ") summary.drift += 1;
  }

  const uiStatus =
    hubUi === null || tabAssets === null ? "unknown" : assetsEqual(hubUi.assets, tabAssets) ? "same" : "differ";

  return {
    cap,
    hubUi,
    bootHead,
    hubCommit,
    findings,
    dirty,
    tabStale,
    uiStatus,
    sessionStatus: sessionStatusOf(card, hubVersion, hubCommit),
    unverifiable,
    dot,
    summary,
  };
}
