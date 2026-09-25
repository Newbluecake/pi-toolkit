#!/usr/bin/env node
/**
 * Experiment 6 — Part B analysis (README §5 criteria). Reads /tmp/exp6-runs
 * and /tmp/exp6-judge, writes part-b.tsv, judge-scores.tsv, answers.md,
 * judge-map.json and part-b-summary.json into docs/dev/consult/exp-trim/.
 *
 *   npx tsx scripts/exp/exp6-analyze.ts
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RUNS = process.env.EXP6_RUNS ?? "/tmp/exp6-runs"; // archived copy: docs/dev/consult/exp-trim/raw/runs
const JUDGE = process.env.EXP6_JUDGE ?? "/tmp/exp6-judge"; // archived copy: docs/dev/consult/exp-trim/raw/judge
const OUT = "docs/dev/consult/exp-trim";
const OPUS_W = 6.25,
  OPUS_R = 0.5,
  OPUS_O = 25;

type Run = Record<string, any>;
const runs: Run[] = readdirSync(RUNS)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(RUNS, f), "utf8")));
runs.sort((a, b) => a.id.localeCompare(b.id));
const map: Record<string, string> = JSON.parse(readFileSync(join(JUDGE, "map.json"), "utf8"));
const idOf = Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k]));
const judges = ["sonnet", "glm"];
const verdicts: Record<string, Record<string, any>> = {}; // judge → blindId → verdict obj
for (const j of judges) {
  verdicts[j] = {};
  for (const b of ["edoc", "ec1", "ec2"]) {
    const r = JSON.parse(readFileSync(join(JUDGE, `${j}-${b}.json`), "utf8"));
    if (!r.parsed) throw new Error(`${j}-${b} unparsed`);
    Object.assign(verdicts[j]!, r.parsed);
  }
}
const judgeCost = judges
  .flatMap((j) =>
    ["edoc", "ec1", "ec2"].map(
      (b) => JSON.parse(readFileSync(join(JUDGE, `${j}-${b}.json`), "utf8")).costUsd as number,
    ),
  )
  .reduce((a, b) => a + b, 0);

/** "B-form opus" sensitivity: every non-cache-read prompt token priced as a cache write. */
const opusB = (u: any) =>
  (((u.input ?? 0) + (u.cacheWrite ?? 0)) * OPUS_W + (u.cacheRead ?? 0) * OPUS_R + (u.output ?? 0) * OPUS_O) / 1e6;

const D = ["D1", "D2", "D3", "D4", "D5", "D6", "D7"];
const Q = ["Q1", "Q2", "Q3", "Q4", "Q5"];
const norm = (v: unknown) => String(Array.isArray(v) ? v[0] : v).trim();
function scoreOf(run: Run, j: string): { score: number; fab: number; urgent: boolean; items: string[] } {
  const v = verdicts[j]![idOf[run.id]!];
  if (!v) throw new Error(`missing verdict ${j} ${run.id}`);
  if (run.expert.startsWith("edoc")) {
    const items = D.map((d) => norm(v[d]));
    const urgent = Array.isArray(v.urgentAsCurrent)
      ? v.urgentAsCurrent[0] === true || v.urgentAsCurrent[0] === "true"
      : v.urgentAsCurrent === true;
    return { score: items.filter((x) => x === "正确").length, fab: (v.fabrications ?? []).length, urgent, items };
  }
  const items = Q.map((q) => norm(v[q]));
  const score = items.reduce((a, x) => a + (x === "正确" ? 1 : x === "部分" ? 0.5 : 0), 0);
  return { score, fab: items.filter((x) => x === "编造").length, urgent: false, items };
}

const rows = runs.map((r) => {
  const s = Object.fromEntries(judges.map((j) => [j, scoreOf(r, j)]));
  const agree = s.sonnet!.items.filter((x: string, i: number) => x === s.glm!.items[i]).length;
  const opusBTotal = r.perTurn.reduce((a: number, u: any) => a + opusB(u), 0);
  const reread = r.toolCalls.map(
    (c: any) => `${c.name}:${String(c.args.path ?? "").replace(/.*\//, "")}${c.args.offset ? `@${c.args.offset}` : ""}`,
  );
  return {
    ...r,
    blindId: idOf[r.id],
    s,
    agree,
    nItems: s.sonnet!.items.length,
    score: (s.sonnet!.score + s.glm!.score) / 2,
    fab: (s.sonnet!.fab + s.glm!.fab) / 2,
    urgentAny: s.sonnet!.urgent || s.glm!.urgent,
    opusBTotal,
    opusBFirst: opusB(r.perTurn[0] ?? {}),
    reread,
    inProd: !r.overProdTime && !r.overProdTurns,
  };
});

// ---- per-run TSV
const h = [
  "run",
  "blindId",
  "model",
  "elided",
  "firstReqTok",
  "firstIn",
  "firstCW",
  "firstCR",
  "firstUsd",
  "firstOpusB",
  "turns",
  "tools",
  "wallS",
  "totalUsd",
  "totalOpusEq",
  "totalOpusB",
  ">150s",
  ">3turns",
  "chars",
  "sonnet",
  "glm",
  "mean",
  "fabS",
  "fabG",
  "urgentS",
  "urgentG",
  "agree",
  "tools_detail",
];
const tsv = [h.join("\t")];
for (const r of rows)
  tsv.push(
    [
      r.id,
      r.blindId,
      r.model,
      r.elidedToolResults,
      r.firstRequest.total,
      r.firstRequest.input,
      r.firstRequest.cacheWrite,
      r.firstRequest.cacheRead,
      r.firstRequest.costUsd.toFixed(4),
      r.opusBFirst.toFixed(4),
      r.turns,
      r.toolCalls.length,
      (r.wallMs / 1000).toFixed(1),
      r.costUsd.toFixed(4),
      r.opusEq.toFixed(4),
      r.opusBTotal.toFixed(4),
      r.overProdTime ? "Y" : "",
      r.overProdTurns ? "Y" : "",
      r.answerChars,
      r.s.sonnet.score,
      r.s.glm.score,
      r.score,
      r.s.sonnet.fab,
      r.s.glm.fab,
      r.s.sonnet.urgent ? "Y" : "",
      r.s.glm.urgent ? "Y" : "",
      `${r.agree}/${r.nItems}`,
      r.reread.join(","),
    ].join("\t"),
  );
writeFileSync(join(OUT, "part-b.tsv"), tsv.join("\n") + "\n");

// ---- judge item-level TSV
const jt = ["run\tblindId\tjudge\t" + [...D, "|", ...Q].join("\t") + "\tfabrications/urgent"];
for (const r of rows)
  for (const j of judges) {
    const v = verdicts[j]![r.blindId];
    const items = r.expert.startsWith("edoc") ? D.map((d) => norm(v[d])) : Q.map((q) => norm(v[q]));
    const extra = r.expert.startsWith("edoc")
      ? `urgent=${r.s[j].urgent}; fab=${JSON.stringify(v.fabrications ?? [])}`
      : "";
    jt.push([r.id, r.blindId, j, ...items, extra].join("\t"));
  }
writeFileSync(join(OUT, "judge-scores.tsv"), jt.join("\n") + "\n");
writeFileSync(join(OUT, "judge-map.json"), JSON.stringify(map, null, 2) + "\n");
writeFileSync(
  join(OUT, "answers.md"),
  "# 实验 6 Part B 全部回答（run id ↔ 盲评 ID 见 judge-map.json）\n\n" +
    rows
      .map((r) => `## ${r.id}（${r.blindId}）\n\n工具调用：${r.reread.join(", ") || "无"}\n\n${r.answer}\n`)
      .join("\n"),
);

// ---- group summary
const cls = (r: Run) => (r.expert.startsWith("edoc") ? "E-doc" : r.expert.toUpperCase());
const groups = new Map<string, typeof rows>();
for (const r of rows) {
  for (const key of [`${cls(r)}|${r.arm}`, `${r.expert.startsWith("edoc") ? "E-doc" : "E-code"}|${r.arm}`]) {
    const g = groups.get(key) ?? [];
    if (!g.includes(r)) g.push(r);
    groups.set(key, g);
  }
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const summary: Record<string, any> = {};
for (const [k, g] of [...groups.entries()].sort()) {
  summary[k] = {
    n: g.length,
    score: mean(g.map((r) => r.score)),
    scoreSonnet: mean(g.map((r) => r.s.sonnet.score)),
    scoreGlm: mean(g.map((r) => r.s.glm.score)),
    fabSum: g.reduce((a, r) => a + r.fab, 0),
    urgentAny: g.filter((r) => r.urgentAny).length,
    firstTok: mean(g.map((r) => r.firstRequest.total)),
    firstUsd: mean(g.map((r) => r.firstRequest.costUsd)),
    firstOpusB: mean(g.map((r) => r.opusBFirst)),
    totalUsd: mean(g.map((r) => r.costUsd)),
    totalOpusEq: mean(g.map((r) => r.opusEq)),
    totalOpusB: mean(g.map((r) => r.opusBTotal)),
    turns: mean(g.map((r) => r.turns)),
    tools: mean(g.map((r) => r.toolCalls.length)),
    wallS: mean(g.map((r) => r.wallMs / 1000)),
    maxWallS: Math.max(...g.map((r) => r.wallMs / 1000)),
    over150: g.filter((r) => r.overProdTime).length,
    over3turns: g.filter((r) => r.overProdTurns).length,
    inProdRate: g.filter((r) => r.inProd).length / g.length,
    chars: mean(g.map((r) => r.answerChars)),
  };
}
const agreeAll = rows.reduce((a, r) => a + r.agree, 0);
const itemsAll = rows.reduce((a, r) => a + r.nItems, 0);
const agreeBy = (p: (r: Run) => boolean) => {
  const g = rows.filter(p);
  return `${g.reduce((a, r) => a + r.agree, 0)}/${g.reduce((a, r) => a + r.nItems, 0)}`;
};
const out = {
  groups: summary,
  agreement: {
    all: `${agreeAll}/${itemsAll}`,
    edoc: agreeBy((r) => r.expert.startsWith("edoc")),
    ecode: agreeBy((r) => !r.expert.startsWith("edoc")),
  },
  spend: { runs: rows.reduce((a, r) => a + r.costUsd, 0), judges: judgeCost },
};
writeFileSync(join(OUT, "part-b-summary.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
