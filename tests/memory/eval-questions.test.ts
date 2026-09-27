// Self-check for docs/dev/memory/eval/questions.json (§11.2's frozen
// question set, per 主会话裁定 item 2): `must`/`mustNot` are plain
// case-insensitive regexes matched against the final answer text only, so
// a wrong answer that merely CONTAINS a `must` keyword — negated, reversed,
// or wrapped in "X, but not Y" — must still be caught by `mustNot`. This
// test loads the frozen JSON (no duplicated copy) and, for every question,
// asserts one hand-written correct sample is judged correct and one or more
// adversarial wrong samples (built to reuse the question's own `must`
// keywords under negation) are judged incorrect. It never reaches into
// src/ — this is a pure regex self-check of the eval fixture, independent
// of any renderer.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUESTIONS_PATH = join(HERE, "..", "..", "docs", "dev", "memory", "eval", "questions.json");

interface EvalQuestion {
  id: string;
  class: string;
  question: string;
  source: string;
  must: string[];
  mustNot: string[];
}

interface QuestionsFile {
  questions: EvalQuestion[];
}

const file = JSON.parse(readFileSync(QUESTIONS_PATH, "utf8")) as QuestionsFile;
const byId = new Map(file.questions.map((q) => [q.id, q]));

/** §11.2's judging rule: every `must` matches (case-insensitive) AND no
 *  `mustNot` matches. Mirrors the (not-yet-written) E1 runner's judge. */
function isCorrect(q: EvalQuestion, answer: string): boolean {
  const mustOk = q.must.every((re) => new RegExp(re, "i").test(answer));
  const mustNotOk = q.mustNot.every((re) => !new RegExp(re, "i").test(answer));
  return mustOk && mustNotOk;
}

interface Sample {
  id: string;
  correct: string;
  wrong: string[];
}

// One correct sample (echoes the real fact) and at least one adversarial
// wrong sample per question. Every wrong sample below deliberately reuses
// the question's own `must` keyword(s), negated/reversed/contrasted, to
// prove `mustNot` — not just `must` — is doing real work (this is exactly
// the class of bug 主会话 flagged: "Q1「使用 git commit，但不需要精确路径」
// 这类错误答案仍命中全部 must").
const samples: Sample[] = [
  {
    id: "Q1",
    correct: "使用 git commit 提交代码时必须给出精确的文件路径。",
    wrong: ["使用 git commit，但不需要精确路径，可以用 git add -A。", "git commit 时无需 exact 的路径，随便加就行。"],
  },
  {
    id: "Q2",
    correct: "遇到 stream 中断或 502 时，直接 resume 换线续跑。",
    wrong: ["遇到 502 时应该先问用户要不要 resume。", "遇到 stream 中断时不用 resume，重新开一个会话就行。"],
  },
  {
    id: "Q3",
    correct: "开发包用 claude-sonnet-5，验收用 gpt-5.6-sol。",
    wrong: [
      "开发和验收都用同一个模型 claude-sonnet-5，验收不用 gpt-5.6-sol。",
      "验收不是 gpt-5.6-sol，是别的模型；开发是 claude-sonnet-5。",
    ],
  },
  {
    id: "Q4",
    correct: "本机 concurrencyLimit 是 10，也就是并发上限为 10。",
    wrong: ["并发没有上限，可以随意开，不受 concurrencyLimit 限制。"],
  },
  {
    id: "Q5",
    correct: "1h 与 5m 的 prompt cache 是分离的，不能互相读。",
    wrong: ["1h 与 5m 的 prompt cache 可以互相读，都可以读，不用担心分离。"],
  },
  {
    id: "Q6",
    correct: "判断缓存命中应该用 0.5 作为基准比例。",
    wrong: ["判断缓存命中不该用 0.5 这个基准，应该看别的信号。"],
  },
  {
    id: "Q7",
    correct: "quota 5h 窗口的阶梯阈值是 50、75、90。",
    wrong: ["quota 5h 窗口的阈值不是 50、75、90，而是 60、80、95。"],
  },
  {
    id: "Q8",
    correct: "真机验收用 tmux 起一个独立 pi 实例，靠 send-keys 输入驱动。",
    wrong: ["真机验收不需要 tmux，直接手动开一个终端就行。"],
  },
  {
    id: "Q9",
    correct: "这台机器的 bash 工具实际跑的是 zsh。",
    wrong: ["这台机器不是 zsh，是普通的 bash。"],
  },
  {
    id: "Q10",
    correct: "consult fork 不需要裁剪工具输出。",
    wrong: ["consult fork 需要裁剪工具输出，避免上下文太大。"],
  },
];

describe("docs/dev/memory/eval/questions.json — must/mustNot self-check", () => {
  it("covers every frozen question id exactly once", () => {
    expect(new Set(samples.map((s) => s.id))).toEqual(new Set(byId.keys()));
  });

  for (const sample of samples) {
    const q = byId.get(sample.id);
    it(`${sample.id} — correct sample judged correct`, () => {
      expect(q).toBeDefined();
      expect(isCorrect(q as EvalQuestion, sample.correct)).toBe(true);
    });

    sample.wrong.forEach((wrongAnswer, i) => {
      it(`${sample.id} — wrong sample #${i + 1} judged incorrect`, () => {
        expect(q).toBeDefined();
        expect(isCorrect(q as EvalQuestion, wrongAnswer)).toBe(false);
      });
    });
  }
});
