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
