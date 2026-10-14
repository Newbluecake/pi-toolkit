/**
 * 外部 agent 结构化输出提取（external-agent plan §2.12，P1 冻结面纯函数）。
 * droid run 没有 StructuredOutput 工具——schema 答案从最终文本的 ```json 围栏块提取（§5.2）。
 */

/**
 * 取最后一个 ```json（或 ``` 无语言标注但内容以 { / [ 开头）围栏块解析；
 * 否则整段 trim 后以 { / [ 开头时整体解析；都失败 ⇒ ok:false。
 */
export function extractStructuredJson(text: string): { ok: true; value: unknown } | { ok: false } {
  // 只认闭合围栏：```[语言]\n 内容 ```。未闭合的 ``` 不算围栏块。
  const fenceRe = /```([^\n]*)\n([\s\S]*?)```/g;
  let last: { content: string } | undefined;
  for (const m of text.matchAll(fenceRe)) {
    const lang = (m[1] ?? "").trim().toLowerCase();
    const content = m[2] ?? "";
    const qualifies = lang === "json" || (lang === "" && /^[\s]*[{\[]/.test(content));
    if (qualifies) last = { content };
  }
  if (last !== undefined) {
    try {
      return { ok: true, value: JSON.parse(last.content) };
    } catch {
      /* 落到整段解析 */
    }
  }
  const whole = text.trim();
  if (whole.startsWith("{") || whole.startsWith("[")) {
    try {
      return { ok: true, value: JSON.parse(whole) };
    } catch {
      return { ok: false };
    }
  }
  return { ok: false };
}
