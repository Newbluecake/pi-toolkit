/**
 * Terminal QR rendering for the Feishu bot device-flow setup (feishu-bot plan v2 §9, package F9).
 *
 * Half-block renderer, INVERTED glyphs (light modules are printed solid, so the code scans on a
 * dark terminal background): two matrix rows per terminal line — `█` both light, `▀` upper light /
 * lower dark, `▄` upper dark / lower light, ` ` both dark — with a four-module quiet zone — the exact rendering the F-probe used and
 * verified to scan in real terminals (docs/dev/feishu-bot/probe-results.md, P1). The encoder
 * itself is the vendored `src/vendor/qrcodegen.ts` (Nayuki, MIT).
 */
import { qrMatrix } from "../vendor/qrcodegen.js";

/** Block glyph per (upper-dark << 1 | lower-dark) pair — index 0..3 (inverted, see header). */
const GLYPHS = ["█", "▀", "▄", " "] as const;
/** Quiet-zone width/height in modules (QR spec minimum is 4). */
export const QR_QUIET_ZONE = 4;

/**
 * Render `text` as a scannable block-character QR code (no ANSI escapes — plain characters only,
 * so it survives `ctx.ui.notify` and log files). Throws `Error("qr-too-large")` when the text
 * exceeds the byte-mode ECC-L capacity (2 953 bytes) — callers must catch and fall back to
 * printing the raw URL.
 */
export function renderQr(text: string): string {
  const matrix = qrMatrix(text);
  const size = matrix.length;
  const dark = (x: number, y: number): boolean => matrix[y - QR_QUIET_ZONE]?.[x - QR_QUIET_ZONE] ?? false;
  const lines: string[] = [];
  for (let y = 0; y < size + 2 * QR_QUIET_ZONE; y += 2) {
    let line = "";
    for (let x = 0; x < size + 2 * QR_QUIET_ZONE; x++) {
      line += GLYPHS[(dark(x, y) ? 2 : 0) | (dark(x, y + 1) ? 1 : 0)];
    }
    lines.push(line);
  }
  return lines.join("\n");
}
