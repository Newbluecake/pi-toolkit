/**
 * `preview` i18n namespace, Chinese (web-hub-preview plan v3 §3.2/§4.6 — PV5). `satisfies
 * Messages<typeof en>` makes a missing/extra key a `vue-tsc` compile error at authoring time
 * (`i18n-parity.test.ts` also checks it — and the `{param}` sets — at runtime).
 */
import en from "../en/preview.js";

type Messages<T> = { [K in keyof T]: string };

const preview = {
  dialogLabel: "文件预览",
  close: "关闭",
  retry: "重试",
  retryAfter: "可在 {n} 秒后重试。",
  loading: "正在加载预览…",
  plaintextWarning: "当前为明文连接——你预览的内容可能被网络中的他人看到。",
  fit: "适应窗口",
  actualSize: "原始尺寸",
  zoomIn: "放大",
  zoomOut: "缩小",
  fullscreen: "全屏",
  exitFullscreen: "退出全屏",
  copyPath: "复制路径",
  truncatedBadge: "已截断",
  truncatedNote: "仅显示前 {loaded}（共 {total}）——复制只取已显示部分。",
  truncatedRenderNote: "仅显示前 {loaded}（共 {total}）——结尾可能不完整。",
  streamProgress: "已加载 {loaded} / 共 {total}",
  streamLoading: "正在加载下一段…",
  streamLoadMore: "加载更多",
  streamWaiting: "服务繁忙，{n} 秒后重试…",
  streamCap: "已加载 {loaded} / 共 {total}，已达预览上限——完整内容请下载",
  streamChanged: "文件在预览期间已变更，已停止加载",
  streamReopen: "重新打开",
  streamError: "继续加载失败（{code}）",
  streamRetry: "重试",
  streamSegSource: "此段过于复杂，以源码显示",
  streamBudgetSource: "后续内容过多，已改为源码显示",
  streamTailIncomplete: "结尾可能不完整",
  unsupportedTitle: "无法预览",
  unsupportedBody: "此文件不能预览（{reason}）。",
  reasonBinary: "二进制文件",
  reasonNotRegular: "非常规文件",
  reasonDimsUnknown: "无法识别的图片",
  reasonGeneric: "不支持的内容",
  fileSize: "大小：{size}",
  tooLargeTitle: "文件过大，无法预览",
  tooLargePixels: "图片为 {w} × {h}，超出浏览器预览预算。",
  tooLargeBytes: "文件大小 {size}，超出 {max} 的预览上限。",
  tooLargeGeneric: "此文件超出预览上限。",
  viewRendered: "渲染",
  viewSource: "源码",
  viewToggleLabel: "Markdown 显示方式",
  mdTooComplex: "此文件结构过于复杂，无法渲染——已改以源码显示。",
  // md-preview-html plan：行内图片占位原因（占位 chip：`🖼 <alt> · <原因>`）
  "mdImg.loading": "加载中…",
  "mdImg.unavailable": "不可预览",
  "mdImg.denied": "没有访问权限",
  "mdImg.tooLarge": "超出图片预览大小限制",
  "mdImg.failed": "加载失败",
  "mdImg.timeout": "加载超时",
  "mdImg.limit": "超出单文档图片数量上限",
  "mdImg.budget": "超出文档图片总量预算",
  errorTitle: "预览失败",
  dirNavLabel: "预览导航",
  dirBack: "返回",
  dirUp: "上级目录",
  dirPathLabel: "跳转到路径",
  dirPathPlaceholder: "/路径 或 ~/路径",
  dirPathGo: "前往",
  dirPathForbidden: "路径不能包含 NUL、CR 或 LF 字符。",
  dirPathTooLong: "路径超出 UTF-8 编码的 {max} 字节上限。",
  dirCount: "{n} 项",
  dirCountAtLeast: "≥ {n} 项",
  dirEmpty: "空目录。",
  dirLimitScan: "目录过大，只读取了前 {n} 项。",
  dirLimitEntries: "只显示前 {shown} 项（共 {total} 项）。",
  dirLimitBytes: "名字过长，只显示前 {n} 项。",
  dirDropped: "{n} 个名字过长的条目未列出。",
  dirVanished: "{n} 个条目在列举期间消失。",
  dirStatPartial: "部分条目的大小或修改时间未知。",
  dirProtected: "受保护条目不显示。",
  dirTypeDir: "目录",
  dirTypeFile: "文件",
  dirTypeSymlink: "符号链接",
  dirTypeOther: "特殊文件",
  // preview-tree（目录行内展开 —— chevron 展开/折叠；点名字仍是进入目录）
  dirExpand: "内联展开",
  dirCollapse: "收起",
  dirTreeLoading: "加载中…",
  dirTreeError: "展开失败：",
  dirTreeLimitDirs: "展开的文件夹过多（上限 {n} 个）——请先收起一些。",
  dirTreeLimitEntries: "已达到树行数预算（{n} 行）——请先收起部分文件夹。",
  // 2026-10 交互调整：目录行单击内联展开，双击进入
  dirRowHint: "单击展开/折叠，双击进入",
  // preview-windows（W2，plan r2 §9）：多窗口非模态预览的文案。窗口标题读屏前缀（sr-only，
  // 与可见 basename 拼成 §5.3 的「文件预览：x」）、上限提示、
  // 手机叠层徽标读屏文案、标题栏键盘提示、窗口菜单。
  windowLabel: "文件预览：",
  windowLimit: "已达 {n} 个窗口上限，已在当前窗口打开",
  windowStackLabel: "第 {i} 个窗口，共 {n} 个",
  windowMoveHint: "拖动标题栏移动；方向键移动，Shift+方向键调整大小；Ctrl+` 在对话与窗口间切换",
  windowMenu: "窗口操作",
  windowCloseAll: "全部关闭（{n}）",
  windowResetGeom: "重置位置和大小",
  // 2026-10-22 L1：桌面端最大化/恢复（标题栏按钮 + 双击标题栏 + 窗口菜单）
  windowMaximize: "最大化窗口",
  windowRestore: "恢复窗口大小",
  // preview-download（对话框头部的文件下载按钮 —— 仅文件，目录没有）
  download: "下载",
  downloadFailed: "下载失败 — 请重试。",
  unsupportedDownload: "该文件类型不支持预览 — 可直接下载。",
  // web-hub-html-preview 计划 v2 §5（P2）：沙箱 HTML 入口预览。散文文案（zh）；紧凑标记
  // （徽标/状态后缀）一律不在此处新增。
  htmlToggleLabel: "HTML 显示方式",
  htmlOpenTab: "新标签页打开",
  htmlMaybeStale: "预览可能已过期 — 页面若加载失败，可刷新。",
  htmlExpired: "链接已过期，刷新以继续加载。",
  htmlReload: "重新加载",
  // preview-windows plan §8.2 (W3): tab-local FIFO eviction notice for the HTML cap.
  htmlMaybeEvicted:
    "这个页面的访问凭据可能已被后来打开的 HTML 预览挤掉（同一登录最多保留 8 个）。页面里的链接或资源加载失败时，点「重新加载」。",
  htmlLoadingSlow: "仍在加载…",
  htmlNote: "页面脚本在沙箱中运行，可访问外网与本目录文件，无法访问 hub。",
  htmlMintFailed: "无法建立渲染预览（{code}）——已切换为源码显示。",
  "htmlDenied.dirTooBroad": "该文件所在目录范围过大（根 / 家目录等），仅能以源码查看。",
  "htmlDenied.upload": "上传存储中的 HTML 不支持渲染，仅能以源码查看。",
} satisfies Messages<typeof en>;

export default preview;
