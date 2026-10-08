/**
 * worktree-diff plan §3.1.1 (D3): untracked-file read with PreviewHandle ownership.
 *
 * Untracked content goes through preview's FULL admission chain (`createFsAdmitter`: literal
 * denylist + virtual roots → realpath → re-checks → stat → `O_NOFOLLOW` open → fstat identity →
 * `/proc/self/fd` readlink re-check, D5) — never through git. From the successful admit on, the
 * returned handle's SINGLE close owner is this module's `finally` (`boundedClose`, its own
 * ≤1 s deadline, never the request's signal — a close must always be attempted). The symlink
 * rule: the admit's realpath must equal `${W}/${rel}` EXACTLY (W is canonical; any symlinked
 * segment makes them differ ⇒ 415 `symlink`).
 *
 * Reads are positioned and each goes through `previewFsStep` (bounded ≤ WTDIFF_GIT_CMD_MS of
 * git-phase budget); the total read is capped at `WTDIFF_UNTRACKED_READ_MAX_BYTES`. The result
 * is a SERVER-SYNTHESIZED all-add patch (D9) — `sniff` decides text vs binary, `utf8SafeCut`
 * guards the byte-cap cut, and the patch is trimmed to a line boundary under
 * `WTDIFF_PATCH_MAX_BYTES`.
 */

import type { ReqDeadline } from "../req-deadline.js";
import type { FsAdmitter } from "../preview/admit.js";
import { boundedClose, isPreviewIoError, previewFsStep, type PreviewIoTracker } from "../preview/fs.js";
import { sniff, utf8SafeCut } from "../preview/sniff.js";
import type { HubLog } from "../ports.js";
import {
  WTDIFF_GIT_CMD_MS,
  WTDIFF_PATCH_MAX_BYTES,
  WTDIFF_UNTRACKED_READ_MAX_BYTES,
} from "../../protocol/worktree-diff.js";

export type UntrackedResult =
  | { ok: true; kind: "patch" | "binary" | "empty"; patch: string; bytes: number; truncated: boolean }
  | { ok: false; kind: "abort" }
  /** a mapped HTTP response (`status 0` never happens here: aborts come back as kind:"abort") */
  | { ok: false; kind: "response"; status: number; code: string; reason?: string };

export interface UntrackedDeps {
  admitter: FsAdmitter;
  tracker: PreviewIoTracker;
  now(): number;
  log: HubLog;
}

export interface UntrackedArgs {
  W: string;
  rel: string;
  deadline: ReqDeadline;
  signal: AbortSignal;
}

export function createUntrackedReader(deps: UntrackedDeps): (args: UntrackedArgs) => Promise<UntrackedResult> {
  return async function readUntracked(args: UntrackedArgs): Promise<UntrackedResult> {
    const abs = `${args.W}/${args.rel}`;
    const admitted = await deps.admitter.admit({ path: abs }, args.deadline, args.signal);
    if (!admitted.ok) {
      if (admitted.status === 0) return { ok: false, kind: "abort" }; // 不应答 — the caller decides
      return {
        ok: false,
        kind: "response",
        status: admitted.status,
        code: admitted.code,
        ...(admitted.reason === undefined ? {} : { reason: admitted.reason }),
      };
    }
    // —— from here the handle's single close owner is THIS function's finally (§3.1.1) ——
    const fh = admitted.fh;
    try {
      if (admitted.realpath !== abs) {
        // §3.1.1: W is canonical — any symlinked segment makes the two spellings differ
        return { ok: false, kind: "response", status: 415, code: "E_WTDIFF_UNSUPPORTED", reason: "symlink" };
      }
      const cap = Math.min(admitted.size, WTDIFF_UNTRACKED_READ_MAX_BYTES);
      const chunks: Buffer[] = [];
      let pos = 0;
      let truncatedByCap = admitted.size > WTDIFF_UNTRACKED_READ_MAX_BYTES;
      while (pos < cap) {
        const want = Math.min(64 * 1024, cap - pos);
        const buf = Buffer.alloc(want);
        const { bytesRead } = await previewFsStep(() => fh.read(buf, 0, want, pos), args.deadline, args.signal, {
          now: deps.now,
          tracker: deps.tracker,
          stepCapMs: WTDIFF_GIT_CMD_MS,
        });
        if (bytesRead === 0) break; // EOF early (file shrank) — not an error
        chunks.push(buf.subarray(0, bytesRead));
        pos += bytesRead;
      }
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) {
        // empty file (or emptied between status and read): header-only, zero hunks
        return { ok: true, kind: "empty", patch: "", bytes: 0, truncated: truncatedByCap };
      }
      const sniffed = sniff(buf, admitted.size);
      if (sniffed.kind === "binary" || sniffed.kind === "image") {
        return { ok: true, kind: "binary", patch: "", bytes: 0, truncated: truncatedByCap };
      }
      const { patch, truncated } = synthesizePatch(args.rel, buf, truncatedByCap);
      return { ok: true, kind: "patch", patch, bytes: Buffer.byteLength(patch, "utf8"), truncated };
    } catch (err) {
      // deadline / abort / busy / read error — preview's own mapping table applies
      if (args.signal.aborted || (isPreviewIoError(err) && err.ioFail === "abort")) {
        return { ok: false, kind: "abort" };
      }
      if (isPreviewIoError(err) && err.ioFail === "busy") {
        return { ok: false, kind: "response", status: 503, code: "E_BUSY", reason: "fs" };
      }
      return { ok: false, kind: "response", status: 504, code: "E_DEADLINE" };
    } finally {
      await boundedClose(() => fh.close(), { now: deps.now, tracker: deps.tracker, log: deps.log });
    }
  };
}

/** §3.1.1 合成: `diff --git a/<rel> b/<rel>\nnew file mode 100644\n--- /dev/null\n+++ b/<rel>`
 * + one `@@ -0,0 +1,N @@` hunk of `+`-prefixed lines, `\ No newline at end of file` when the
 * tail lacks `\n`; the read cap's last cut goes through `utf8SafeCut`. */
function synthesizePatch(rel: string, buf: Buffer, truncatedByCap: boolean): { patch: string; truncated: boolean } {
  let cut = buf.length;
  let capTrimmed = truncatedByCap;
  if (cut > WTDIFF_PATCH_MAX_BYTES - 1024) {
    // leave headroom for headers/escaping — trim the raw buffer at a UTF-8 boundary first
    const safe = utf8SafeCut(buf, WTDIFF_PATCH_MAX_BYTES - 2048);
    if (safe < cut) {
      cut = safe;
      capTrimmed = true;
    }
  }
  let text = buf.subarray(0, cut).toString("utf8");
  const head = `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n`;
  const lines = text === "" ? [] : text.split("\n");
  let noEol = false;
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  else noEol = true; // non-empty tail without a trailing newline
  const body = lines.map((l) => `+${l}`);
  if (noEol && body.length > 0) body.push("\\ No newline at end of file");
  let patch = `${head}@@ -0,0 +1,${body.filter((l) => !l.startsWith("\\")).length} @@\n${body.join("\n")}`;
  if (body.length > 0) patch += "\n";
  // §3.1.1: trim to PATCH_MAX at a line boundary (headers + escaping can still overflow)
  let truncated = capTrimmed;
  while (Buffer.byteLength(patch, "utf8") > WTDIFF_PATCH_MAX_BYTES && patch.includes("\n")) {
    const at = patch.lastIndexOf("\n");
    patch = at > 0 ? patch.slice(0, at) : patch;
    truncated = true;
  }
  return { patch, truncated };
}
