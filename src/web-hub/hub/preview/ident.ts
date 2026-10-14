/**
 * web-hub content-preview — the chunked-mode file identity token (chunked-plan §2.1 D3 / §3.1).
 *
 * `previewIdentOf` is the ONE definition of the wire token `X-PWH-Preview-Ident` /
 * `?ident=`: `"i1." + the first 22 base64url chars (128 bits) of sha256("dev:ino:size:ctimeMs")`
 * over the stream-start `pre` stat. Pure and keyless — the same stat always produces the same
 * token, so it survives a hub restart, and `utimes` cannot forge it (ctime, not mtime). The
 * RE (format-level validation) lives in the protocol (`PREVIEW_IDENT_RE`); this module is the
 * hub-side derivation only, imported by `stream.ts`'s chunked branch. Not a secret: an
 * authenticated user can read the same stat-backed bytes anyway (U4) — the token only proves
 * "the file I am continuing is the file I started from", never «绝不拼接» (D12: an appending
 * log changes size ⇒ new ident ⇒ 409 `E_PREVIEW_CHANGED`, accepted this iteration).
 */

import { createHash } from "node:crypto";
import type { Identity } from "./verify.js";

/** The first 22 base64url chars of the digest — 128 bits, per chunked-plan §2.1 (D3). */
const IDENT_HASH_CHARS = 22;

export function previewIdentOf(id: Identity): string {
  const h = createHash("sha256").update(`${id.dev}:${id.ino}:${id.size}:${id.ctimeMs}`).digest("base64url");
  return `i1.${h.slice(0, IDENT_HASH_CHARS)}`;
}
