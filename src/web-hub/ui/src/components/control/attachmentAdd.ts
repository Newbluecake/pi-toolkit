/**
 * Shared attachment-add pipeline (page-wide drop hoist, 2026-10 — user ruling 「整个页面都是
 * 拖放区」). Every entry that turns `File`s into tray items — the paperclip picker and the
 * textarea paste (Composer.vue) plus the page-wide drop zone (PageDropZone.vue) — funnels
 * through `addAttachments`, so the §2.3 nameless-rename and the §4.2 reject→hint mapping can
 * never drift apart between entries. Gating (`uploadOn`, agentKey, empty list) stays with the
 * callers: each entry's availability rule is its own.
 */
import { pastedName } from "@logic/upload.js";
import { UPLOAD_ATTACH_MAX_PER_MSG } from "@protocol/upload.js";
import type { AddReject, UploadsHandle } from "../../types.js";

/** `useI18n`'s `t` (structural — this module must not import the composable). */
type TFn = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export function fileNameOf(file: unknown): string {
  const name = (file as { name?: unknown } | null)?.name;
  return typeof name === "string" && name !== "" ? name : "file";
}

/** §2.3: screenshots/nameless blobs get a `pasted-<stamp>[-n].<ext>` name; real names pass through. */
export function renameIfNameless(file: unknown, seq: number): unknown {
  const f = file as { name?: unknown; type?: unknown; lastModified?: unknown } | null;
  if (typeof f?.name === "string" && f.name !== "") return file;
  const mime = typeof f?.type === "string" ? f.type : null;
  const lastModified = typeof f?.lastModified === "number" ? f.lastModified : undefined;
  try {
    if (typeof File === "function" && typeof Blob === "function" && file instanceof Blob) {
      return new File([file], pastedName(mime, Date.now(), seq), {
        type: mime ?? "",
        ...(lastModified !== undefined ? { lastModified } : {}),
      });
    }
  } catch {
    // fall through — a non-constructible file keeps its (empty) name
  }
  return file;
}

/** §4.2 reject→hint mapping: the FIRST admission reject stands for the batch (`null` = none). */
export function rejectHint(t: TFn, rejected: readonly AddReject[]): string | null {
  const first = rejected[0];
  if (first === undefined) return null;
  const name = fileNameOf(first.file);
  if (first.reason === "too-large") return t("upload.hintTooLarge", { name });
  if (first.reason === "too-many") return t("upload.hintTooMany", { n: UPLOAD_ATTACH_MAX_PER_MSG });
  if (first.reason === "duplicate") return t("upload.hintDuplicate", { name });
  return t("upload.hintInvalid", { name });
}

/** The one add path: §2.3 rename → `UploadsHandle.add` → surface the first reject as a hint. */
export function addAttachments(
  uploads: UploadsHandle,
  agentKey: string,
  files: readonly unknown[],
  t: TFn,
  showHint: (msg: string) => void,
): void {
  if (files.length === 0) return;
  let seq = 0;
  const rejected = uploads.add(
    agentKey,
    files.map((f) => renameIfNameless(f, ++seq)),
  ).rejected;
  const hint = rejectHint(t, rejected);
  if (hint !== null) showHint(hint);
}
