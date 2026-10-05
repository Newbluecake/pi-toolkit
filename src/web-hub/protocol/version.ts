/**
 * web-hub protocol version constants (plan §包 A — frozen interface).
 *
 * This module is part of the frozen package-A surface: B/C/D/E develop against
 * these exports in parallel, so signatures must stay byte-identical to
 * `docs/dev/web-hub/plan.md`.
 */

/** Wire protocol version negotiated in `hello` / `hello_ack`. */
export const PROTO = { major: 1, minor: 1 } as const;

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
 * “选择目录新建” entry. Spawn adds NO agent↔hub frames, so PROTO stays 1.1 (§2.3: spawn 不升
 * PROTO).
 */
export const SPAWN_HUB_CAP = "spawn.v1";

/** D14: capability required before a control-plane slot is sent. */
export const SLOT_REQUIRED_CAP = {
  dialogs: "dialog.v1",
  ctl: "cmd.v1",
  commands: "command.v1",
} as const;

/** D1/D2: names are permanently reserved and must not be reused. */
export const RESERVED_FRAME_TYPES = ["dialog_open", "dialog_closed", "dialog_answer"] as const;

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
