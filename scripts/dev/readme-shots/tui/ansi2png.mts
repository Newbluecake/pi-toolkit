// Usage: npx tsx ansi2png.mts <in.ansi> <out.png>   — ANSI (tmux capture-pane -ep) → HTML grid → PNG via Playwright chromium.
import { readFileSync, writeFileSync } from "node:fs";
import { loadPlaywright } from "../../../web-hub/lib/playwright.js";
const [inp, out] = process.argv.slice(2);
const BG = "#0d1117",
  FG = "#c9d1d9";
const pal16 = [
  "#484f58",
  "#ff7b72",
  "#3fb950",
  "#d29922",
  "#58a6ff",
  "#bc8cff",
  "#39c5cf",
  "#b1bac4",
  "#6e7681",
  "#ffa198",
  "#56d364",
  "#e3b341",
  "#79c0ff",
  "#d2a8ff",
  "#56d4dd",
  "#f0f6fc",
];
function c256(n: number): string {
  if (n < 16) return pal16[n]!;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  n -= 16;
  const f = (x: number) => (x ? 55 + x * 40 : 0);
  return `rgb(${f(Math.floor(n / 36))},${f(Math.floor(n / 6) % 6)},${f(n % 6)})`;
}
const wide = (cp: number) =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe6f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f300 && cp <= 0x1faff) ||
  cp === 0x23f3 ||
  cp === 0x231b;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const lines = readFileSync(inp!, "utf8").replace(/\n+$/, "").split("\n");
let st = { fg: "", bg: "", b: false, d: false, i: false, u: false, r: false };
let html = "";
for (const line of lines) {
  let row = "";
  const re = /\x1b\[([0-9;:]*)m|\x1b\[[0-9;?]*[A-Za-z]|([^\x1b]+)/gu;
  let m;
  while ((m = re.exec(line))) {
    if (m[2] !== undefined) {
      for (const ch of m[2]) {
        const cp = ch.codePointAt(0)!;
        let fg = st.fg || FG,
          bg = st.bg || "";
        if (st.r) [fg, bg] = [bg || BG, fg];
        const style = `${fg !== FG ? `color:${fg};` : ""}${bg ? `background:${bg};` : ""}${st.b ? "font-weight:700;" : ""}${st.i ? "font-style:italic;" : ""}${st.u ? "text-decoration:underline;" : ""}${st.d ? "opacity:.6;" : ""}`;
        row += `<i class="${wide(cp) ? "w" : "n"}" style="${style}">${esc(ch)}</i>`;
      }
    } else if (m[1] !== undefined) {
      const p = m[1] === "" ? [0] : m[1].split(/[;:]/).map(Number);
      for (let k = 0; k < p.length; k++) {
        const c = p[k]!;
        if (c === 0) st = { fg: "", bg: "", b: false, d: false, i: false, u: false, r: false };
        else if (c === 1) st.b = true;
        else if (c === 2) st.d = true;
        else if (c === 3) st.i = true;
        else if (c === 4) st.u = true;
        else if (c === 7) st.r = true;
        else if (c === 22) {
          st.b = false;
          st.d = false;
        } else if (c === 23) st.i = false;
        else if (c === 24) st.u = false;
        else if (c === 27) st.r = false;
        else if (c >= 30 && c <= 37) st.fg = pal16[c - 30]!;
        else if (c >= 90 && c <= 97) st.fg = pal16[c - 90 + 8]!;
        else if (c === 39) st.fg = "";
        else if (c >= 40 && c <= 47) st.bg = pal16[c - 40]!;
        else if (c >= 100 && c <= 107) st.bg = pal16[c - 100 + 8]!;
        else if (c === 49) st.bg = "";
        else if (c === 38 || c === 48) {
          const t = c === 38 ? "fg" : "bg";
          if (p[k + 1] === 5) {
            (st as any)[t] = c256(p[k + 2]!);
            k += 2;
          } else if (p[k + 1] === 2) {
            (st as any)[t] = `rgb(${p[k + 2]},${p[k + 3]},${p[k + 4]})`;
            k += 4;
          }
        }
      }
    }
  }
  html += `<div class="l">${row || "&nbsp;"}</div>`;
}
import { existsSync, readdirSync } from "node:fs";
function findEmojiFont(): string {
  if (process.env.EMOJI_FONT && existsSync(process.env.EMOJI_FONT)) return process.env.EMOJI_FONT;
  const c = ["/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf", "/usr/share/fonts/noto/NotoColorEmoji.ttf"];
  try {
    for (const v of readdirSync("/snap")) {
      const d = `/snap/${v}`;
      if (v.startsWith("gnome-"))
        for (const r of readdirSync(d)) c.push(`${d}/${r}/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf`);
    }
  } catch {}
  return c.find((p) => existsSync(p)) ?? "";
}
const emoji = "file://" + findEmojiFont();
const page = `<html><head><style>
@font-face{font-family:E;src:url("${emoji}")}
body{margin:0;background:${BG}}
.t{display:inline-block;padding:18px 22px;background:${BG};color:${FG};font:14px/20px "DejaVu Sans Mono","Noto Sans Mono","Noto Sans CJK SC",E,monospace}
.l{white-space:pre;height:20px}.l i{font-style:normal;display:inline-block;text-align:left;overflow:visible}.n{width:8.43px}.w{width:16.86px;font-family:E,"Noto Sans CJK SC","DejaVu Sans Mono"}
</style></head><body><div class="t" id="t">${html}</div></body></html>`;
writeFileSync(out!.replace(/\.png$/, ".html"), page);
const pw: any = await loadPlaywright();
const b = await pw.chromium.launch({ headless: true });
const p = await b.newPage({ deviceScaleFactor: 2, viewport: { width: 1400, height: 1000 } });
await p.goto("file://" + out!.replace(/\.png$/, ".html"));
await p.waitForTimeout(500);
await (await p.$("#t")).screenshot({ path: out });
await b.close();
