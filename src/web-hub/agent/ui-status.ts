/**
 * `/webhub status`'s Vue-UI-related text (vue-plan.md v2.1 §2.3, §5.2 — P5b). Pure formatting
 * only — no I/O, no pi imports — mirrors `lan-status.ts`'s shape so `commands/webhub.ts`
 * interleaves these lines with the LAN ones exactly the same way.
 *
 * `formatUiStatusLines` covers three cases (§2.3):
 *  - `hub.json`'s `ui` field is present and `state: "ok"` ⇒ one info line.
 *  - present and `state: "unbuilt"` ⇒ a warning line per rejected candidate (only in `mode:
 *    "package"` — see below — never surfaces host paths/reasons a caller shouldn't see) plus
 *    the two install-method lines (§2.1's install commands).
 *  - `hub.json` has no `ui` at all (hub not running, or an old hub that predates this field) ⇒
 *    falls back to a local `existsSync(packageUiDistDir()/build-info.json)` check (`hasLocalDist`,
 *    supplied by the caller — this module stays I/O-free) and, if that's also missing, the same
 *    two install-method lines plus a note that the hub itself never reported a UI status.
 *
 * `mode` here is the same distinction `unbuilt.ts`'s `renderUnbuiltPage` makes between token
 * (loopback, same machine — already trusted) and password (LAN, unauthenticated visitor): the
 * `/webhub status` command always runs on the host itself, so it is always the "loopback"
 * side of that distinction and may show absolute paths and per-candidate rejection reasons.
 * There is no LAN-visitor-facing surface here — `renderUnbuiltPage` (hub-side) is what an
 * unauthenticated LAN visitor actually sees, this is host-only.
 */
import type { UiCandidateResult, UiStatus } from "../hub/ui-root.js";

/** `package.json`'s `repository` (git+https://github.com/Newbluecake/pi-toolkit.git) — mirrors
 * `hub/unbuilt.ts`'s `REPO` constant (kept in sync by inspection, not by import, since this
 * module must stay pi-free and `unbuilt.ts` lives under `hub/`). */
const REPO = "Newbluecake/pi-toolkit";

function releaseUrlFor(version: string): string {
  return `https://github.com/${REPO}/releases/tag/v${version}`;
}

export interface FormatUiStatusOptions {
  /** Absolute package directory (`packageUiDistDir()`'s parent, i.e. the package root a `cd`
   * would target) — always shown; this command always runs on the host. */
  readonly pkgDir: string;
  /** `config.pluginVersion` / `package.json`'s version — used for the zip filename and release URL. */
  readonly version: string;
  /** Only consulted when `ui` is `undefined` (no hub, or a hub predating this field). */
  readonly hasLocalDist: boolean;
}

function installMethodLines(o: FormatUiStatusOptions): string[] {
  const zipName = `pi-toolkit-web-ui-${o.version}.zip`;
  return [
    `方式一（推荐，不受 pi update 清理影响）：从 ${releaseUrlFor(o.version)} 下载 ${zipName} 与 ${zipName}.sha256，` +
      `校验后 unzip -o ${zipName} -d ~/.pi/agent/，无需重启 hub。`,
    `方式二（源码构建）：cd ${o.pkgDir} && npm install --include=dev --no-audit --no-fund && npm run build:web` +
      `（注意 pi update 会清掉包内产物，需要重新执行）。`,
  ];
}

function candidateLine(c: UiCandidateResult): string {
  const detail = c.detail === undefined ? "" : `（${c.detail}）`;
  return `候选 ${c.kind} ${c.dir}: ${c.reason ?? "unknown"}${detail}`;
}

/**
 * `ui` is `hub.json`'s `ui` field (`undefined` when the hub either never ran, predates this
 * field, or hasn't finished its first `refresh()` yet — none of which are distinguishable from
 * here, hence the `hasLocalDist` fallback).
 */
export function formatUiStatusLines(ui: UiStatus | undefined, o: FormatUiStatusOptions): string[] {
  if (ui === undefined) {
    if (o.hasLocalDist) return [];
    return [
      "warning：hub 未上报 UI 状态（可能未运行，或版本早于本字段）；本地也未发现已构建产物。",
      ...installMethodLines(o),
    ];
  }
  if (ui.state === "ok") {
    return [`ui=ok source=${ui.source} v${ui.version} commit=${ui.commit} builtAt=${ui.builtAt}`];
  }
  return [
    "warning：Web UI 尚未构建（未找到匹配当前版本的已构建产物）。",
    ...ui.candidates.map(candidateLine),
    ...installMethodLines(o),
  ];
}
