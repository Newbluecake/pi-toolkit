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
  copyPath: "复制路径",
  truncatedBadge: "已截断",
  truncatedNote: "仅显示前 {size}——复制只取已显示部分。",
  truncatedRenderNote: "仅显示前 {size}——结尾可能不完整。",
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
  errorTitle: "预览失败",
  dirNavLabel: "预览导航",
  dirBack: "返回",
  dirUp: "上级目录",
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
} satisfies Messages<typeof en>;

export default preview;
