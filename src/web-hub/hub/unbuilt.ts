/**
 * hub-side "未构建" (unbuilt) placeholder page (vue-plan.md v2.1 §2.1 — todo #26
 * P5a, new module, NOT wired in yet: P5b's `static.ts` will serve this at `/`
 * with HTTP 200 + `Cache-Control: no-store` + `X-PWH-UI: unbuilt` whenever
 * `ui-root.ts`'s `resolveUiRoot` lands on `state: "unbuilt"`).
 *
 * Pure function, zero I/O, zero external resources: no `<script>`, no
 * `<style>`/`style="…"`, no event-handler attributes — satisfies the existing
 * CSP (`default-src 'self'; script-src 'self'; style-src 'self'; …`, §2.2)
 * with headroom to spare (this page needs none of `'self'` either). Every
 * interpolated value is HTML-escaped.
 */
import type { UiCandidateResult } from "./ui-root.js";

export type UiLang = "zh" | "en";
export type UiAuthMode = "token" | "password";

export interface RenderUnbuiltPageOptions {
  readonly lang: UiLang;
  readonly version: string;
  readonly mode: UiAuthMode;
  /** Absolute package directory — shown only in `mode: "token"` (loopback; §2.1). */
  readonly pkgDir?: string;
  /** Per-candidate rejection diagnostics — shown only in `mode: "token"`, `kind: reason` only (never `detail`). */
  readonly rejected?: readonly UiCandidateResult[];
}

/** `package.json`'s `repository` (git+https://github.com/Newbluecake/pi-toolkit.git) — build-time constant, never read at runtime. */
const REPO = "Newbluecake/pi-toolkit";

/** The release page a user downloads `pi-toolkit-web-ui-<version>.zip` (+ `.sha256`) from (§1.6/§2.1 install method 1). */
export function releaseUrlFor(version: string): string {
  return `https://github.com/${REPO}/releases/tag/v${version}`;
}

/** `zh*` (case-insensitive) ⇒ `"zh"`, everything else (including absent) ⇒ `"en"` (§2.1: "语言按 Accept-Language"). */
export function detectUiLang(acceptLanguage?: string): UiLang {
  if (acceptLanguage === undefined || acceptLanguage === "") return "en";
  const first = acceptLanguage.split(",")[0] ?? "";
  return /^\s*zh/i.test(first) ? "zh" : "en";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface Copy {
  readonly title: string;
  readonly reason: string;
  readonly method1Title: string;
  readonly method1Intro: (linkHtml: string, zipName: string) => string;
  readonly method2Title: string;
  readonly method2Note: string;
  /** Used verbatim in `mode: "password"` in place of the real absolute package directory. */
  readonly pkgDirPlaceholder: string;
  readonly candidatesTitle: string;
  readonly statusHint: string;
}

const COPY: Readonly<Record<UiLang, Copy>> = {
  zh: {
    title: "Web UI 尚未构建",
    reason: "未找到匹配当前版本的已构建产物，因此显示本说明页（本页本身返回 200）。",
    method1Title: "方式一：下载并手工解压 release 附件（推荐，不受 pi update 清理影响）",
    method1Intro: (linkHtml, zipName) =>
      `从 ${linkHtml} 下载 ${escapeHtml(zipName)} 与 ${escapeHtml(`${zipName}.sha256`)}，校验后解压到 ~/.pi/agent/，刷新本页即可（无需重启 hub）：`,
    method2Title: "方式二：从源码构建",
    method2Note: "注意：pi update 会清掉包内的构建产物，之后需要重新执行上面的命令。",
    pkgDirPlaceholder: "包目录（在主机上运行 /webhub status 查看）",
    candidatesTitle: "候选目录诊断",
    statusHint: "在主机上运行 /webhub status 查看完整诊断。",
  },
  en: {
    title: "Web UI not built yet",
    reason:
      "No built UI artifact matching this version was found, so this page is shown instead (it still returns HTTP 200).",
    method1Title: "Option 1: download and manually extract the release attachment (recommended — survives pi update)",
    method1Intro: (linkHtml, zipName) =>
      `Download ${escapeHtml(zipName)} and ${escapeHtml(`${zipName}.sha256`)} from ${linkHtml}, verify the checksum, then unzip into ~/.pi/agent/ and refresh this page (no hub restart needed):`,
    method2Title: "Option 2: build from source",
    method2Note:
      "Note: pi update clears build output inside the package — re-run the commands above after every update.",
    pkgDirPlaceholder: "the package directory (run /webhub status on the host to see it)",
    candidatesTitle: "Candidate directory diagnostics",
    statusHint: "Run /webhub status on the host for full diagnostics.",
  },
};

function renderCandidates(rejected: readonly UiCandidateResult[], t: Copy): string {
  if (rejected.length === 0) return "";
  const items = rejected
    .map((c) => `<li>${escapeHtml(c.kind)}: ${escapeHtml(c.dir)}: ${escapeHtml(c.reason ?? "unknown")}</li>`)
    .join("");
  return `<section><h2>${t.candidatesTitle}</h2><ul>${items}</ul></section>`;
}

/**
 * Renders the full unbuilt-page HTML document. `mode: "password"` (LAN, no
 * auth barrier reached yet) never emits `pkgDir`, any candidate `dir`/`reason`,
 * or any other host filesystem absolute path — only the literal `~/.pi/agent/`
 * and the release URL, both of which are safe to show an unauthenticated LAN
 * visitor. `mode: "token"` (loopback — same machine, already trusted) shows
 * both.
 */
export function renderUnbuiltPage(opts: RenderUnbuiltPageOptions): string {
  const t = COPY[opts.lang];
  const zipName = `pi-toolkit-web-ui-${opts.version}.zip`;
  const releaseUrl = escapeHtml(releaseUrlFor(opts.version));
  const linkHtml = `<a href="${releaseUrl}">${releaseUrl}</a>`;

  const isToken = opts.mode === "token";
  const cdTarget = isToken && opts.pkgDir !== undefined ? opts.pkgDir : t.pkgDirPlaceholder;
  const candidatesBlock =
    isToken && opts.rejected !== undefined ? renderCandidates(opts.rejected, t) : `<p>${t.statusHint}</p>`;

  const lines = [
    "<!doctype html>",
    `<html lang="${opts.lang}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${t.title}</title>`,
    "</head>",
    "<body>",
    "<main>",
    `<h1>${t.title}</h1>`,
    `<p>${t.reason}</p>`,
    `<p>${escapeHtml(`version=${opts.version}`)}</p>`,
    "<section>",
    `<h2>${t.method1Title}</h2>`,
    `<p>${t.method1Intro(linkHtml, zipName)}</p>`,
    `<pre>${escapeHtml(`sha256sum -c ${zipName}.sha256\nunzip -o ${zipName} -d ~/.pi/agent/`)}</pre>`,
    "</section>",
    "<section>",
    `<h2>${t.method2Title}</h2>`,
    `<pre>${escapeHtml(`cd ${cdTarget} && npm install --include=dev --no-audit --no-fund && npm run build:web`)}</pre>`,
    `<p>${t.method2Note}</p>`,
    "</section>",
    candidatesBlock,
    "</main>",
    "</body>",
    "</html>",
  ];
  return lines.join("\n");
}
