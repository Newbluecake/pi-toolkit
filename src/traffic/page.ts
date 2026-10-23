/**
 * Web 查看页：Vue 3 内联应用（零构建步骤、零外部运行时依赖）。
 *
 * - 本文件只含 HTML 骨架（#app 挂载点 + 两个内联 script 占位）与全部 CSS
 * - Vue（vendor/vue.global.prod.js，带 compiler 的 global build）与应用（app.js）
 *   在**首次调用 buildPage()** 时 readFileSync 读入并内联（T2a：模块顶层零 IO，§3.1）；两个文本 blob 分别
 *   sanitize（</script → <\/script），不对最终页面全局替换（骨架自身需要合法的 </script>）
 * - gzip 副本同在 buildPage() 内生成；缓存归调用方（engine.page，首个 GET / 时组装）
 * - Vue 升级步骤见 README「开发与本地安装」
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/**
 * 资源目录解析：依次尝试 import.meta.url 所在目录（标准 ESM / vitest）→
 * __filename 所在目录（jiti 加载 TS 时注入），取第一个存在 app.js 的目录。
 * 禁止 process.cwd() 兜底（扩展工作目录不可控）。
 */
function resolveSrcDir(): string {
  const candidates: string[] = [];
  try {
    candidates.push(dirname(fileURLToPath(import.meta.url)));
  } catch {}
  try {
    // @types/node 声明了 __filename 全局；jiti 注入 CJS 风格 __filename，纯 ESM 下为 undefined
    if (typeof __filename === "string" && __filename) candidates.push(dirname(__filename));
  } catch {}
  for (const dir of candidates) {
    if (existsSync(join(dir, "app.js"))) return dir;
  }
  throw new Error(
    `pi-traffic-record: 无法定位页面资源目录（需包含 app.js 与 vendor/vue.global.prod.js）。已尝试: ${candidates.join(", ") || "（无候选目录）"}`,
  );
}

/** 内联 sanitize：仅对将要插入 <script> 的文本 blob 转义 </script，防止提前闭合外层 script 标签 */
const inlineJs = (js: string): string => js.replace(/<\/script/gi, "<\\/script");

function pageHtml(VUE_JS: string, APP_JS: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi traffic record</title>
<style>
/* 主题变量：默认深色，[data-theme="light"] 覆盖为浅色 */
:root {
	--bg: #0d1117; --bg-alt: #161b22; --bg-input: #21262d; --border: #30363d;
	--fg: #c9d1d9; --fg-dim: #8b949e; --fg-faint: #565d66;
	--accent: #58a6ff; --accent-bg: #1f6feb; --accent-sel: #1f6feb22;
	--ok: #1a7f37; --err: #b62324; --warn: #9e6a03; --usage: #d29922;
	--tool: #bc8cff; --err-fg: #f85149; --on-accent: #fff;
	--list-w: 304px;
}
[data-theme="light"] {
	--bg: #ffffff; --bg-alt: #f6f8fa; --bg-input: #f6f8fa; --border: #d0d7de;
	--fg: #1f2328; --fg-dim: #656d76; --fg-faint: #8c959f;
	--accent: #0969da; --accent-bg: #0969da; --accent-sel: #0969da18;
	--ok: #1a7f37; --err: #cf222e; --warn: #9a6700; --usage: #9a6700;
	--tool: #8250df; --err-fg: #cf222e; --on-accent: #fff;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--bg); color: var(--fg); height: 100vh; display: flex; flex-direction: column; font-size: 13px; }
#app { display: contents; }
header { display: flex; align-items: center; gap: 12px; padding: 8px 14px; background: var(--bg-alt); border-bottom: 1px solid var(--border); flex-shrink: 0; }
.logo { font-weight: 700; color: var(--accent); }
.badge { padding: 2px 8px; border-radius: 10px; font-size: 11px; background: var(--border); color: var(--fg-dim); }
.badge.on { background: var(--ok); color: var(--on-accent); }
.badge.off { background: var(--border); color: var(--fg-dim); }
.badge.err { background: var(--err); color: var(--on-accent); }
.badge.gate { background: var(--usage); color: var(--on-accent); }
nav { margin-left: auto; display: flex; gap: 4px; align-items: center; }
.tab { background: none; border: 1px solid var(--border); color: var(--fg-dim); padding: 4px 14px; border-radius: 6px; cursor: pointer; font-family: inherit; }
.tab.active { background: var(--accent-bg); border-color: var(--accent-bg); color: var(--on-accent); }
#themeBtn { background: none; border: 1px solid var(--border); color: var(--fg-dim); padding: 4px 10px; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 13px; margin-left: 6px; }
#themeBtn:hover { background: var(--bg-input); color: var(--fg); }
main { flex: 1; overflow: hidden; }
.pane { display: none; height: 100%; }
.pane.active { display: block; }
.split { display: flex; height: 100%; }
.list { width: var(--list-w); min-width: 140px; overflow-y: auto; padding: 6px; flex-shrink: 0; }
.resizer { width: 5px; flex-shrink: 0; cursor: col-resize; border-right: 1px solid var(--border); transition: background 0.12s; }
.resizer:hover, .resizer.dragging { background: var(--accent-bg); border-right-color: var(--accent-bg); }
body.resizing { user-select: none; cursor: col-resize; }
.detail { flex: 1; overflow-y: auto; padding: 12px 16px; }
.empty { color: var(--fg-faint); text-align: center; padding: 40px 10px; }
.flow { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; }
.flow:hover { background: var(--bg-alt); }
.flow.sel { background: var(--accent-sel); border-color: var(--accent-bg); }
.fid { color: var(--fg-faint); min-width: 26px; flex-shrink: 0; }
.ftime { color: var(--fg-dim); flex-shrink: 0; }
.fmodel { color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.fsize { color: var(--fg-faint); flex-shrink: 0; }
.st { padding: 1px 6px; border-radius: 8px; font-size: 11px; flex-shrink: 0; }
.st.ok { background: var(--ok); color: var(--on-accent); }
.st.err { background: var(--err); color: var(--on-accent); }
.st.pending { background: var(--warn); color: var(--on-accent); }
.meta { background: var(--bg-alt); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 14px; line-height: 1.7; }
.meta b.hl { color: var(--accent); }
.meta .dim { color: var(--fg-faint); }
h3 { color: var(--accent); font-size: 13px; margin: 16px 0 8px; }
.usage { color: var(--usage); margin-bottom: 8px; }
.stopreason { color: var(--fg-dim); margin-bottom: 8px; }
.stopreason .emsg { color: var(--err-fg); }
.msg-text { white-space: pre-wrap; background: var(--bg-alt); border-left: 3px solid var(--ok); padding: 8px 10px; border-radius: 0 6px 6px 0; margin-bottom: 8px; }
.toolcall { background: var(--bg-alt); border-left: 3px solid var(--tool); padding: 8px 10px; border-radius: 0 6px 6px 0; margin-bottom: 8px; }
.thinking { margin-bottom: 8px; }
.thinking summary { color: var(--fg-dim); cursor: pointer; }
.thinking pre { color: var(--fg-dim); }
details.raw { margin-bottom: 8px; }
details.raw summary { cursor: pointer; color: var(--fg-dim); padding: 4px 0; }
pre { background: var(--bg-alt); border: 1px solid var(--border); border-radius: 6px; padding: 10px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; margin-top: 6px; max-height: 500px; overflow-y: auto; }
.toolbar { display: flex; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--border); align-items: center; }
.toolbar .hint { color: var(--fg-faint); }
select, button.btn, a.btn { background: var(--bg-input); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 5px 12px; font-family: inherit; font-size: 13px; }
select { max-width: 560px; }
button.btn, a.btn { cursor: pointer; text-decoration: none; display: inline-block; }
button.btn:hover, a.btn:hover { background: var(--border); }
button.btn:disabled { opacity: 0.5; cursor: default; }
#exportBody { padding: 16px; line-height: 2; }
#exportInfo b { color: var(--accent); }
#exportInfo .hint { color: var(--fg-dim); }
.chunks { max-height: 420px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; margin-top: 6px; }
.chunk { display: flex; gap: 8px; padding: 3px 8px; border-bottom: 1px solid var(--border); align-items: baseline; }
.chunk:last-child { border-bottom: none; }
.cseq { color: var(--fg-faint); width: 48px; flex-shrink: 0; }
.cms { color: var(--usage); width: 76px; flex-shrink: 0; }
.cdata { white-space: pre-wrap; word-break: break-all; flex: 1; color: var(--fg); }
.replay-warn { color: var(--warn); background: var(--bg-alt); border-left: 3px solid var(--warn); padding: 6px 10px; border-radius: 0 6px 6px 0; margin-bottom: 8px; }
.rp-row { margin-bottom: 8px; }
.rp-row label { display: block; color: var(--fg-dim); margin-bottom: 3px; }
.rp-row input, .rp-row textarea { width: 100%; background: var(--bg-alt); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-family: inherit; font-size: 12px; resize: vertical; }
.rp-row input:focus, .rp-row textarea:focus { outline: none; border-color: var(--accent-bg); }
.rp-actions { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
.rp-actions .hint { color: var(--fg-dim); }
.rp-actions .ok { color: var(--ok); }
.rp-actions .bad { color: var(--err-fg); }
.flow .rp-tag { color: var(--tool); flex-shrink: 0; }
.dtabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 12px; flex-wrap: wrap; }
.dtab { background: none; border: 1px solid transparent; border-bottom: none; color: var(--fg-dim); padding: 5px 12px; border-radius: 6px 6px 0 0; cursor: pointer; font-family: inherit; font-size: 12px; margin-bottom: -1px; }
.dtab:hover { color: var(--fg); background: var(--bg-alt); }
.dtab.active { color: var(--accent); border-color: var(--border); border-bottom: 1px solid var(--bg); background: var(--bg); font-weight: 700; }
.dbadge { margin-left: 5px; color: var(--fg-faint); font-weight: 400; font-size: 11px; }
.dtab.active .dbadge { color: var(--fg-dim); }
.dpanel { display: none; }
.dpanel.active { display: block; }
.dpanel h4 { color: var(--accent); font-size: 12px; margin: 12px 0 4px; }
.dpanel h4:first-child { margin-top: 0; }
/* ---- 重放子页：方案 A 双栏布局（吸顶操作条 + 左编辑 / 右结果） ---- */
.rp-wrap { display: flex; flex-direction: column; }
.rp-bar { position: sticky; top: 0; display: flex; gap: 8px; align-items: center; padding: 8px 0; background: var(--bg); z-index: 5; border-bottom: 1px solid var(--border); margin-bottom: 10px; }
.rp-bar input { background: var(--bg-input); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px; font-family: inherit; font-size: 12px; }
.rp-bar input:focus { outline: none; border-color: var(--accent-bg); }
.rp-method { width: 76px; flex-shrink: 0; }
.rp-url { flex: 1; min-width: 0; }
.rp-badge { font-size: 11px; color: var(--fg-faint); flex-shrink: 0; }
.rp-badge.ok { color: var(--ok); }
.rp-badge.bad { color: var(--err-fg); }
.rp-cols { display: flex; gap: 12px; height: calc(100vh - 320px); min-height: 340px; }
.rp-left { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.rp-right { flex: 1; min-width: 0; overflow-y: auto; }
.rp-right .empty { padding-top: 60px; white-space: pre-line; }
.rp-tabs { display: flex; gap: 4px; margin-bottom: 6px; flex-shrink: 0; }
.rp-tab { background: none; border: 1px solid var(--border); color: var(--fg-dim); padding: 3px 12px; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 12px; }
.rp-tab.active { background: var(--accent-bg); border-color: var(--accent-bg); color: var(--on-accent); }
.rp-editor { flex: 1; width: 100%; background: var(--bg-alt); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 8px; font-family: inherit; font-size: 12px; resize: none; }
.rp-editor:focus { outline: none; border-color: var(--accent-bg); }
.rp-err { color: var(--err-fg); margin-top: 6px; white-space: pre-wrap; flex-shrink: 0; }
.rp-err-block { color: var(--err-fg); white-space: pre-wrap; word-break: break-all; }
.rp-result-head { margin-bottom: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.rp-result-head b { color: var(--accent); }
@media (max-width: 900px) {
	.rp-cols { flex-direction: column; height: auto; }
	.rp-editor { min-height: 240px; }
}
/* ---- 改写主 tab：规则表格 / 表单 / 引擎卡片 ---- */
.rw-body { padding: 12px 16px; overflow-y: auto; height: calc(100% - 45px); }
.rw-card { background: var(--bg-alt); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; }
.rw-card h3 { margin-top: 0; }
.rw-row { margin-bottom: 8px; max-width: 720px; }
.rw-row label { display: block; color: var(--fg-dim); margin-bottom: 3px; }
.rw-row input[type="text"], .rw-row textarea { width: 100%; background: var(--bg-input); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-family: inherit; font-size: 12px; }
.rw-row textarea { min-height: 64px; resize: vertical; }
.rw-row input:focus, .rw-row textarea:focus { outline: none; border-color: var(--accent-bg); }
.rw-row input.bad { border-color: var(--err); }
.rw-row .hint { display: block; margin-top: 3px; color: var(--fg-faint); line-height: 1.5; }
.rw-row .hint code { background: var(--bg-input); border: 1px solid var(--border); border-radius: 3px; padding: 0 3px; }
.rw-actions { display: flex; gap: 8px; align-items: center; margin-top: 6px; }
.rw-actions .hint { color: var(--fg-faint); }
.rw-engine { color: var(--fg-dim); margin-bottom: 8px; }
.rw-ok { color: var(--ok); }
.rw-bad { color: var(--err-fg); }
.rw-err { color: var(--err-fg); background: var(--bg); border-left: 3px solid var(--err); padding: 6px 10px; border-radius: 0 6px 6px 0; margin: 8px 0; white-space: pre-wrap; word-break: break-all; }
.rw-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.rw-table th { text-align: left; color: var(--fg-dim); font-weight: 400; padding: 4px 8px; border-bottom: 1px solid var(--border); }
.rw-table td { padding: 5px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.rw-table tr:last-child td { border-bottom: none; }
.rw-table tr.bad td { color: var(--err-fg); }
.rw-table td.empty { text-align: center; padding: 24px 10px; }
.rw-name { color: var(--fg); }
.rw-sum { color: var(--fg-dim); word-break: break-all; }
.rw-table tr.bad .rw-sum { color: var(--err-fg); }
.rw-ops { white-space: nowrap; }
.rw-ops .btn { padding: 2px 8px; font-size: 11px; margin-right: 4px; }
/* 引擎卡片折叠「高级」区（串行化闸门参数） */
.rw-adv { margin: 2px 0 10px; max-width: 720px; }
.rw-adv summary { cursor: pointer; color: var(--fg-dim); }
.rw-adv .rw-row { margin-top: 8px; }
/* ---- 改写标记（MetaCard 徽章 / FlowList 行内 / 规则 chips） ---- */
.rw-badge { color: var(--usage); }
.rw-badge.blocked { color: var(--err-fg); }
.rw-tag { color: var(--usage); flex-shrink: 0; }
.rw-tag.blocked { color: var(--err-fg); }
.rw-rules { color: var(--fg-dim); margin-bottom: 8px; }
.rw-chip { display: inline-block; background: var(--bg-alt); border: 1px solid var(--border); border-radius: 10px; padding: 1px 8px; margin: 0 4px 4px 0; color: var(--fg); font-size: 11px; }
/* ---- 详情页改写子 tab：原始 vs 改写后双栏对比 ---- */
.rw-cols { display: flex; gap: 12px; }
.rw-col { flex: 1; min-width: 0; }
.rw-col h5 { color: var(--fg-dim); font-weight: 400; font-size: 11px; margin: 4px 0 0; }
.rw-col pre { max-height: 360px; }
@media (max-width: 900px) {
	.rw-cols { flex-direction: column; }
}
/* ---- 全局 toast（rewrite_error / rewrite_warn / gate_warn / record_warn，任何 tab 可见） ---- */
.toasts { position: fixed; right: 16px; bottom: 16px; display: flex; flex-direction: column; gap: 8px; z-index: 100; max-width: 420px; }
.toast { padding: 8px 12px; border-radius: 6px; font-size: 12px; box-shadow: 0 4px 14px rgba(0,0,0,0.4); word-break: break-all; }
.toast.error { background: var(--err); color: var(--on-accent); }
.toast.warn { background: var(--warn); color: var(--on-accent); }
</style>
</head>
<body>
<div id="app"><div class="empty" style="padding: 40px">加载中…</div></div>
<script>${VUE_JS}</script>
<script>${APP_JS}</script>
</body>
</html>`;
}

export interface BuiltPage {
  /** 页面原文（accept-encoding 不含 gzip 时的回退）。 */
  html: string;
  /** gzip 预压缩副本，server 按 accept-encoding 直接回发。 */
  gzip: Buffer;
}

/** 组装页面（读资源 + 内联 + gzip）。纯函数：每次调用重新读取；缓存由调用方持有。 */
export function buildPage(): BuiltPage {
  const dir = resolveSrcDir();
  const vue = inlineJs(readFileSync(join(dir, "vendor", "vue.global.prod.js"), "utf8"));
  const app = inlineJs(readFileSync(join(dir, "app.js"), "utf8"));
  const html = pageHtml(vue, app);
  return { html, gzip: gzipSync(html) };
}
