// 分句与全局修饰检测（plan.md v3.2 §3.1）。
//
// 分句按标点与转折连接词切分；疑问/礼貌祈使/否定窗口/只读/取消都是分句级或
// 全文级判定，供 rules.ts 在匹配规则时逐命中调用。所有正则无嵌套量词
// （防回溯，§11.1 性能门）；模块级只有不可变常量与无状态正则（I4）——
// 带 /g 的正则一律在函数内新建，绝不复用 lastIndex。

// ───────────────────────────── 分句（§3.1） ─────────────────────────────

const DELIMS = new Set(["，", ",", "。", ".", ";", "；", "!", "！", "?", "？", "\n"]);
/** 转折/顺承连接词（`但是?` ⇒ 但 / 但是）；长词在前，避免前缀截断。 */
const CONNECTIVES: readonly string[] = ["但是", "不过", "然后", "另外", "同时", "但"];

export interface ClauseInfo {
  /** 分句文本（不含结尾分隔符；连接词本身被消费为边界）。 */
  readonly text: string;
  /** 结束该分句的标点（"" = 文末或连接词边界）。 */
  readonly delim: string;
  /** 疑问句（礼貌祈使例外已应用：例外命中时恒 false）。 */
  readonly question: boolean;
  /** 祈使 = 非疑问（§3.2 decisive 的门条件之一）。 */
  readonly imperative: boolean;
  /** 该分句在原始 prompt 中的起始码点偏移（rules.ts 用它定位命中所在分句）。 */
  readonly start: number;
  /** 结束偏移（不含）。 */
  readonly end: number;
}

/** 礼貌祈使开头：`(能|可以|麻烦)(不能)?(帮我|帮忙|你)?`（§3.1）。 */
const POLITE_OPENER_RE = /^(?:能|可以|麻烦)(?:不能)?(?:帮我|帮忙|你)?/;

/** 开头之后紧跟的动作动词（保守列表：规则表动作词的常用首字/词）。 */
const POLITE_ACTION_RE =
  /^(?:提交|推送|发布|发版|打|切|删|移除|清理|安装|升级|引入|派|开|起|跑|看|读|查|评审|审查|分析|测试|写|改|修|建|记住|继续|处理|检查|确认|合并|轮换|更新|配置|设置|填|帮|整理|总结|报|列|找|搜|梳理|对比|比较|评估|推|测|加|rebase|reset|cherry|squash|amend|checkout|stash|revert|merge|commit|push|release|dispatch|install|add|delete|remove|rm|run|test|build|fix|look|check|read|update|create|write|edit|publish|verify|review)/i;

function classifyClause(text: string, delim: string, start: number, end: number): ClauseInfo {
  const body = text.trim();
  const opener = POLITE_OPENER_RE.exec(body);
  if (opener !== null && POLITE_ACTION_RE.test(body.slice(opener[0].length))) {
    // 礼貌祈使例外：视为祈使句，疑问标志被覆盖（§3.1）。
    return { text: body, delim, question: false, imperative: true, start, end };
  }
  const question =
    delim === "?" || delim === "？" || /^(?:为什么|怎么|是不是|有没有|啥|什么)/.test(body) || /[吗么呢]$/.test(body);
  return { text: body, delim, question, imperative: !question, start, end };
}

/** 按标点与连接词切分；空白分句被丢弃；连接词作为边界被消费。 */
export function splitClauses(prompt: string): readonly ClauseInfo[] {
  const out: ClauseInfo[] = [];
  const n = prompt.length;
  let start = 0;
  let i = 0;
  const push = (end: number, delim: string): void => {
    const text = prompt.slice(start, end);
    if (text.trim() !== "") out.push(classifyClause(text, delim, start, end));
  };
  while (i < n) {
    const ch = prompt[i]!;
    if (DELIMS.has(ch)) {
      push(i, ch);
      i++;
      start = i;
      continue;
    }
    {
      // 连接词作为边界被消费，与标点同等对待（§3.1的分句正则是一个大分注进行切分，
      // 不要求连接词前面已有内容；若恢复超前检查会导致开头连接词无法切分，
      // 与 §4.3 的验算不符）。
      let matched: string | undefined;
      for (const c of CONNECTIVES) {
        if (prompt.startsWith(c, i)) {
          matched = c;
          break;
        }
      }
      if (matched !== undefined) {
        push(i, "");
        i += matched.length;
        start = i;
        continue;
      }
    }
    i++;
  }
  if (start < n) push(n, "");
  return out;
}

// ───────────────────────────── 否定窗口（§3.1 negate） ─────────────────────────────

/** 否定词表；英文两侧加 `(?<![A-Za-z])…(?![A-Za-z])`（中文不用 `\b`）。 */
const NEGATION_SRC =
  "不要|先别|别|不用|勿|禁止|不许|暂不|先不|(?<![A-Za-z])don'?t(?![A-Za-z])|(?<![A-Za-z])do\\s+not(?![A-Za-z])|(?<![A-Za-z])never(?![A-Za-z])|(?<![A-Za-z])no\\s+need\\s+to(?![A-Za-z])";

/** 否定窗口：同一分句内，动作词（位于 `actionIndex`）之前 8 个码点以内出现
 *  否定词 ⇒ true。否定词必须整体位于动作词之前（end ≤ actionIndex）。 */
export function negationWithinWindow(clauseText: string, actionIndex: number): boolean {
  const re = new RegExp(NEGATION_SRC, "g");
  for (const m of clauseText.matchAll(re)) {
    const end = m.index + m[0].length;
    if (end <= actionIndex && actionIndex - end <= 8) return true;
    if (m.index >= actionIndex) break;
  }
  return false;
}

/** 文中出现的所有否定词位置（测试与调试用）。 */
export function negationSpans(clauseText: string): readonly { start: number; end: number; word: string }[] {
  const re = new RegExp(NEGATION_SRC, "g");
  const out: { start: number; end: number; word: string }[] = [];
  for (const m of clauseText.matchAll(re)) out.push({ start: m.index, end: m.index + m[0].length, word: m[0] });
  return out;
}

// ───────────────────────────── 只读 / 取消（§3.1） ─────────────────────────────

/** 只读意图的作用对象：写动作类 tag（§3.1 readonly）。 */
export const WRITE_ACTION_TAGS: readonly string[] = [
  "git-commit",
  "git-push",
  "git-history",
  "release",
  "deletion",
  "dependencies",
  "credentials",
  "frozen-files",
];

const READONLY_RES: readonly RegExp[] = [
  /只(?:是)?(?:评审|审查|看看?|读|查|分析|review|解释)/,
  /(?:review|评审|看)(?:一下)?(?:就行|即可|就好)/,
  /不(?:改|动)(?:代码|文件)/,
  /dry[- ]?run/i,
];

/** 只读意图（全文级）：命中任一只读模式。 */
export function readonlyIntent(text: string): boolean {
  return READONLY_RES.some((re) => re.test(text));
}

const CANCEL_SRC =
  "算了|取消|停(?:下|止)?|(?<![A-Za-z])stop(?![A-Za-z])|(?<![A-Za-z])cancel(?![A-Za-z])|换(?:个)?(?:任务|话题)|先不做|不做了";

/** 取消/换任务（全文级）：作用于全部 tag 并清空承接（§3.1 / §3.3）。 */
export function cancelIntent(text: string): boolean {
  return new RegExp(CANCEL_SRC).test(text);
}
