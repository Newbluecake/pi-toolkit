/**
 * bash · ANSI 清洗（stripAnsi 包）：把模型/用户可见输出里的 ANSI 控制序列
 * （CSI/OSC/DCS/SOS/PM/APC/ESC 派发、C1 CSI/ST）剥掉，磁盘日志保持原始字节。
 *
 * 设计（为何不用 `node:util stripVTControlCharacters` 直接整串清洗）：
 * 1. node 的 regex 不认识跨 chunk 的悬空序列——`"pre\x1b[3"` + `"1mred"` 分两段到达时，
 *    前一段会被它整段吞掉或留下残片（实测 `"pre\x1b]0;tit"` → `"preit"`）。流式清洗必须
 *    自己跟踪「当前是否在一个未完结序列里」。
 * 2. node 的 regex 对常见形态也有实测缺口：冒号子参数（`\x1b[38:5:196m` → 泄 `:5:196m`）、
 *    `\x1b[>c`（泄 `c`）、带中间字节/空格的 CSI（`\x1b[1 F` → 泄 ` F`）、PM/APC，以及带
 *    参数/中间字节的 DCS（简单 DCS `\x1bPq\x1b\\` 可剥，`\x1bP0;1|1/2b` 这类整段不剥）。
 *    因此序列的切分与删除由本文件的扫描器全权负责，`stripVTControlCharacters`
 *    仅作为输出侧的兜底网（正常情况下扫描器输出不含 ESC/0x9b，该调用是证明上的 no-op；
 *    若扫描器将来误分类，它还能拦下完整序列——纵深防御）。
 *
 * 扫描器是有界状态机（I4：跨 chunk 只携带 O(1) 状态 + 一个 run 计数，不缓存文本）：
 * ground ↔ escape（ESC 后收中间字节/派发字节）/ csi（参数与中间字节直到 final
 * 0x40–0x7E）/ string（OSC `]`、DCS `P`、SOS `X`、PM `^`、APC `_` 直到 BEL / `ESC \` /
 * 0x9c）/ string-esc（string 内遇到 ESC，等待是否 `\`）。同一非 ground 状态连续吞掉
 * `ANSI_STATE_RUN_CAP` 个字符仍未完结 ⇒ 判为垃圾强制回 ground（未终结的 OSC 标题等
 * 不会再无限吞输出——损失有界）。
 *
 * `finish()`：流结束时调用。未完结的 carry（状态）直接丢弃——不泄裸 ESC、不补发任何
 * 控制字节。`enabled: false` ⇒ 恒等透传（每个字节原样返回）。
 */
import { stripVTControlCharacters } from "node:util";

/** 同一未完结序列最多吞掉多少字符后强制判垃圾（有界 carry：内存 O(1)，输出损失有界）。 */
export const ANSI_STATE_RUN_CAP = 4_096;

/** B 点（readOutput）非零 startOffset 的前看窗口：够盖住 `…\x1b[38;5;` + 参数尾巴这类残片。 */
export const ANSI_LOOKBACK_BYTES = 256;

type AnsiState = "ground" | "escape" | "csi" | "string" | "string-esc";

interface ScanResult {
  /** 本次输入里落地的可见文本。 */
  text: string;
  /** 输入末尾所处的状态（跨 chunk carry）。 */
  state: AnsiState;
  /** 当前非 ground 状态已连续吞掉的字符数（cap 判据）。 */
  run: number;
}

/**
 * 纯函数扫描：从给定状态出发吃完整段文本，返回落地文本与末状态。
 * 不抛异常、不分配除输出串外的结构；OOB 安全（charAt 越界返回 ""）。
 */
function scan(text: string, state: AnsiState, run: number): ScanResult {
  let out = "";
  let st: AnsiState = state;
  let consumed = run;
  let i = 0;
  const n = text.length;
  // 在非 ground 状态里再吞一个字符；超过 cap ⇒ 强制判垃圾回 ground。
  const step = (): void => {
    consumed++;
    if (consumed >= ANSI_STATE_RUN_CAP) {
      st = "ground";
      consumed = 0;
    }
  };
  const land = (): void => {
    st = "ground";
    consumed = 0;
  };
  while (i < n) {
    const ch = text.charAt(i);
    const code = text.charCodeAt(i);
    switch (st) {
      case "ground": {
        if (code === 0x1b) {
          st = "escape";
          consumed = 1;
          i++;
        } else if (code === 0x9b) {
          // C1 CSI（UTF-8 解码后的 U+009B），等价 ESC [
          st = "csi";
          consumed = 1;
          i++;
        } else if (code === 0x9c) {
          i++; // 游离 C1 ST：控制字节，静默丢弃
        } else {
          out += ch;
          i++;
        }
        break;
      }
      case "escape": {
        if (code === 0x5b) {
          // [ → CSI
          st = "csi";
          step();
          i++;
        } else if (code === 0x5d || code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) {
          // ] P X ^ _ → OSC/DCS/SOS/PM/APC 字符串序列
          st = "string";
          step();
          i++;
        } else if (code === 0x1b) {
          step(); // 连续 ESC：丢弃前一个，继续等派发字节
          i++;
        } else if (code === 0x9b) {
          st = "csi";
          step();
          i++;
        } else if (code >= 0x20 && code <= 0x2f) {
          step(); // 中间字节（ESC ( B 的 "(" 等），继续等 final
          i++;
        } else if (code >= 0x30 && code <= 0x7f) {
          land(); // final：完整 2+ 字节 ESC 派发，整段丢弃
          i++;
        } else {
          // 控制字符 / 非 ASCII 跟在 ESC 后：只丢 ESC，该字符回 ground 重判（不吞正文）
          land();
        }
        break;
      }
      case "csi": {
        if ((code >= 0x20 && code <= 0x3f) || code === 0x9b) {
          step(); // 参数 / 中间字节（含冒号子参数、? > = 等私有前缀）
          i++;
        } else if (code >= 0x40 && code <= 0x7e) {
          land(); // final：完整 CSI，整段丢弃
          i++;
        } else if (code === 0x1b) {
          st = "escape"; // 新的引导符：放弃当前序列，从它重开
          consumed = 1;
          i++;
        } else {
          land(); // 控制字符 / 非 ASCII：序列作废，该字符回 ground 重判
        }
        break;
      }
      case "string": {
        if (code === 0x07 || code === 0x9c) {
          land(); // BEL / C1 ST 终结（OSC 常用 BEL）
          i++;
        } else if (code === 0x1b) {
          st = "string-esc"; // 可能是 ESC \ (ST) 的前半
          step();
          i++;
        } else {
          step(); // 序列体（标题/payload），吞掉
          i++;
        }
        break;
      }
      case "string-esc": {
        if (code === 0x5c) {
          land(); // ESC \ = ST：字符串序列终结，整段丢弃
          i++;
        } else if (code === 0x1b) {
          step(); // 又一个 ESC：旧的丢弃，继续等
          i++;
        } else if (code === 0x07 || code === 0x9c) {
          land();
          i++;
        } else {
          st = "string"; // ESC 后不是 \：那个 ESC 是序列体内的噪声，继续吞体
          step();
          i++;
        }
        break;
      }
    }
  }
  return { text: out, state: st, run: consumed };
}

export interface AnsiStripper {
  /** 喂一段输出，返回本次落地的可见文本（可为空串）。 */
  push(chunk: string): string;
  /** 流结束：丢弃未完结序列（不补发任何字节），重置状态。恒返回 ""。 */
  finish(): string;
}

export interface CreateAnsiStripperOptions {
  /** `false` = 恒等透传（bashJobs.stripAnsi: false）；缺省 = 开。 */
  enabled?: boolean;
}

/**
 * 每次 exec 独立创建（I4：状态只活在闭包里，无模块级可变状态）。
 * 跨 chunk carry = O(1) 状态 + run 计数，被 `ANSI_STATE_RUN_CAP` 封顶。
 */
export function createAnsiStripper(options: CreateAnsiStripperOptions = {}): AnsiStripper {
  if (options.enabled === false) {
    return { push: (chunk) => chunk, finish: () => "" };
  }
  let state: AnsiState = "ground";
  let run = 0;
  return {
    push(chunk: string): string {
      const result = scan(chunk, state, run);
      state = result.state;
      run = result.run;
      // 兜底网（见文件头）：扫描器输出按构造不含 ESC/0x9b，此调用正常是 no-op。
      return stripVTControlCharacters(result.text);
    },
    finish(): string {
      state = "ground";
      run = 0;
      return "";
    },
  };
}

/** one-shot 清洗（等价于 createAnsiStripper 单次 push + finish；末尾未完结序列丢弃）。 */
export function stripAnsiText(text: string): string {
  if (text.length === 0) return text;
  const stripper = createAnsiStripper();
  const out = stripper.push(text);
  stripper.finish();
  return out;
}

/**
 * B 点（readOutput）one-shot 清洗一个非零偏移的切片：`lookback` 是 startOffset 之前
 * ≤`ANSI_LOOKBACK_BYTES` 字节的原始日志（容忍首字符是跨多字节字符切出的 U+FFFD——
 * 状态推导只关心 ASCII 结构）。判据只有一条：对 lookback 从 ground 扫一遍，落点非
 * ground ⇒ 切片从该状态续扫——窗口内必须有明确的 ESC/0x9b 引导证据才按中截残片剥离。
 * 纯数字/分号前缀（哪怕是整窗 CSI 参数字节）**不**触发任何启发式：漏检的长参数序列
 * 只是残片上限，误删普通文本不可接受（`"789;111 other text"` + 数字 lookback 必须原样）。
 *
 * 末尾未完结序列照常丢弃（one-shot 语义）。
 */
export function stripAnsiSlice(content: string, lookback: string): string {
  if (content.length === 0) return content;
  const pre = scan(lookback, "ground", 0);
  const state: AnsiState = pre.state === "string-esc" ? "string" : pre.state;
  const result = scan(content, state, 0);
  return stripVTControlCharacters(result.text);
}
