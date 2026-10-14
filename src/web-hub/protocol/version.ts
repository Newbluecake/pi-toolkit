/**
 * web-hub protocol version constants (plan §包 A — frozen interface).
 *
 * This module is part of the frozen package-A surface: B/C/D/E develop against
 * these exports in parallel, so signatures must stay byte-identical to
 * `docs/dev/web-hub/plan.md`.
 */

/** Wire protocol version negotiated in `hello` / `hello_ack`. */
// fleet-drawer F0 (plan §3.2) raises minor 1.1 → 1.2: fleet adds the first NEW agent↔hub frames
// since 1.0 (run_tx_req/run_watch hub→agent; run_tx_reply/run_ev/run_gap/run_end agent→hub).
// upload/spawn/preview never bumped it — they only added caps and HTTP endpoints, no frames
// (see the SPAWN_HUB_CAP / PREVIEW_HUB_CAP notes below). `protoCompatible` still compares
// major only, so old/new mix freely (compat matrix plan §3.2).
export const PROTO = { major: 1, minor: 2 } as const;

/** Capabilities advertised by a P1 agent in `hello.caps`. */
export const P1_CAPS = ["ev.v1", "fleet.v1", "snapshot.v1", "branch.v1"] as const;
export const P2_AGENT_CAPS = ["cmd.v1", "dialog.v1", "command.v1"] as const;
export const P2_HUB_CAPS = ["cmd.v1", "dialog.v1", "command.v1", "ctl.v2"] as const;

/**
 * web-hub-upload plan §5.1: the upload caps advertised on each side of the hub↔agent socket.
 * The hub advertises `UPLOAD_HUB_CAPS` in its own hello (additive to `P2_HUB_CAPS`); an agent
 * advertises a subset of `UPLOAD_AGENT_CAPS` depending on `webHub.uploads` (`"on"` ⇒ both,
 * `"loopback"` ⇒ `upload.v1` only, `"off"`/`control:false` ⇒ neither).
 */
export const UPLOAD_HUB_CAPS = ["upload.v1"] as const;
export const UPLOAD_AGENT_CAPS = ["upload.v1", "upload.lan.v1"] as const;

/**
 * ask-user-async plan §7.2 (P3): the hub's runtime `DialogClosedSchema` understands
 * `dialogs.closed[].by === "background"` (ask_user's background-completion interrupt close).
 * Advertised exactly like UPLOAD_HUB_CAPS — on both hub cap surfaces (`hub.ts`'s browser-facing
 * `HubInfo.caps` and `agent-server.ts`'s agent-facing `hello_ack.caps`, kept byte-identical).
 * An agent whose bridge holds open ask_user dialogs degrades `by:"background"` to `"abort"`
 * while the connected hub lacks this cap, so an un-upgraded hub never rejects the whole
 * dialogs frame (which would freeze the web dialog list for the closed records' 120s TTL).
 */
export const DIALOG_BG_HUB_CAPS = ["dialog.bg.v1"] as const;

/**
 * web-hub-spawn plan §SP1 (arch §8.2): the hub cap advertising the managed-spawn feature set
 * (`GET/POST /api/headless*`). Advertised only when `config.spawn` exists (SP10 folds it into
 * `HubInfo.caps`/`hello_ack.caps` via `extraHubCaps`); a browser that doesn't see it hides the
 * “选择目录新建” entry. Spawn itself triggered no PROTO bump — it adds no agent↔hub frames
 * (§2.3: 帧只加不改); the 1.1 → 1.2 minor bump later came from fleet F0 alone.
 */
export const SPAWN_HUB_CAP = "spawn.v1";

/**
 * web-hub-spawn default-model plan §2/D4: the hub cap advertising the 「新建会话默认模型」
 * feature set — `POST /api/headless/prefs`, the `model` tri-state on `POST /api/headless`,
 * and the record/accepted `model` + `"model-rejected"` hint vocabulary. Advertised exactly
 * like `SPAWN_HUB_CAP`: only when `config.spawn` exists (H2 folds it into `extraHubCaps` on
 * both cap surfaces). A browser that does NOT see it MUST NOT send `model` anywhere — the
 * pre-feature request schema is `additionalProperties: false`, so an old hub would 400 the
 * body — and hides/disables the settings entry with an upgrade hint; an old browser facing a
 * new hub just ignores the unknown cap string (every consumer is a `caps.includes(...)`
 * check). Like `SPAWN_HUB_CAP` itself, this added no agent↔hub frames, so no PROTO bump
 * (same §2.3 只加帧不改 rule; see PROTO above for the 1.2 bump's actual owner, fleet F0).
 */
export const SPAWN_MODEL_HUB_CAP = "spawn.model.v1";

/**
 * web-hub session-history plan PD1 (§3.2): the hub cap advertising the history session list
 * + resume/fork surface — `GET /api/headless/history` and the `session` ref on
 * `POST /api/headless`. Advertised ONLY when `config.spawn?.history === true` (P-cfg threads
 * the `webHub.spawn.history` setting into `HubSpawnConfig.history`; the key's absence is the
 * wire-level off, same pattern as `restore`) on both hub cap surfaces, exactly like
 * `SPAWN_MODEL_HUB_CAP`. A browser that does NOT see it MUST NOT send `session` anywhere
 * (PD14: the pre-feature request schema is `additionalProperties:false`, so an old hub would
 * 400 the body — dropping the field silently would fork a brand-new session) and hides the
 * history entry; an old browser just ignores the unknown cap string. Like every cap above it
 * adds no agent↔hub frames and no SSE event, so no PROTO bump (same §2.3 rule; the 1.1 →
 * 1.2 minor bump is fleet F0's alone, see PROTO above).
 */
export const SPAWN_HISTORY_HUB_CAP = "spawn.history.v1"; // only when config.spawn?.history === true; no PROTO bump

/**
 * web-hub spawn-relaunch (「离线/过期会话点击直接重新拉起」): the hub cap advertising
 * `POST /api/headless/relaunch` — re-forking a TERMINAL managed record's session
 * (`pi --mode rpc --session <file>`, same kill-old-then-fork/L6 discipline as spawn-restore).
 * Relaunch reuses the restore machinery, so the cap is advertised only when
 * `config.spawn?.restore === true` AND the spawn platform probe passed (death confirmation is
 * /proc-bound), on both hub cap surfaces, exactly like `SPAWN_HISTORY_HUB_CAP`. A browser that
 * does NOT see it renders no relaunch affordance on offline managed cards; an old browser just
 * ignores the unknown cap string. No agent↔hub frames, no SSE event — no PROTO bump (same
 * §2.3 rule as every cap above).
 */
export const SPAWN_RELAUNCH_HUB_CAP = "spawn.relaunch.v1"; // only when config.spawn?.restore === true && platform ok

/**
 * web-hub-preview plan v3 §4.1 (PV1): the two hub caps advertising the read-only content-preview
 * endpoint (`GET /api/preview`). `PREVIEW_HUB_CAP` is declared whenever the feature is on
 * (`webHub.preview` = `"loopback"` or `"on"`); `PREVIEW_LAN_HUB_CAP` only when the mode is
 * `"on"` (the default, U1) — under the defaults BOTH are declared, on both hub cap surfaces
 * (`HubInfo.caps` / `hello_ack.caps`; PV3's `extraHubCaps` fold, §4.7 caps 对照). A browser that
 * doesn't see them renders paths as plain text. Preview likewise added no frames and no SSE
 * event, so it triggered no bump of its own (same §2.3 rule as spawn; the 1.1 → 1.2 bump is
 * fleet F0's, see PROTO above).
 */
export const PREVIEW_HUB_CAP = "preview.v1";
export const PREVIEW_LAN_HUB_CAP = "preview.lan.v1";

/**
 * web-hub-preview dir-plan §1.2 (P0, review N1 note): the two caps added by the directory (A)
 * and any-absolute-path (C) enhancements.
 *
 * `PREVIEW_DIR_HUB_CAP` (A): `GET /api/preview?dir=1` directory listings and the probe's
 * `dirs:true` / `"dir"` answers are available (also requires `/proc/self/fd` to be usable at
 * hub start — fail-closed without it, §3.6). `PREVIEW_ABS_HUB_CAP` (C): the hub admits ANY
 * absolute path; the UI relaxes path recognition off this cap. Both are declared by the SAME
 * feature gate as `PREVIEW_HUB_CAP` (the mere presence of `config.preview`), in lockstep on
 * both cap surfaces — the caps are NOT user configuration switches, they exist only for
 * client recognition / version compatibility. Like every cap above they add no frames, so no
 * PROTO bump (the 1.1 → 1.2 bump is fleet F0's alone, see PROTO above).
 */
export const PREVIEW_DIR_HUB_CAP = "preview.dir.v1";
export const PREVIEW_ABS_HUB_CAP = "preview.abs.v1";
/** Tilde-expansion addendum (`hub/preview/tilde.ts`): the hub expands a leading `~/` in a
 * preview path to the hub user's home before the full admission chain. Same gate as
 * `PREVIEW_ABS_HUB_CAP`; a hub without it never sees a `~/` request from the UI. */
export const PREVIEW_TILDE_HUB_CAP = "preview.tilde.v1";
/** preview-download (2026-10-12 user 拍板): `GET /api/preview?download=1` — raw-byte download
 * of ANY admitted regular file (no text/image sniff gate). Same declaration gate as
 * `PREVIEW_ABS_HUB_CAP` (the mere presence of `config.preview`; loopback mode ⇒ loopback
 * clients only, same width rule as preview itself). A hub without it keeps unsupported-file
 * clicks at the pure error phase in the UI. */
export const PREVIEW_DOWNLOAD_HUB_CAP = "preview.download.v1";

/**
 * web-hub-preview chunked-plan §2 (P0): the hub cap advertising chunked text streaming —
 * `GET /api/preview?chunk=1[&offset=N&ident=…]` continuation requests and the
 * `X-PWH-Preview-Offset` / `X-PWH-Preview-Ident` response headers (`protocol/preview.ts`).
 * Declared under EXACTLY the same gate as `PREVIEW_DOWNLOAD_HUB_CAP` (the mere presence of
 * `config.preview`, folded into `extraHubCaps` on both cap surfaces in lockstep) — unlike
 * `WTDIFF_HUB_CAP` there is NO `/proc/self/fd` condition, because file preview itself does
 * not depend on `/proc`. The cap is mandatory (chunked-plan §2.4): an old hub silently
 * IGNORES the unknown `offset` param and answers from 0, so a UI that does not see it must
 * never send `chunk`/`offset`/`ident` (it would append the duplicated first chunk). Like
 * every cap above it adds no agent↔hub frames, so no PROTO bump (same §2.3 rule; the
 * 1.1 → 1.2 bump is fleet F0's alone, see PROTO above).
 */
export const PREVIEW_CHUNK_HUB_CAP = "preview.chunk.v1";

/**
 * web-hub-fleet-drawer plan §3.2/§7.1 (F0): the run-transcript caps. An agent advertises a
 * subset of `RUNTX_AGENT_CAPS` depending on `webHub.subagentTranscript` (`"all"` ⇒ both,
 * `"loopback"` ⇒ `runtx.v1` only, `"off"` ⇒ neither — F2 wires `capsExtra`); the hub
 * advertises `RUNTX_HUB_CAPS` on both of its cap surfaces (`HubInfo.caps` /
 * `hello_ack.caps`). LAN availability is deliberately NOT its own hub cap: §7.1 enforces the
 * gate per-request against the AGENT's caps by listener (`runtx.v1` for loopback, plus
 * `runtx.lan.v1` for LAN); the `AgentCard.runTranscript*` fields are UX-only.
 */
export const RUNTX_AGENT_CAPS = ["runtx.v1", "runtx.lan.v1"] as const;
export const RUNTX_HUB_CAPS = ["runtx.v1"] as const;

/** P7w (quota-plan §9A.1/D19): the hub can decode droid pool quota (`QuotaProviderWire.id` ∈
 *  droid-*, `QuotaWindowWire.scope="month"`, `billing`, `problems`). Advertised unconditionally on
 *  BOTH hub cap surfaces (`HubInfo.caps` / `hello_ack.caps`, right after RUNTX_HUB_CAPS); the agent
 *  only emits those shapes when hello_ack.caps ∋ this cap. No new frame ⇒ no PROTO bump. */
export const QUOTA_POOLS_HUB_CAP = "quota.pools.v1";
export const QUOTA_POOLS_HUB_CAPS = [QUOTA_POOLS_HUB_CAP] as const;

/** web-hub-steer-recall plan §2.3 S1. Agent advertises iff holdWired(settings) (hold.ts); the hub
 *  advertises on BOTH cap surfaces (HubInfo.caps / hello_ack.caps), same rule as DIALOG_BG_HUB_CAPS.
 *  The agent only ever HOLDS while `holdCap()` — link live ∧ hello_ack.caps ∋ hold.v1 — is true at
 *  that instant (pure read, no binding); it never needs the cap to DELIVER what it already holds. */
export const HOLD_CAP = "hold.v1";
export const HOLD_AGENT_CAPS = ["hold.v1"] as const;
export const HOLD_HUB_CAPS = ["hold.v1"] as const;

/** web-hub-avatar plan §4.2: the single hub capability for the avatar surface. */
export const AVATAR_HUB_CAP = "avatar.v1";

/**
 * web-hub-privacy plan v2.1 (P1): the hub cap advertising the per-session privacy lock —
 * `POST /api/privacy/verify` (LAN only) + `POST /api/privacy/lock` (both listeners) + the
 * `privacy` SSE frame. Advertised ONLY when `config.privacy` exists (`webHub.privacy`,
 * default true — `false` is the key's ABSENCE, same wire-level off pattern as `avatar`),
 * folded into `extraHubCaps` in `hub.ts` so `HubInfo.caps` and `hello_ack.caps` stay
 * two-face-same-source (评审 #10: the cap is STATIC — it never follows whether the LAN
 * listener came up). A browser that doesn't see it renders zero lock UI (byte-identical to
 * pre-feature); one that sees it but has not yet received the `privacy` frame fails CLOSED
 * (no session detail renders — plan「锁状态下发」). No agent↔hub frames — no PROTO bump
 * (same §2.3 rule as every cap above).
 */
export const PRIVACY_HUB_CAP = "privacy.v1";

/** D14: capability required before a control-plane slot is sent. */
export const SLOT_REQUIRED_CAP = {
  dialogs: "dialog.v1",
  ctl: "cmd.v1",
  commands: "command.v1",
} as const;

/** D1/D2: names are permanently reserved and must not be reused. */
export const RESERVED_FRAME_TYPES = ["dialog_open", "dialog_closed", "dialog_answer"] as const;

/**
 * worktree-diff plan §1.4 (D0): the hub cap advertising the worktree file-diff feature set
 * (`GET /api/worktree-diff/*`, `protocol/worktree-diff.ts`). Declared whenever `config.preview`
 * exists **and** `/proc/self/fd` is usable at hub start (D21) — it is NOT an independent
 * switch; LAN availability rides `PREVIEW_LAN_HUB_CAP` (D6, same width as preview per the
 * 2026-10-08 A1 (a) ruling). A browser that doesn't see it keeps the worktree panel
 * byte-identical to today (I8). Like every cap above it adds no agent↔hub frames, so no PROTO
 * bump (same §2.3 rule as preview; the 1.1 → 1.2 bump is fleet F0's alone, see PROTO above).
 */
export const WTDIFF_HUB_CAP = "wtdiff.v1";

/**
 * Compare two semver strings by their core three segments (major.minor.patch).
 * Invalid strings are treated as `0.0.0`. Prerelease/build suffixes (e.g.
 * `1.2.3-beta.1`, `1.2.3+build`) are ignored; a leading `v` is tolerated.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseCore(a);
  const pb = parseCore(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** A remote speaking the same protocol major is compatible (minor differences are additive). */
export function protoCompatible(remote: { major: number }): boolean {
  return remote.major === PROTO.major;
}

const CORE_RE = /^v?(\d+)\.(\d+)\.(\d+)(?!\d)/;

function parseCore(v: string): [number, number, number] {
  const m = CORE_RE.exec(v.trim());
  if (m === null) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * worktree-graph plan v2 §3 (P0): the hub cap advertising the worktree commit-graph endpoint
 * (`GET /api/worktree-graph`, `protocol/worktree-graph.ts`). Declared under exactly the same
 * conditions as `WTDIFF_HUB_CAP` (「与 wtdiff 同门」): whenever `config.preview` exists **and**
 * `/proc/self/fd` is usable at hub start — no `/proc` ⇒ the routes are never constructed, so
 * the cap is never declared. LAN availability likewise rides `PREVIEW_LAN_HUB_CAP` (§0.2 Q1:
 * LAN has the same access as loopback, gated by the existing `webHub.preview`; `"loopback"`
 * turns it off for LAN). A browser that doesn't see it keeps the worktree panel byte-identical
 * (I8). Like every cap above it adds no agent↔hub frames and no SSE event, so no PROTO bump
 * (the 1.1 → 1.2 minor bump is fleet F0's alone, see PROTO above).
 */
export const WTGRAPH_HUB_CAP = "wtgraph.v1";
