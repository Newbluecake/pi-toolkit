import { SCHED_CONFIRM_CAP, SCHED_HUB_CAP } from "../protocol/schedule.js";
import {
  AVATAR_HUB_CAP,
  CMD_ARGS_HUB_CAPS,
  CMD_HISTORY_HUB_CAPS,
  FSB_HUB_CAP,
  LAN_SESSIONS_HUB_CAP,
  PREVIEW_ABS_HUB_CAP,
  PREVIEW_CHUNK_HUB_CAP,
  PREVIEW_DIR_HUB_CAP,
  PREVIEW_DOWNLOAD_HUB_CAP,
  PREVIEW_HTML_HUB_CAP,
  PREVIEW_HUB_CAP,
  PREVIEW_LAN_HUB_CAP,
  PREVIEW_TILDE_HUB_CAP,
  PRIVACY_HUB_CAP,
  PROXY_FRAME_HUB_CAP,
  PROXY_HUB_CAP,
  PROXY_LAN_HUB_CAP,
  SPAWN_HISTORY_HUB_CAP,
  SPAWN_HUB_CAP,
  SPAWN_MODEL_HUB_CAP,
  SPAWN_RELAUNCH_HUB_CAP,
  VERSION_HUB_CAP,
  WTDIFF_HUB_CAP,
  WTGRAPH_HUB_CAP,
  WTGRAPH_MERGED_HUB_CAP,
  WTGRAPH_FILES_HUB_CAP,
} from "../protocol/version.js";
import {
  XS_ALIAS_HUB_CAP,
  XS_ALIAS_V2_HUB_CAP,
  XS_CHANNEL_HUB_CAP,
  XS_HUB_CAP,
  XS_REPLY_HUB_CAP,
} from "../protocol/xs.js";
import type { HubAssembly } from "./assembly.js";
import { hubLoadProbe, LOAD_HUB_CAP, normalizeHubLoadConfig } from "./load.js";
import { previewProcFdAvailable } from "./preview/fs.js";
import { probePlatform } from "./spawn/config.js";
import { createXsAliasBinding, createXsRelay, hubXsAliasParamsOf } from "./xs/router.js";

/** Probe and begin the alias load at their original pre-registry phase. No promise is
 * returned on the off path, so the root adds no await there. */
export function prepareHubChannels(ctx: HubAssembly): Promise<void> | undefined {
  const { config, deps, paths, log, now, startupStep, cleanup } = ctx;
  // web-hub-spawn plan §SP10 (arch §7.1): `spawn.v1` rides BOTH cap surfaces whenever
  // `config.spawn` exists — even when the platform probe or launcher check failed (the UI
  // needs the cap to explain WHY spawn is unavailable, `GET /api/headless` carries the
  // `policy.reason`). Absent (feature off) ⇒ caps stay byte-identical to pre-SP10.
  // web-hub-spawn default-model plan §2/D4: `spawn.model.v1` joins the SAME conditional tail
  // (prefs endpoint + `model` tri-state + the record vocabulary) — an old browser ignores the
  // unknown string (`caps.includes`), and a browser without it MUST NOT send `model` anywhere
  // (the pre-feature schema is `additionalProperties:false` ⇒ an old hub would 400).
  // web-hub-preview plan v3 §4.1/§4.7 (PV3): the two preview caps ride the same two surfaces
  // (同源数组展开，集合与顺序一致 — the §4.7 "两处声明的集合必须一致" invariant; the two consumers
  // each SPREAD this one source array, so they are not the same array instance, but the sets
  // and order can never drift): `preview.v1` whenever `config.preview` exists (mode loopback
  // OR on), `preview.lan.v1` only when mode is on. Absent (mode off) ⇒ caps stay
  // byte-identical to pre-PV3.
  // dir-plan v3.1 §2.2/§1.2 (P1a): `PREVIEW_ABS_HUB_CAP` rides the SAME `preview.v1` feature
  // gate (the mere presence of `config.preview`) — global-path admission is not a separate
  // setting, and the cap's only job is telling the UI it may widen recognition (C4).
  // dir-plan §3.5/§3.6 (P1b): `PREVIEW_DIR_HUB_CAP` rides the same gate AND the /proc probe —
  // the listing itself is `/proc/self/fd`-bound, so a platform without /proc never declares
  // it (the UI then never sends `dir=1` / `dirs:true`, and directories stay 415 fail-closed).
  //
  // session-history plan §4.8 (P-int): `SPAWN_HISTORY_HUB_CAP` rides the SAME conditional tail
  // as `spawn.v1`/`spawn.model.v1`, but demands more — `config.spawn.history === true` AND the
  // platform probe passing. The probe is hoisted HERE (before the caps array) because the
  // spawn assembly further down used to run it itself; both read the one `spawnPlatform`
  // value now, so the cap and the fail-closed supervisor can never disagree. Absent/off ⇒
  // caps stay byte-identical to pre-feature (§5).
  ctx.spawnPlatform = config.spawn === undefined ? undefined : probePlatform(deps.spawnSeams?.probe);
  // web-hub-html-preview plan v2 §4: ONE value read by the cap declaration below AND the
  // `createPreviewRoutes({ html })` attachment further down, so they can never disagree.
  ctx.htmlEnabled = config.preview !== undefined && previewProcFdAvailable();
  // Alias-plan AL2 (§3.3/§3.6, key-absent convention): the binding table exists iff
  // `config.crossSession.alias` exists (absent ⇒ no table, no file IO, no cap — byte-identical).
  // It is LOADED here, before the cap array (`xs.alias.v1` iff the load came back `ready`, fixed for
  // the run) and long before `createAgentServer` lets any xs request in. `degraded` never touches
  // the file and only logs; recovery is a human fixing/moving the file + `/webhub restart`.
  const xsAliasParams = hubXsAliasParamsOf(config.crossSession);
  if (xsAliasParams !== undefined) {
    const binding = createXsAliasBinding({ stateDir: paths.stateDir, params: xsAliasParams, log, now });
    ctx.xsAlias = binding;
    cleanup.push(async () => binding.store.close());
    return startupStep(binding.store.load()).then((loaded) => {
      if (loaded.state === "degraded") {
        const path = binding.store.status().path;
        log.warn("xs alias store degraded", { reason: loaded.reason, path });
        ctx.xsAliasDegraded = { reason: String(loaded.reason), path };
      }
    });
  }
  return undefined;
}

export function assembleHubCaps(ctx: HubAssembly): readonly string[] {
  const { config, spawnPlatform, htmlEnabled, xsAlias } = ctx;
  const extraHubCaps: readonly string[] = [
    ...(config.cmdArgs === "all" || config.cmdArgs === "toolkit" ? CMD_ARGS_HUB_CAPS : []),
    // cmd-history plan §4.6 (F4, H1): `cmd.history.v1` is UNCONDITIONAL on the hub — the P0
    // projection and the §4.10 runTail ENOENT fallback ship with every hub build (the
    // fallback deliberately ignores the agent's cmdHistory setting, M4/R9), so the cap has
    // no settings gate; it only tells new agents/UIs this hub understands them (the agent's
    // matching `StatusInfo.features` token gates the feature itself). Old hubs never
    // declare it ⇒ the UI stays in legacy mode. Both cap surfaces share this one array.
    ...CMD_HISTORY_HUB_CAPS,
    // web-hub-version plan §3.7: unconditional (no settings gate, D3) — the service below is
    // always constructed, so the cap and the route can never disagree.
    VERSION_HUB_CAP,
    ...(config.lan === undefined ? [] : [LAN_SESSIONS_HUB_CAP]),
    ...(config.spawn === undefined
      ? []
      : [
          SPAWN_HUB_CAP,
          SPAWN_MODEL_HUB_CAP,
          ...(config.spawn.history === true && spawnPlatform?.ok === true ? [SPAWN_HISTORY_HUB_CAP] : []),
          // spawn-relaunch: `POST /api/headless/relaunch` reuses the restore machinery (L6
          // death confirmation is /proc-bound), so the cap demands BOTH the restore config
          // flag AND the platform probe — a hub without it 404s the route like a restore-off
          // hub does (the UI renders no relaunch affordance without the cap anyway).
          ...(config.spawn.restore === true && spawnPlatform?.ok === true ? [SPAWN_RELAUNCH_HUB_CAP] : []),
        ]),
    ...(config.preview === undefined
      ? []
      : [
          PREVIEW_HUB_CAP,
          PREVIEW_ABS_HUB_CAP,
          PREVIEW_TILDE_HUB_CAP,
          // preview-download: rides the SAME `config.preview` gate as ABS/TILDE (the
          // admission chain is fd-agnostic — no /proc dependency, unlike DIR above).
          PREVIEW_DOWNLOAD_HUB_CAP,
          // chunked-plan §3.4/§2.4: `preview.chunk.v1` rides the SAME `config.preview` gate
          // too (continuations re-walk the full admission chain — fd-agnostic, no /proc
          // condition); both cap surfaces share this one array, so §4.7 holds by construction.
          PREVIEW_CHUNK_HUB_CAP,
          ...(previewProcFdAvailable() ? [PREVIEW_DIR_HUB_CAP] : []),
          // worktree-diff D21: `wtdiff.v1` rides the SAME preview gate AND the /proc probe —
          // the three-fd pin is /proc-bound, so a platform without it never declares the cap
          // (and hub.ts below never builds the routes at all).
          ...(previewProcFdAvailable() ? [WTDIFF_HUB_CAP] : []),
          // worktree-graph plan v2 §3/§2.6: `wtgraph.v1` rides the SAME gate as `wtdiff.v1`
          // (「与 wtdiff 同门」— same `config.preview` existence AND /proc probe); LAN availability
          // rides `PREVIEW_LAN_HUB_CAP` below, same width as preview/wtdiff (§0.2 Q1).
          // merged-plan §6: `wtgraph.merged.v1` — the SAME condition as `wtgraph.v1` (preview + /proc);
          // LAN width rides `PREVIEW_LAN_HUB_CAP` below (mode `loopback` ⇒ LAN 404, no new setting).
          ...(previewProcFdAvailable() ? [WTGRAPH_HUB_CAP, WTGRAPH_MERGED_HUB_CAP] : []),
          // wtgraph.files.v1: the per-commit file list — SAME gate as wtgraph.v1 (the routes are
          // built exactly then and always carry `handleFiles`); LAN width rides preview.lan.v1.
          ...(previewProcFdAvailable() ? [WTGRAPH_FILES_HUB_CAP] : []),
          // web-hub-html-preview plan v2 §4 (P1b): `preview.html.v1` rides the SAME
          // `config.preview` gate AND the /proc probe (`htmlEnabled` — dir-fd anchoring is
          // /proc-bound, fail-closed); both cap surfaces share this one array. LAN width rides
          // `preview.lan.v1` below (mode `loopback` ⇒ LAN mint + /pv + /pvw 404).
          ...(htmlEnabled ? [PREVIEW_HTML_HUB_CAP] : []),
        ]),
    ...(config.preview === "on" ? [PREVIEW_LAN_HUB_CAP] : []),
    // web-hub-avatar plan v2.1 §4.2: the one hub-declared cap is carried through
    // extraHubCaps onto both HubInfo.caps and hello_ack.caps. Agent sessions do not
    // advertise a corresponding capability of their own.
    ...(config.avatar === true ? [AVATAR_HUB_CAP] : []),
    // web-hub-privacy plan v2.1 (P1): `privacy.v1` rides the SAME two surfaces through this
    // one array (评审 #10: HubInfo.caps 与 hello_ack.caps 两面同源) whenever
    // `config.privacy` exists. STATIC — it never follows whether the LAN listener came up.
    ...(config.privacy === true ? [PRIVACY_HUB_CAP] : []),
    // sysload P3: the hub-side sampler is available only after the bounded Linux
    // startup probe.  Feature-off (absent config.load) keeps every cap surface
    // byte-identical.
    ...(config.load !== undefined && normalizeHubLoadConfig(config.load) !== undefined && hubLoadProbe()
      ? [LOAD_HUB_CAP]
      : []),
    // web-hub-proxy plan v2 §5 (X1c): `proxy.v1` iff `config.proxy`; `proxy.lan.v1` iff
    // `config.proxy && config.lan` (Q2 — LAN reach follows the LAN config, STATIC like
    // `privacy.v1`: it never follows whether the LAN listener actually came up). Both cap
    // surfaces share this one array. Tail-appended: proxy off ⇒ caps byte-identical.
    ...(config.proxy === undefined ? [] : [PROXY_HUB_CAP, ...(config.lan === undefined ? [] : [PROXY_LAN_HUB_CAP])]),
    // Link-preview D1: additive, after the existing proxy caps on both surfaces.
    ...(config.proxy === undefined ? [] : [PROXY_FRAME_HUB_CAP]),
    ...(config.feishuBot === undefined ? [] : [FSB_HUB_CAP]),
    // fabric phase-2 X1: `xs.v1` iff `config.crossSession` (tail-appended, same two-surface rule;
    // absent ⇒ caps byte-identical). Reply cap shares the same gate plus reply !== false.
    // Channel-plan §3.1 (CH1): `xs.channel.v1` iff `config.crossSession` — a hub protocol
    // capability with NO hub-level off key (`crossSession.channels` only carries params).
    ...(config.crossSession === undefined
      ? []
      : [
          XS_HUB_CAP,
          ...(config.crossSession.reply === false ? [] : [XS_REPLY_HUB_CAP]),
          XS_CHANNEL_HUB_CAP,
          // Alias-plan §3.6 (AL2): tail-appended, only for a table that loaded `ready`.
          // Alias-force-default (#72): `xs.alias.v2` follows v1 under the SAME condition (intent / force / xs_alias_evt).
          ...(xsAlias?.store.advertised === true ? [XS_ALIAS_HUB_CAP, XS_ALIAS_V2_HUB_CAP] : []),
        ]),
    // scheduled-reports plan r3 §10.1 (H1): `sched.v1` iff `config.schedule` exists (same
    // two-surface tail-append rule; absent ⇒ caps byte-identical). Declared even when the
    // store root failed to resolve (spawn.v1 precedent: the UI needs the cap to explain).
    ...(config.schedule === undefined ? [] : [SCHED_HUB_CAP, SCHED_CONFIRM_CAP]),
  ];

  return extraHubCaps;
}

export function assembleXsRelay(ctx: HubAssembly) {
  const { config, log, now, cleanup, xsAlias } = ctx;
  const registry = ctx.registry!;
  // fabric phase-2 X1: the cross-session relay exists iff `config.crossSession` (key absence IS
  // off — no router, no observer, no frame handling). Disposed on both teardown paths.
  // feishu-xs-mirror (A′): the quiet-delivery observer exists iff `feishuBot.xsMirror === true` ∧
  // `config.crossSession` — otherwise the key is not passed at all (hub byte-identical). `bot` is
  // assigned later; the closure reads it lazily (undefined ⇒ dropped).
  const xsMirrorOn = config.feishuBot?.xsMirror === true && config.crossSession !== undefined;
  const xsRelay =
    config.crossSession === undefined
      ? undefined
      : createXsRelay({
          registry,
          config: { home: config.home, crossSession: config.crossSession },
          log,
          now,
          ...(xsAlias === undefined ? {} : { aliases: xsAlias }),
          ...(xsMirrorOn ? { onQuietDelivered: (e) => ctx.bot?.xsMirror(e) } : {}),
        });
  if (xsRelay !== undefined) cleanup.push(async () => xsRelay.dispose());

  return xsRelay;
}
