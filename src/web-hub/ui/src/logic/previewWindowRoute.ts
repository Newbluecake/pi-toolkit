/**
 * web-hub-preview-windows plan r2 §3.2 (W1, frozen): the pure click-routing table — given a
 * path ref (a PathText/MdInline candidate or a raw open request) decide whether the target is
 * a KNOWN directory (route in-place inside the initiating window), a known file (open a new
 * window), or of unknown type (speculative open + fold-back, §3.3).
 *
 * No DOM, no Vue, no I/O: same discipline as the other `logic/` modules (runs unchanged under
 * vitest node). The kindOf port mirrors `usePreviewProbe`'s handle member (`(path) => kind |
 * undefined`) so the manager can hand its shared probe straight through; `undefined` (no probe
 * transport, not yet probed, or a foreign scope) is exactly the "unknown" branch.
 *
 * Truth table (plan §3.2, normative — W2/W3 consume this, do not fork it):
 * - `ref.dir === true`                              → "dir"   (the ref itself carries dir-ness)
 * - `kindOf(path) === "dir"`                        → "dir"   (probe confirmed a directory)
 * - `kindOf(path) ∈ {"text","image","file","missing"}` → "file" (missing opens a window that
 *   renders the error phase — the window owns the failure surface)
 * - anything else (no probe fn, unprobed path)      → "unknown" (speculative, §3.3)
 *
 * `routeOfDirEntry` maps a directory-listing row's `PreviewDirEntryType` (protocol-frozen):
 * `dir` rows navigate in-place, `file` rows open a new window (user 拍板 2), and
 * `symlink`/`other` rows have an unknown target type — a symlink whose probe answers `dir`
 * still folds back per §3.3, so "unknown" here means "resolve at request time", never "file".
 */
import type { PreviewDirEntryType, PreviewProbeKind } from "@protocol/preview.js";

export type PreviewRoute = "dir" | "file" | "unknown";

/** The routing input — the same superset `PreviewNavRef` carries (`dir` only ever `true`). */
export interface PreviewRouteRef {
  readonly path: string;
  readonly dir?: true;
}

/** The shared probe's kind lookup (`usePreviewProbe`'s `kindOf`); `undefined` = unknown. */
export type PreviewKindOf = (path: string) => PreviewProbeKind | undefined;

export function routeOf(ref: PreviewRouteRef, kindOf?: PreviewKindOf): PreviewRoute {
  if (ref.dir === true) return "dir";
  const kind = kindOf !== undefined ? kindOf(ref.path) : undefined;
  if (kind === "dir") return "dir";
  if (kind === "text" || kind === "image" || kind === "file" || kind === "missing") return "file";
  return "unknown";
}

export function routeOfDirEntry(type: PreviewDirEntryType): PreviewRoute {
  if (type === "dir") return "dir";
  if (type === "file") return "file";
  return "unknown"; // symlink | other — the target type is not knowable from the row alone
}
