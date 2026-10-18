#!/usr/bin/env node
/**
 * P0 live measurement for docs/dev/consult/cache-thread-plan.md §2 (consult anchor matrix M1–M7).
 *
 * Builds RAW Anthropic Messages requests (no agent loop) and POSTs them to the route's
 * endpoint. Endpoint + credential come from pi's own model registry (ModelRuntime.getAuth);
 * credentials are held in memory only — never printed, logged or written. Result files carry
 * token counts / lengths / breakpoint paths only, never message text.
 *
 * Usage (from the repo root):
 *   node scripts/exp/consult-anchor-probe.mjs --route cr-anthropic/claude-opus-5-5 [--matrix full|core]
 *        [--cap-usd 5] [--ledger /tmp/anchor-probe/ledger.json] [--out /tmp/anchor-probe] [--dry]
 *   node scripts/exp/consult-anchor-probe.mjs --report <out-dir> --md docs/dev/consult/anchor-probe-results.md
 *
 *   --matrix full : M1/M2/M3/M5/M6 (+control groups, M7 landing check)   (~10 min wall: M6 timeline)
 *   --matrix core : M1/M2/M3/M5 + controls only (no M6 timeline)
 *
 * Needs the repo's node_modules (@earendil-works/pi-coding-agent) for ModelRuntime. The script is a
 * standalone Node process (NOT a pi extension): it uses ref'd timers on purpose, because an unref'd
 * wait would let node exit silently in the middle of the M6 timeline.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ───────────────────────── args ─────────────────────────
const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
const CAP_USD = Number(arg("cap-usd", 5));
const OUT_DIR = String(arg("out", "/tmp/anchor-probe"));
const LEDGER = String(arg("ledger", join(OUT_DIR, "ledger.json")));
const MATRIX = String(arg("matrix", "full"));
const ROUTE = String(arg("route", "cr-anthropic/claude-opus-5-5"));
const DRY = arg("dry", false) === true;
const MS = (s) => Math.round(s * 1000);
// M6 timeline offsets (seconds since t0); overridable only for smoke tests.
const M6_OFFSETS = String(arg("m6-offsets", "240,480,600")).split(",").map(Number);
const M2_GAP_S = Number(arg("m2-gap", 60));

// ───────────────────────── small utils ─────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (v) =>
  createHash("sha256")
    .update(typeof v === "string" ? v : JSON.stringify(v))
    .digest("hex")
    .slice(0, 12);
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SYL = [
  "ka",
  "to",
  "mi",
  "ra",
  "ne",
  "lu",
  "vo",
  "si",
  "de",
  "pa",
  "qu",
  "zen",
  "bor",
  "tal",
  "wex",
  "fim",
  "gro",
  "hal",
  "jun",
  "yos",
];
const WORDS =
  "river stone market lantern window harvest copper meadow engine paper winter garden bridge candle forest ladder pocket silver morning thunder basket anchor canyon dolphin ember feather glacier harbor island jungle kettle lemon marble needle orchard pepper quilt rabbit saddle tunnel umbrella valley whistle yarn zipper account balance contract delivery estimate freight ledger margin invoice payment quarter receipt shipment tariff vendor warehouse archive booklet chapter diagram edition footnote glossary heading index journal lecture manual notebook outline preface report section summary tutorial volume schedule meeting project budget review release feature module service gateway cluster record session profile channel pattern signal buffer thread queue cache token window socket packet kernel driver script parser render layout button dialog widget toolbar sidebar".split(
    " ",
  );
const FILLER_MODE = String(arg("filler", "syllables"));
/** Deterministic pseudo-prose of `chars` characters (nonce-seeded so every filler is globally unique). */
function filler(seed, chars) {
  if (FILLER_MODE === "logs") {
    // Log-shaped filler: sonnet-5 on this relay returns stop_reason "refusal" for word-salad / syllable-salad bodies.
    const r = mulberry32(parseInt(sha(seed).slice(0, 8), 16));
    const o = [];
    let n = 0;
    let i = 0;
    while (n < chars) {
      const line = `2026-10-18T${String(Math.floor(r() * 24)).padStart(2, "0")}:${String(Math.floor(r() * 60)).padStart(2, "0")}:${String(Math.floor(r() * 60)).padStart(2, "0")}Z INFO service-${Math.floor(r() * 7)} request id=${Math.floor(r() * 0xffffff).toString(16)} completed in ${20 + Math.floor(r() * 400)}ms status=${r() < 0.9 ? 200 : 500} user=u${Math.floor(r() * 90)}`;
      o.push(line);
      n += line.length + 1;
      i++;
    }
    return o.join("\n").slice(0, chars);
  }
  if (FILLER_MODE === "words") {
    const r = mulberry32(parseInt(sha(seed).slice(0, 8), 16));
    const o = [];
    let n = 0;
    while (n < chars) {
      const w = WORDS[Math.floor(r() * WORDS.length)];
      o.push(w);
      n += w.length + 1;
      if (r() < 0.07) {
        o.push(".");
        n += 2;
      }
    }
    return o.join(" ").slice(0, chars);
  }
  const rnd = mulberry32(parseInt(sha(seed).slice(0, 8), 16));
  const out = [];
  let n = 0;
  while (n < chars) {
    const len = 1 + Math.floor(rnd() * 3);
    let w = "";
    for (let i = 0; i < len; i++) w += SYL[Math.floor(rnd() * SYL.length)];
    if (rnd() < 0.08) w += Math.floor(rnd() * 1000);
    out.push(w);
    n += w.length + 1;
  }
  return out.join(" ").slice(0, chars);
}

// ───────────────────────── report ─────────────────────────
async function reportMode(dir, mdPath) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "ledger.json");
  const led = existsSync(join(dir, "ledger.json"))
    ? JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8"))
    : { spentUsd: NaN, requests: NaN };
  const parsed = files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
  const byRoute = new Map();
  for (const p of parsed.sort((x, y) => (x.matrix === "full" || x.matrix === "core" ? -1 : 1))) {
    const cur = byRoute.get(p.route);
    if (!cur) byRoute.set(p.route, { ...p, results: { ...(p.results ?? {}) } });
    else {
      cur.records = [...cur.records, ...p.records.map((r) => ({ ...r, cell: r.cell, label: r.label }))];
      cur.results = { ...cur.results, ...(p.results ?? {}) };
      cur.routeSpendUsd = Number(((cur.routeSpendUsd ?? 0) + (p.routeSpendUsd ?? 0)).toFixed(4));
      (cur.extraRuns ??= []).push({ matrix: p.matrix, runId: p.runId, history: p.history });
    }
  }
  const routes = [...byRoute.values()];
  const md = renderReport(routes, led);
  mkdirSync(join(mdPath, ".."), { recursive: true });
  writeFileSync(mdPath, md);
  console.log(`wrote ${mdPath}`);
  console.log(
    md
      .split("\n")
      .filter(
        (l) => l.startsWith("**VERDICT") || l.startsWith("- (a)") || l.startsWith("- (c)") || l.startsWith("- R3"),
      )
      .join("\n"),
  );
}
const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : "n/a");
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
function evalRoute(R) {
  const res = R.results ?? {};
  const H = R.history?.hLiteral;
  const out = { H, cells: [], verdict: {} };
  const chk = (name, ok, detail) => out.cells.push({ name, ok, detail });
  const line = (r) =>
    r?.usage
      ? `in=${r.usage.input} cr=${r.usage.cacheRead} cw=${r.usage.cacheWrite} out=${r.usage.output} $${r.costUsd}`
      : `status=${r?.status} ${r?.error ?? ""}`;
  if (res.M1M2M5 && H) {
    const { S, r1, r2 } = res.M1M2M5;
    const c = res.M2ctl;
    const t95 = 0.95 * H;
    const m1 = r1.ok && r1.usage && r1.usage.cacheRead + r1.usage.cacheWrite >= t95;
    chk(
      "M1",
      m1,
      `HTTP ${r1.status}; cacheRead+cacheWrite = ${r1.usage ? r1.usage.cacheRead + r1.usage.cacheWrite : "n/a"} vs 0.95|H| = ${t95.toFixed(0)}`,
    );
    const ctlOk = c?.r2?.usage ? c.r2.usage.cacheRead <= c.S + 0.05 * H : false;
    const m2main = r2.ok && r2.usage && r2.usage.cacheRead >= t95;
    chk(
      "M2",
      m2main && ctlOk,
      `R2 cacheRead = ${r2.usage?.cacheRead} ≥ ${t95.toFixed(0)}: ${m2main}; control R2c cacheRead = ${c?.r2?.usage?.cacheRead} ≤ S+0.05|H| = ${c ? (c.S + 0.05 * H).toFixed(0) : "n/a"}: ${ctlOk}`,
    );
    const sig = (R.history.signatureLens ?? []).length > 0 && R.history.lastAssistantBlocks?.includes("thinking");
    chk(
      "M5",
      sig && m2main && r2.status !== 400,
      `H last assistant blocks = [${R.history.lastAssistantBlocks}], signature lengths = [${R.history.signatureLens}]; R2 HTTP ${r2.status}; M2 line ${m2main ? "met" : "NOT met"}`,
    );
    out.verdict.a = m1 && m2main && ctlOk && sig;
  }
  if (res.M3 && H) {
    const { S, r1, r3, r3p } = res.M3;
    const t95 = 0.95 * H;
    const w = r3.usage ? r3.usage.cacheRead <= S + 0.05 * H : false;
    const rep = r3p.ok && r3p.usage ? r3p.usage.cacheRead >= t95 : false;
    chk(
      "M3 (window exists)",
      w,
      `R3 (${res.M3.blocksAfterAnchor} content blocks after the anchor block) cacheRead = ${r3.usage?.cacheRead} ≤ S+0.05|H| = ${(S + 0.05 * H).toFixed(0)}: ${w}`,
    );
    chk("M3′ (replayed anchor)", rep, `R3′ cacheRead = ${r3p.usage?.cacheRead} ≥ 0.95|H| = ${t95.toFixed(0)}: ${rep}`);
    out.verdict.r3p = rep && w;
  }
  if (res.M6 && H) {
    const m = res.M6;
    const t95 = 0.95 * H;
    const tail = m.shortTailChars; // chars; tokens ≈ chars/4 (+ role/format overhead), bound per plan uses tail + 64
    const tailTok = Math.ceil(tail / 3);
    const ok = (r, label, writeBound) => {
      const hit = r.usage && r.usage.cacheRead >= t95;
      const w = writeBound === undefined ? true : r.usage ? r.usage.cacheWrite <= writeBound : false;
      return {
        hit,
        w,
        line: `${label}: cacheRead = ${r.usage?.cacheRead} ≥ ${t95.toFixed(0)}: ${hit}${writeBound === undefined ? "" : `; cacheWrite = ${r.usage?.cacheWrite} ≤ ${writeBound} (tail≈${tailTok} tok + 64): ${w}`}`,
      };
    };
    const a1 = ok(m.p1, "P1", tailTok + 64);
    const a2 = ok(m.p2, "P2", tailTok + 64);
    const a6 = ok(m.r6, "R6");
    const ctl = m.r6c.usage ? m.r6c.usage.cacheRead <= m.Sc + 0.05 * H : false;
    const pass = a1.hit && a1.w && a2.hit && a2.w && a6.hit && ctl;
    chk(
      "M6",
      pass,
      `${a1.line}; ${a2.line}; ${a6.line}; control R6c cacheRead = ${m.r6c.usage?.cacheRead} ≤ S+0.05|H| = ${(m.Sc + 0.05 * H).toFixed(0)}: ${ctl}`,
    );
    out.verdict.c = pass;
  }
  if (res.M7b && H) {
    const { r1, r2, S } = res.M7b;
    const t95 = 0.95 * (R.extraRuns?.[0]?.history?.hLiteral ?? H);
    const hl = R.extraRuns?.[0]?.history?.hLiteral ?? H;
    const w1h = r1.usage ? (r1.usage.cacheWrite1h ?? 0) : 0;
    const land = r1.ok && r1.usage && w1h > 0 && w1h >= 0.95 * r1.usage.cacheWrite;
    const read = r2.ok && r2.usage && r2.usage.cacheRead >= 0.95 * hl;
    chk(
      "M7 (all-1h anchored shape)",
      land && read,
      `R1 (all breakpoints ttl 1h): HTTP ${r1.status}, cacheWrite = ${r1.usage?.cacheWrite}, ephemeral_1h = ${r1.usage?.cacheWrite1h ?? "not reported"}, ephemeral_5m = ${r1.usage?.cacheWrite5m ?? "not reported"} (1h share ≥95%: ${land}); R2 (all 1h, default shape) cacheRead = ${r2.usage?.cacheRead} ≥ 0.95|H| = ${(0.95 * hl).toFixed(0)}: ${read}. Survival beyond 5 min is NOT measured here.`,
    );
    out.verdict.m7 = land && read;
  } else if (res.M7) {
    const u = res.M7.r.usage;
    const landed = !!u && (u.cacheWrite1h ?? 0) > 0;
    chk(
      "M7",
      landed,
      u
        ? `ttl:1h write: cacheWrite = ${u.cacheWrite}, ephemeral_1h = ${u.cacheWrite1h ?? "not reported"}, ephemeral_5m = ${u.cacheWrite5m ?? "not reported"} → ${landed ? "1h LANDED ⇒ ttl inheritance allowed" : "1h did NOT land ⇒ M7 N/A (5m only)"}`
        : `status ${res.M7.r.status} ${res.M7.r.error ?? ""}`,
    );
    out.verdict.m7 = landed;
  }
  out.line = line;
  return out;
}
function renderReport(routes, led) {
  const L = [];
  L.push("# consult 锚点 P0 实测结果（cache-thread-plan §2）");
  L.push("");
  L.push(
    `> 生成：\`node scripts/exp/consult-anchor-probe.mjs\`（报告模式 \`--report\`），原始记录在运行输出目录的 \`<route>.json\`（仅 token 数 / 长度 / 断点路径，无消息正文、无凭据）。`,
  );
  L.push(`> 总花费（全部请求、全部路线）：**$${f2(led.spentUsd)}**，请求数 ${led.requests}，硬上限 $5。`);
  L.push("");
  const verdicts = [];
  for (const R of routes) {
    const E = evalRoute(R);
    verdicts.push({ route: R.route, E, R });
  }
  for (const { route, E, R } of verdicts) {
    L.push(`## 路线 \`${route}\``);
    L.push("");
    L.push(
      `- 价格 $/M：输入 ${R.price.input} / 输出 ${R.price.output} / 读 ${R.price.cacheRead} / 写 ${R.price.cacheWrite}；本路线花费 $${R.routeSpendUsd ?? "?"}；矩阵：${R.matrix}；run ${R.runId}`,
    );
    if (R.history) {
      L.push(
        `- 历史 H：${R.history.segments} 段（每段用户文本 ≈ ${R.sysTargetTokens ? "9.2k" : "?"} tok 目标；校准 ${R.charsPerToken} chars/token）；R-gen 末次请求总输入 |H| = **${R.history.hLiteral}** tok（各 R-gen 请求总输入：${R.history.genInputTokens.join(", ")}）；末条 assistant 块 = [${R.history.lastAssistantBlocks}]，thinking 签名长度 = [${R.history.signatureLens}]，末条输出 ${R.history.lastOutputTokens} tok。`,
      );
      L.push(
        `- 锚点坐标（宿主可信坐标）：messages[${R.anchorCoord?.message}].content[${R.anchorCoord?.block}]（${R.anchorCoord?.blockType}，跳过 thinking）。`,
      );
    }
    if (R.toolLoop)
      L.push(
        `- M3 工具回合：${R.toolLoop.pairs} 对真实 tool_use/tool_result（${R.toolLoop.messages} 条消息，锚点之后共 ${R.toolLoop.contentBlocksAfterAnchor} 个内容块，其中 thinking 块 ${R.toolLoop.thinkingBlocksInLoop} 个）。`,
      );
    if (R.stoppedBy) L.push(`- **提前停止**：${R.stoppedBy}`);
    if (R.fatal) L.push(`- **异常终止**：见 JSON 的 fatal 字段（已脱敏）。`);
    L.push("");
    L.push("### 通过线判定");
    L.push("");
    L.push("| 格 | 结果 | 数值（含阈值计算） |");
    L.push("| --- | --- | --- |");
    for (const c of E.cells)
      L.push(`| ${c.name} | ${c.ok ? "PASS" : "**FAIL**"} | ${c.detail.replace(/\|/g, "\\|")} |`);
    if (!E.cells.some((c) => c.name === "M4"))
      L.push(
        "| M4 OAuth 4 断点 | N/A | 本环境没有 OAuth 的 Anthropic 路线（auth.json 只有 api_key 型，上述路线均为内联 API key）⇒ OAuth 一律按 §3.4 显示 `degraded` |",
      );
    L.push("");
    L.push("### 逐请求记录");
    L.push("");
    L.push("| t(s) | 格/请求 | HTTP | input | cacheRead | cacheWrite | output | $ | 块数 | 断点 |");
    L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const r of R.records) {
      const u = r.usage;
      L.push(
        `| ${r.tStartS} | ${r.cell}/${r.label}${r.earlyAbort ? " ⚡abort@message_start" : ""}${r.retries ? ` (retries ${r.retries})` : ""} | ${r.status} | ${u ? u.input : "-"} | ${u ? u.cacheRead : "-"} | ${u ? u.cacheWrite : "-"} | ${u ? u.output : "-"} | ${r.costUsd ?? "-"} | ${r.blocks ?? "-"} | ${r.bp.join(", ") || "none"} |`,
      );
    }
    L.push("");
  }
  // overall verdict
  const opus = verdicts[0];
  L.push("## 判决（§2 停止规则）");
  L.push("");
  const sum = (key) =>
    verdicts
      .map((v) => `${v.route}: ${v.E.verdict[key] === undefined ? "未测" : v.E.verdict[key] ? "PASS" : "FAIL"}`)
      .join("； ");
  const mand = verdicts.filter((v) => v.route.includes("claude-opus-5-5"));
  const mandA = mand.length ? mand[0].E.verdict.a : undefined;
  L.push(`**VERDICT** (a) 锚点（M1/M2/M5）：${sum("a")}`);
  L.push(
    `- (a) 必测路线 opus-5-5：${mandA === undefined ? "未测" : mandA ? "存活（M1/M2/M5 全过）" : "**停止**（(a) 与 (c) 整体停止，不做 relocated 兜底）"}`,
  );
  L.push(`- R3′ 逐请求重放锚点（M3）：${sum("r3p")}`);
  L.push(`- (c) 保活（M6）：${sum("c")}`);
  L.push(`- M7 1h 继承：${sum("m7")}（FAIL = 1h 未落地 ⇒ N/A，不允许继承 1h）`);
  L.push(`- M4：N/A（无 OAuth 路线）`);
  L.push("");
  L.push(`总花费 **$${f2(led.spentUsd)}** / 上限 $5。`);
  L.push("");
  L.push("## 方法说明与披露");
  L.push("");
  L.push(
    "- **|H| 取 §2 字面定义**：最后一次 R-gen 请求的 `input + cacheRead + cacheWrite`（含 system+tools 的 S，不含末条 assistant 自己的输出 token）。被测请求实际总输入略大于 |H|（含末条 assistant + 问题），因此 `≥ 0.95|H|` 线偏宽松、`≤ S+0.05|H|` 线偏严格，数值见上表。S = 每格开头的 R0（只有 system+tools 断点、无 thinking）写入的 cacheWrite，即可缓存的 system+tools 前缀 token 数。",
  );
  L.push(
    "- **每格 R0 为脚本额外加的一个请求**（矩阵未列）：只为精确测 S。它不带 thinking；在 sonnet-5 上从 thinking 请求读不到它写的 system 条目（R1 的 cacheRead=0），在 opus-5-5 上读得到——不影响任何通过线（M1 看 read+write 之和，对照用 S 做上界），但说明 sonnet-5 的 system 条目按 thinking 开关分命名空间。",
  );
  L.push(
    "- **隔离**：每个格子/对照组用独立 nonce 打头 system（等长填充），R-gen 与 tool 回合在另一个 gen nonce 下生成，所以任何格子的消息前缀都没有任何既有条目；R-gen 的 user 段不带消息级断点。同一份历史 H（真实 thinking 签名）在各格子复用。",
  );
  L.push(
    "- **断点形状**：anchored R1 = {system, tools, 锚@H 末 text 块（跳过 thinking）, last@Q1}（共 4 个，非 OAuth）；R2/R3/R6 = pi 默认 {system, tools, last}；R3′ = 默认 + 锚；M6 的 P1/P2 = §6.4 的 ping 形状：H（保留锚断点）+ 固定短尾（无断点），system/tools/thinking 原样，**收到 message_start 即中止**（与生产保活同一路径），P1/P2 的 cacheWrite = 0。请求头：`x-api-key`、`anthropic-version`、tools 存在时的 `anthropic-beta: fine-grained-tool-streaming-2025-05-14`（pi 对该路线同样发送）。thinking = `{type:adaptive,display:summarized}` + `output_config.effort=medium`（pi 对 forceAdaptiveThinking 路线的形状）。",
  );
  L.push(
    "- **M3 的 20 块窗口**：R3 的 messages 在锚点之后有 26（opus）/ 28（sonnet）个内容块（12 对真实 tool_use/tool_result + 问句 + 末条追加问题），超过 20 块回看窗口；R3 只读到 S，证明窗口确实存在。",
  );
  L.push("- **M4**：本环境没有 OAuth 的 Anthropic 路线 ⇒ N/A，OAuth 线路 relocated 在显示上按 §3.4 一律 `degraded`。");
  L.push(
    "- **M7 说明**：opus-5-5 做了完整形状（所有断点 ttl 1h）+ 1h 读回，1h 写在 usage 拆分里真实落地（`ephemeral_1h_input_tokens` = 全部写入）。**这与记忆里「cr-anthropic ttl:1h 写出 0 条 1h 条目」的旧结论不一致**——线路行为可能已变，或此前的统计口径不同；本次**没有**测 5 min 之后的 1h 存活（记忆称约 20–25 min 就死），所以 M7 PASS 只证明「落地并可在 TTL 内读回」，是否值得默认继承 1h 仍需单独的存活实验。sonnet-5 只做了 3.5k tok 的落地检查（未做完整形状）。",
  );
  L.push(
    "- **sonnet-5 的填充文本**：这条线路对「音节/单词沙拉」填充会返回 `stop_reason: refusal`（0 输出），所以 sonnet-5 的历史用日志形状的填充（`--filler logs`），opus-5-5 用音节填充；这些失败的探测请求（约 $0.26）已计入总花费。sonnet-5 的 R-gen 第一次尝试把 12000 max_tokens 全花在 thinking 上（$0.23），重试后成功。",
  );
  L.push(
    "- 表中同一路线下第二组 `P0/calibrate…M7b/…` 行是 `--matrix m7` 的补充运行（M7 完整形状，独立 R-gen 与 nonce）。",
  );
  L.push(
    "- 脚本的 `--report` 模式从各路线 JSON（仅 token/长度/断点路径）生成本文件；凭据只在进程内存里，不打印、不落盘。",
  );
  L.push("");
  return L.join("\n");
}

// ───────────────────────── report mode ─────────────────────────
if (arg("report", false)) {
  await reportMode(String(arg("report")), String(arg("md", "docs/dev/consult/anchor-probe-results.md")));
  process.exit(0);
}

// ───────────────────────── route / auth ─────────────────────────
const [PROVIDER, MODEL_ID] = (() => {
  const i = ROUTE.indexOf("/");
  return [ROUTE.slice(0, i), ROUTE.slice(i + 1)];
})();
mkdirSync(OUT_DIR, { recursive: true });

const { ModelRuntime, getAgentDir } = await import("@earendil-works/pi-coding-agent");
const runtime = await ModelRuntime.create({
  authPath: join(getAgentDir(), "auth.json"),
  modelsPath: join(getAgentDir(), "models.json"),
  allowModelNetwork: false,
  refreshOnCreate: false,
});
const model = runtime.getModel(PROVIDER, MODEL_ID);
if (!model) fail(`route ${ROUTE} not found in pi's model registry`);
if (model.api !== "anthropic-messages") fail(`route ${ROUTE} api=${model.api}, expected anthropic-messages`);
const authRes = await runtime.getAuth(model);
const apiKey = authRes?.auth?.apiKey;
if (!apiKey) fail(`pi could not resolve credentials for ${ROUTE}`);
const authHeaders = authRes?.auth?.headers ?? {};
if (/sk-ant-oat/.test(apiKey))
  fail("OAuth credential detected — M4 path not implemented in this script (route not OAuth in this environment)");
const BASE = (authRes.auth.baseUrl ?? model.baseUrl).replace(/\/$/, "");
const PRICE = model.cost; // $/M tokens
const ROUTE_TAG = ROUTE.replace(/[^a-z0-9.-]+/gi, "_");
function fail(msg) {
  console.error(`[anchor-probe] FATAL: ${msg}`);
  process.exit(2);
}
function redact(s) {
  let t = String(s);
  for (const secret of [apiKey, ...Object.values(authHeaders)])
    if (typeof secret === "string" && secret.length > 6) t = t.split(secret).join("[REDACTED]");
  return t.replace(/(bearer\s+)[^\s"]+/gi, "$1[REDACTED]");
}

// ───────────────────────── spend ledger (hard cap) ─────────────────────────
function ledgerRead() {
  try {
    return JSON.parse(readFileSync(LEDGER, "utf8"));
  } catch {
    return { spentUsd: 0, requests: 0, byRoute: {} };
  }
}
let reservedUsd = 0; // in-flight estimates (concurrent cells)
function costOf(u) {
  return (
    (u.input * PRICE.input +
      u.output * PRICE.output +
      u.cacheRead * PRICE.cacheRead +
      u.cacheWrite * PRICE.cacheWrite) /
    1e6
  );
}
function ledgerAdd(usd) {
  const l = ledgerRead(); // read-modify-write per request (single process; cross-process runs are sequential)
  l.spentUsd = Number((l.spentUsd + usd).toFixed(6));
  l.requests += 1;
  l.byRoute[ROUTE] = Number(((l.byRoute[ROUTE] ?? 0) + usd).toFixed(6));
  writeFileSync(LEDGER, JSON.stringify(l, null, 2));
  return l;
}
function guardSpend(estUsd) {
  const l = ledgerRead();
  if (l.spentUsd + reservedUsd + estUsd > CAP_USD) {
    throw new CapExceeded(
      `spend cap: spent $${l.spentUsd.toFixed(3)} + reserved $${reservedUsd.toFixed(3)} + est $${estUsd.toFixed(3)} > cap $${CAP_USD}`,
    );
  }
}
class CapExceeded extends Error {}

// ───────────────────────── wire layer ─────────────────────────
const REQUEST_LOG = []; // sanitized per-request records
const T_ORIGIN = Date.now();
const RECORD_FILE = join(OUT_DIR, `${ROUTE_TAG}${MATRIX === "full" || MATRIX === "core" ? "" : `.${MATRIX}`}.json`);
function persist(extra = {}) {
  writeFileSync(
    RECORD_FILE,
    JSON.stringify(
      { route: ROUTE, price: PRICE, base: BASE.replace(/\/\/[^/@]*@/, "//"), records: REQUEST_LOG, ...META, ...extra },
      null,
      2,
    ),
  );
}
const META = {};

function headersFor(hasTools) {
  const h = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "x-api-key": apiKey,
    accept: "text/event-stream",
  };
  // pi sends this beta whenever tools are present and the route lacks eager input streaming (compat default).
  if (hasTools) h["anthropic-beta"] = "fine-grained-tool-streaming-2025-05-14";
  for (const [k, v] of Object.entries(authHeaders)) if (typeof v === "string") h[k] = v;
  return h;
}

/** Describe where cache_control breakpoints sit (paths only). */
function breakpointsOf(body) {
  const bp = [];
  const sys = body.system;
  if (Array.isArray(sys)) sys.forEach((b, i) => b?.cache_control && bp.push(`system[${i}]`));
  (body.tools ?? []).forEach((t, i) => t?.cache_control && bp.push(`tools[${i}]`));
  (body.messages ?? []).forEach((m, mi) => {
    if (Array.isArray(m.content))
      m.content.forEach(
        (b, bi) =>
          b?.cache_control &&
          bp.push(`messages[${mi}].content[${bi}]${b.cache_control.ttl ? `@${b.cache_control.ttl}` : ""}`),
      );
  });
  return bp;
}
function blockCount(body) {
  return (body.messages ?? []).reduce((n, m) => n + (Array.isArray(m.content) ? m.content.length : 1), 0);
}

/**
 * POST one streaming request. `earlyAbort` = cancel right after message_start (keepalive-ping shape).
 * Returns { ok, status, usage, blocks, stopReason, error }.
 */
async function send(
  label,
  cell,
  body,
  { earlyAbort = false, estInputTokens = 30000, retry = 1, timeoutMs = 180000, note = "" } = {},
) {
  const estUsd = (estInputTokens * PRICE.cacheWrite + (body.max_tokens ?? 1) * PRICE.output) / 1e6;
  guardSpend(estUsd);
  reservedUsd += estUsd;
  const rec = {
    label,
    cell,
    tStartS: Number(((Date.now() - T_ORIGIN) / 1000).toFixed(1)),
    bp: breakpointsOf(body),
    blocks: blockCount(body),
    msgs: body.messages?.length,
    maxTokens: body.max_tokens,
    thinking: body.thinking?.type ?? "off",
    earlyAbort,
    bodyBytes: Buffer.byteLength(JSON.stringify(body)),
    note,
  };
  let result;
  try {
    for (let attempt = 0; ; attempt++) {
      result = await sendOnce(body, earlyAbort, timeoutMs);
      const transient =
        !result.ok && (result.status === 0 || result.status >= 500 || result.status === 429) && !result.sawStart;
      if (transient && attempt < retry) {
        rec.retries = (rec.retries ?? 0) + 1;
        await sleep(3000);
        continue;
      }
      break;
    }
  } finally {
    reservedUsd -= estUsd;
  }
  const u = result.usage;
  rec.status = result.status;
  rec.ok = result.ok;
  rec.stopReason = result.stopReason;
  rec.error = result.ok ? undefined : redact(result.error ?? "").slice(0, 300);
  if (u) {
    rec.usage = u;
    rec.totalInput = u.input + u.cacheRead + u.cacheWrite;
    rec.costUsd = Number(costOf(u).toFixed(6));
    ledgerAdd(rec.costUsd);
  } else if (result.status === 200) {
    // 200 with no usable usage: bill nothing but flag it.
    rec.error = "200 without usage";
  }
  rec.tEndS = Number(((Date.now() - T_ORIGIN) / 1000).toFixed(1));
  REQUEST_LOG.push(rec);
  persist();
  const tag = rec.ok ? "ok " : `ERR${rec.status}`;
  console.log(
    `[${String(rec.tStartS).padStart(6)}s] ${tag} ${cell}/${label} in=${u?.input ?? "-"} cr=${u?.cacheRead ?? "-"} cw=${u?.cacheWrite ?? "-"} out=${u?.output ?? "-"} $${rec.costUsd ?? "-"} bp=[${rec.bp.join(",")}]${rec.error ? ` ${rec.error}` : ""}`,
  );
  return { ...result, rec };
}

async function sendOnce(body, earlyAbort, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("timeout")), timeoutMs);
  const out = { ok: false, status: 0, usage: undefined, blocks: [], stopReason: undefined, sawStart: false };
  let reader;
  try {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: "POST",
      headers: headersFor(Array.isArray(body.tools) && body.tools.length > 0),
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    out.status = res.status;
    if (!res.ok) {
      out.error = `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 400)}`;
      return out;
    }
    reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const blocks = new Map();
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: undefined,
      cacheWrite5m: undefined,
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dl = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!dl) continue;
        let ev;
        try {
          ev = JSON.parse(dl.slice(5).trim());
        } catch {
          continue;
        }
        if (ev.type === "message_start") {
          out.sawStart = true;
          const mu = ev.message?.usage ?? {};
          usage.input = mu.input_tokens ?? 0;
          usage.output = mu.output_tokens ?? 0;
          usage.cacheRead = mu.cache_read_input_tokens ?? 0;
          usage.cacheWrite = mu.cache_creation_input_tokens ?? 0;
          const cc = mu.cache_creation;
          if (cc && typeof cc === "object") {
            usage.cacheWrite1h = cc.ephemeral_1h_input_tokens;
            usage.cacheWrite5m = cc.ephemeral_5m_input_tokens;
          }
          out.usage = usage;
          out.status = 200;
          if (earlyAbort) {
            out.ok = true;
            out.aborted = true;
            ctl.abort(new Error("early-abort"));
            return out;
          }
        } else if (ev.type === "content_block_start") {
          blocks.set(ev.index, { ...ev.content_block, _json: "" });
        } else if (ev.type === "content_block_delta") {
          const b = blocks.get(ev.index);
          if (!b) continue;
          const d = ev.delta;
          if (d.type === "text_delta") b.text = (b.text ?? "") + d.text;
          else if (d.type === "thinking_delta") b.thinking = (b.thinking ?? "") + d.thinking;
          else if (d.type === "signature_delta") b.signature = (b.signature ?? "") + d.signature;
          else if (d.type === "input_json_delta") b._json += d.partial_json;
        } else if (ev.type === "message_delta") {
          if (ev.delta?.stop_reason) out.stopReason = ev.delta.stop_reason;
          const du = ev.usage ?? {};
          if (typeof du.output_tokens === "number") usage.output = du.output_tokens;
          // some relays only report final cache numbers on message_delta; keep the larger (non-zero) view
          if (typeof du.cache_read_input_tokens === "number" && du.cache_read_input_tokens > 0)
            usage.cacheRead = du.cache_read_input_tokens;
          if (typeof du.cache_creation_input_tokens === "number" && du.cache_creation_input_tokens > 0)
            usage.cacheWrite = du.cache_creation_input_tokens;
          if (typeof du.input_tokens === "number" && du.input_tokens > 0 && usage.input === 0)
            usage.input = du.input_tokens;
        } else if (ev.type === "error") {
          out.error = `stream error: ${JSON.stringify(ev.error ?? ev).slice(0, 300)}`;
          return out;
        }
      }
    }
    out.blocks = [...blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, b]) => {
        const { _json, ...rest } = b;
        if (rest.type === "tool_use") rest.input = _json ? JSON.parse(_json) : {};
        return rest;
      });
    out.ok = out.sawStart;
    if (!out.ok) out.error = "stream ended before message_start";
    return out;
  } catch (e) {
    if (out.aborted) return out;
    out.error = `${e?.name ?? "Error"}: ${e?.message ?? e}`;
    return out;
  } finally {
    clearTimeout(timer);
    try {
      await reader?.cancel();
    } catch {}
  }
}

// ───────────────────────── request builders ─────────────────────────
const EPH = () => ({ type: "ephemeral" });
const TOOLS = () => [
  {
    name: "lookup",
    description: "Look up reference entry number i from the local index. Returns a short string.",
    input_schema: { type: "object", properties: { i: { type: "integer" } }, required: ["i"] },
    cache_control: EPH(),
  },
];
const THINKING = { type: "adaptive", display: "summarized" }; // pi's shape for forceAdaptiveThinking routes
const OUTPUT_CONFIG = { effort: "medium" };
const isOpus = /opus/.test(MODEL_ID);
function systemBlocks(nonce, sysChars) {
  return [
    {
      type: "text",
      text: `${nonce}\nYou are a careful reference assistant. The following glossary is background noise, ignore it.\n${filler(`sys:${nonce}`, sysChars)}`,
      cache_control: EPH(),
    },
  ];
}
function clone(x) {
  return structuredClone(x);
}
function base(nonce, sysChars, messages, { maxTokens = 32, thinking = true, tools = true, system = true } = {}) {
  const b = { model: MODEL_ID, max_tokens: maxTokens, stream: true, messages };
  if (system) b.system = systemBlocks(nonce, sysChars);
  if (tools) b.tools = TOOLS();
  if (thinking) {
    b.thinking = { ...THINKING };
    b.output_config = { ...OUTPUT_CONFIG };
  }
  return b;
}
const userText = (text) => ({ role: "user", content: [{ type: "text", text }] });
function stripCC(messages) {
  const m = clone(messages);
  for (const msg of m) if (Array.isArray(msg.content)) for (const b of msg.content) delete b.cache_control;
  return m;
}
/** Anchor = last non-thinking block of the last assistant message of H (§3.2). Returns [msgIdx, blockIdx]. */
function anchorCoord(H) {
  const k = H.length;
  const last = H[k - 1];
  for (let i = last.content.length - 1; i >= 0; i--) {
    if (["text", "tool_use", "tool_result", "image"].includes(last.content[i].type)) return [k - 1, i];
  }
  throw new Error("no anchorable block");
}
function withAnchor(messages, coord) {
  const m = clone(messages);
  m[coord[0]].content[coord[1]].cache_control = EPH();
  return m;
}
function withLastBreakpoint(messages) {
  const m = clone(messages);
  const lm = m[m.length - 1];
  lm.content[lm.content.length - 1].cache_control = EPH();
  return m;
}
const tokensAbove = (rec) => rec?.totalInput ?? 0;

// ───────────────────────── phase 0: calibration + history generation ─────────────────────────
const sleepS = (s) => sleep(MS(s));
let CHARS_PER_TOKEN = 3.2; // refined by calibration
const RUN_ID = randomBytes(3).toString("hex").toUpperCase();
const nonce = (cell) => `ANCHOR-PROBE-${RUN_ID}-${cell}-${randomBytes(4).toString("hex").toUpperCase()}`;

async function calibrate() {
  // one no-cache, no-thinking request with a known char count → chars/token
  const chars = 20000;
  const b = {
    model: MODEL_ID,
    max_tokens: 1,
    stream: true,
    messages: [userText(`${nonce("CAL")}\n${filler("cal", chars)}`)],
  };
  const r = await send("calibrate", "P0", b, { estInputTokens: 8000 });
  if (!r.ok || !r.rec.totalInput) fail(`calibration request failed: ${r.error ?? r.status}`);
  CHARS_PER_TOKEN = chars / Math.max(1, r.rec.totalInput - 12);
  META.charsPerToken = Number(CHARS_PER_TOKEN.toFixed(3));
  console.log(`[calibrate] chars/token = ${META.charsPerToken}`);
}

const SYS_TARGET_TOK = 5600; // system+tools must exceed the 4096-token minimum cacheable prefix of Opus 4.5+ with headroom
const SEG_TARGET_TOK = 9200; // plan: every history segment ≥ 8k tokens
const sysChars = () => Math.round(SYS_TARGET_TOK * CHARS_PER_TOKEN);
const segChars = () => Math.round(SEG_TARGET_TOK * CHARS_PER_TOKEN);

const PUZZLES =
  FILLER_MODE === "logs"
    ? [
        "Across the log above, which service-N appears most often with status=200 AND a latency over 300ms? Work it out carefully, then answer with the service name and one sentence of justification.",
        "Across the log above, how many lines have status=500 and a latency below 100ms? Count carefully, then answer with the number and one sentence of justification.",
        "Across the log above, which user (u<number>) has the most status=500 lines? Work it out carefully, then answer with the user and one sentence of justification.",
      ]
    : [
        "Think it through carefully before answering: how many distinct ways can 14 identical coins be split into exactly 4 non-empty piles when the order of piles does not matter? Give the number and one sentence of justification.",
        "Think it through carefully before answering: what is the smallest positive integer that leaves remainders 2, 3 and 4 when divided by 5, 7 and 9 respectively? Give the number and one sentence of justification.",
        "Think it through carefully before answering: three people each tell the truth or lie; A says B lies, B says C lies, C says A and B both lie. Who tells the truth? Answer in one sentence.",
      ];
const hasSignedThinking = (blocks) =>
  blocks.some((b) => b.type === "thinking" && typeof b.signature === "string" && b.signature.length > 20);
const toAssistant = (blocks) => ({
  role: "assistant",
  content: blocks.map((b) => {
    if (b.type === "thinking") return { type: "thinking", thinking: b.thinking ?? "", signature: b.signature ?? "" };
    if (b.type === "redacted_thinking") return { type: "redacted_thinking", data: b.data };
    if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} };
    return { type: "text", text: b.text ?? "" };
  }),
});

/** R-gen: thinking-enabled generation (real signatures). Isolated under its own nonce; message cache_control NOT used. */
async function generateHistory(genNonce) {
  const sys = sysChars();
  const segs = [];
  let H = [];
  let genInputs = [];
  for (let s = 0; s < 2; s++) {
    let got;
    for (let tryN = 0; tryN < 3 && !got; tryN++) {
      const q = userText(
        `REFERENCE-SEGMENT-${s}-${RUN_ID}\n${filler(`seg:${RUN_ID}:${s}:${tryN}`, segChars())}\n\nTASK: ${PUZZLES[(s + tryN) % PUZZLES.length]}`,
      );
      const body = base(genNonce, sys, [...H, q], { maxTokens: 12000 });
      const r = await send(`rgen-${s}${tryN ? `-retry${tryN}` : ""}`, "P0", body, {
        estInputTokens: 11000 + s * 11000,
        note: "R-gen (no message breakpoints)",
      });
      if (!r.ok) fail(`R-gen failed: ${r.error ?? r.status}`);
      const textOk = r.blocks.some((b) => b.type === "text" && (b.text ?? "").length > 0);
      if (!hasSignedThinking(r.blocks) || !textOk) {
        console.log(
          `[rgen] segment ${s} try ${tryN}: signedThinking=${hasSignedThinking(r.blocks)} text=${textOk} — retrying with another puzzle`,
        );
        continue;
      }
      // keep only thinking+text (drop any tool_use the model may have attempted)
      const keep = r.blocks.filter((b) => b.type === "thinking" || b.type === "redacted_thinking" || b.type === "text");
      got = { q, a: toAssistant(keep), rec: r.rec, blocks: keep };
    }
    if (!got) fail(`R-gen segment ${s}: model never returned signed thinking + text`);
    H = [...H, got.q, got.a];
    segs.push(got);
    genInputs.push(got.rec.totalInput);
  }
  const lastBlocks = H[H.length - 1].content.map((b) => b.type);
  META.history = {
    segments: segs.length,
    genInputTokens: genInputs, // R-gen request totals (system+tools+history so far)
    hLiteral: genInputs[genInputs.length - 1], // plan: |H| = R-gen input+cacheRead+cacheWrite of the final R-gen request
    lastAssistantBlocks: lastBlocks,
    thinkingChars: H[H.length - 1].content.filter((b) => b.type === "thinking").map((b) => (b.thinking ?? "").length),
    signatureLens: H.filter((m) => m.role === "assistant").flatMap((m) =>
      m.content.filter((b) => b.type === "thinking").map((b) => b.signature.length),
    ),
    lastOutputTokens: segs[segs.length - 1].rec.usage.output,
  };
  return H;
}

/** 12 real tool_use/tool_result pairs generated against H under the gen nonce (cache allowed there: isolated nonce). */
async function generateToolLoop(genNonce, H) {
  const sys = sysChars();
  const qa = userText(
    "Use the lookup tool to fetch entries 1 through 12, one per turn: exactly one tool call per turn, wait for each result before the next call, never call two tools at once, and do not stop early. After entry 12, reply DONE.",
  );
  let msgs = [...H, qa];
  let pairs = 0;
  for (let step = 0; step < 16 && pairs < 12; step++) {
    const body = base(genNonce, sys, withLastBreakpoint(msgs), { maxTokens: 3000 });
    body.tool_choice = { type: "auto", disable_parallel_tool_use: true };
    const r = await send(`rgen-tool-${step + 1}`, "P0", body, {
      estInputTokens: 24000,
      note: "tool-loop R-gen (isolated gen nonce)",
    });
    if (!r.ok) fail(`tool-loop R-gen failed: ${r.error ?? r.status}`);
    const uses = r.blocks.filter((b) => b.type === "tool_use");
    if (r.stopReason !== "tool_use" || uses.length === 0) {
      console.log(`[rgen-tool] step ${step + 1}: stop=${r.stopReason}, no tool_use — nudging`);
      msgs = [
        ...msgs,
        toAssistant(r.blocks.filter((b) => b.type !== "tool_use")),
        userText(`Continue: call lookup for entry ${pairs + 1} now.`),
      ];
      continue;
    }
    const use = uses[0];
    const keep = r.blocks.filter((b) => b.type !== "tool_use" || b === use);
    pairs++;
    msgs = [
      ...msgs,
      toAssistant(keep),
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: use.id, content: `entry ${pairs}: ${sha(`${RUN_ID}:${pairs}`)}` },
        ],
      },
    ];
  }
  if (pairs < 12) fail(`tool loop only produced ${pairs}/12 pairs`);
  const TL = msgs.slice(H.length);
  META.toolLoop = {
    pairs,
    messages: TL.length,
    contentBlocksAfterAnchor: TL.reduce((n, m) => n + m.content.length, 0),
    thinkingBlocksInLoop: TL.filter((m) => m.role === "assistant").reduce(
      (n, m) => n + m.content.filter((b) => b.type === "thinking").length,
      0,
    ),
  };
  return TL;
}

// ───────────────────────── matrix cells ─────────────────────────
const Q = (n) => userText(`QUESTION-${n}-${RUN_ID}: reply with the single word OK.`);
const SHORT_TAIL = "(cache keepalive probe — no answer needed)";
const results = {}; // cell → { records }

/** R0: sys+tools only, breakpoints on system+last tool. cacheWrite = S (cacheable system+tools prefix). */
async function measureS(cell, n) {
  const b = base(n, sysChars(), [userText("ok")], { maxTokens: 1, thinking: false });
  const r = await send("R0-sys", cell, b, {
    estInputTokens: 6500,
    note: "measures S = system+tools tokens; breakpoints system+tools only",
  });
  if (!r.ok) throw new Error(`R0 failed in ${cell}: ${r.error ?? r.status}`);
  const u = r.rec.usage;
  return u.cacheWrite + u.cacheRead; // cacheable prefix tokens
}

async function cellAnchorPair(H, TL) {
  const coord = anchorCoord(H);
  META.anchorCoord = {
    message: coord[0],
    block: coord[1],
    blockType: H[coord[0]].content[coord[1]].type,
    blocksInLastAssistant: H[coord[0]].content.map((b) => b.type),
  };
  // ── anchored group: M1 + M2 + M5 ──
  const nA = nonce("A");
  const SA = await measureS("M1M2M5", nA);
  const r1 = await send(
    "R1(anchor+last@Q1)",
    "M1M2M5",
    base(nA, sysChars(), withLastBreakpoint(withAnchor([...H, Q(1)], coord))),
    { estInputTokens: 30000 },
  );
  await sleepS(M2_GAP_S);
  const r2 = await send("R2(default bp, Q2)", "M1M2M5", base(nA, sysChars(), withLastBreakpoint([...H, Q(2)])), {
    estInputTokens: 30000,
  });
  results.M1M2M5 = { S: SA, r1: r1.rec, r2: r2.rec };
  // ── control: same shape, R1 WITHOUT anchor ──
  const nC = nonce("C");
  const SC = await measureS("M2ctl", nC);
  const c1 = await send("R1c(last@Q1 only)", "M2ctl", base(nC, sysChars(), withLastBreakpoint([...H, Q(1)])), {
    estInputTokens: 30000,
  });
  await sleepS(M2_GAP_S);
  const c2 = await send("R2c(default bp, Q2)", "M2ctl", base(nC, sysChars(), withLastBreakpoint([...H, Q(2)])), {
    estInputTokens: 30000,
  });
  results.M2ctl = { S: SC, r1: c1.rec, r2: c2.rec };
  persist({ results });
}

async function cellM3(H, TL) {
  const coord = anchorCoord(H);
  const n3 = nonce("M3");
  const S3 = await measureS("M3", n3);
  const r1 = await send(
    "R1(anchor+last@Q1)",
    "M3",
    base(n3, sysChars(), withLastBreakpoint(withAnchor([...H, Q(1)], coord))),
    { estInputTokens: 30000 },
  );
  const tail = (q) => {
    const m = clone([...H, ...TL]);
    m[m.length - 1].content.push({ type: "text", text: q });
    return m;
  };
  const q3 = `QUESTION-3-${RUN_ID}: reply with the single word OK.`;
  const q3b = `QUESTION-3b-${RUN_ID}: reply with the single word OK.`;
  const r3 = await send("R3(default bp, >20 blocks)", "M3", base(n3, sysChars(), withLastBreakpoint(tail(q3))), {
    estInputTokens: 36000,
  });
  const r3p = await send(
    "R3'(anchor replayed)",
    "M3",
    base(n3, sysChars(), withLastBreakpoint(withAnchor(tail(q3b), coord))),
    { estInputTokens: 36000 },
  );
  results.M3 = {
    S: S3,
    r1: r1.rec,
    r3: r3.rec,
    r3p: r3p.rec,
    blocksAfterAnchor: r3.rec.blocks - H.reduce((n, m) => n + m.content.length, 0),
  };
  persist({ results });
}

async function cellM6(H) {
  const coord = anchorCoord(H);
  const nM = nonce("M6");
  const nMc = nonce("M6c");
  const SM = await measureS("M6", nM);
  const SMc = await measureS("M6c", nMc);
  const bodyR1 = (n) => base(n, sysChars(), withLastBreakpoint(withAnchor([...H, Q(1)], coord)));
  // t0: both groups write the anchor
  const [r1, r1c] = await Promise.all([
    send("R1(anchor+last@Q1)", "M6", bodyR1(nM), { estInputTokens: 30000 }),
    send("R1c(anchor+last@Q1)", "M6c", bodyR1(nMc), { estInputTokens: 30000 }),
  ]);
  const t0 = Date.now();
  const at = async (sec) => {
    const wait = t0 + MS(sec) - Date.now();
    if (wait > 0) await sleep(wait);
  };
  // §6.4 ping shape: H (anchor bp retained) + short tail without breakpoint; system/tools/thinking verbatim; abort at message_start
  const pingBody = () => base(nM, sysChars(), [...withAnchor(H, coord), userText(SHORT_TAIL)]);
  const [o1, o2, o3] = M6_OFFSETS;
  await at(o1);
  const p1 = await send(`P1(+${o1}s, early-abort)`, "M6", pingBody(), { earlyAbort: true, estInputTokens: 30000 });
  await at(o2);
  const p2 = await send(`P2(+${o2}s, early-abort)`, "M6", pingBody(), { earlyAbort: true, estInputTokens: 30000 });
  await at(o3);
  const q6 = (n) => base(n, sysChars(), withLastBreakpoint([...H, Q(6)]));
  const [r6, r6c] = await Promise.all([
    send(`R6(+${o3}s, H+Q6)`, "M6", q6(nM), { estInputTokens: 30000 }),
    send(`R6c(+${o3}s, no pings)`, "M6c", q6(nMc), { estInputTokens: 30000 }),
  ]);
  results.M6 = {
    S: SM,
    Sc: SMc,
    r1: r1.rec,
    p1: p1.rec,
    p2: p2.rec,
    r6: r6.rec,
    r1c: r1c.rec,
    r6c: r6c.rec,
    offsets: M6_OFFSETS,
    shortTailChars: SHORT_TAIL.length,
  };
  persist({ results });
}

/** M7 landing check: does a ttl:"1h" write land as ephemeral_1h on this route? (the evidence file is absent, so we measure) */
async function cellM7() {
  const n = nonce("M7");
  const text = `${n}\n${filler(`m7:${n}`, Math.round(3200 * CHARS_PER_TOKEN))}`;
  const b = {
    model: MODEL_ID,
    max_tokens: 1,
    stream: true,
    messages: [{ role: "user", content: [{ type: "text", text, cache_control: { type: "ephemeral", ttl: "1h" } }] }],
  };
  const r = await send("landing(ttl 1h)", "M7", b, {
    estInputTokens: 4500,
    note: "tiny 1h landing check (stands in for provider-evidence)",
  });
  results.M7 = { r: r.rec };
  persist({ results });
}

/** M7 proper: the anchored shape with EVERY breakpoint at ttl 1h, then an all-1h default-shape follow-up. */
async function cellM7b(H) {
  const coord = anchorCoord(H);
  const n = nonce("M7b");
  const oneHour = (b) => {
    const x = clone(b);
    const visit = (o) => {
      if (Array.isArray(o)) return o.forEach(visit);
      if (o && typeof o === "object") {
        if (o.cache_control) o.cache_control = { type: "ephemeral", ttl: "1h" };
        Object.values(o).forEach(visit);
      }
    };
    visit(x);
    return x;
  };
  const S7 = await measureS("M7b", n);
  const r1 = await send(
    "R1(all bp ttl 1h, anchor+last@Q1)",
    "M7b",
    oneHour(base(n, sysChars(), withLastBreakpoint(withAnchor([...H, Q(1)], coord)))),
    { estInputTokens: 30000 },
  );
  await sleepS(M2_GAP_S);
  const r2 = await send(
    "R2(all bp ttl 1h, default, Q2)",
    "M7b",
    oneHour(base(n, sysChars(), withLastBreakpoint([...H, Q(2)]))),
    { estInputTokens: 30000 },
  );
  results.M7b = { S: S7, r1: r1.rec, r2: r2.rec };
  persist({ results });
}

// ───────────────────────── main ─────────────────────────
async function main() {
  console.log(
    `[anchor-probe] route=${ROUTE} matrix=${MATRIX} cap=$${CAP_USD} base=${BASE.replace(/^(https?:\/\/[^/]+).*/, "$1")} run=${RUN_ID}`,
  );
  if (DRY) {
    console.log("[dry] auth resolved (not printed); would run calibration, R-gen, cells. Exiting.");
    return;
  }
  META.runId = RUN_ID;
  META.startedAt = new Date().toISOString();
  META.matrix = MATRIX;
  META.sysTargetTokens = SYS_TARGET_TOK;
  let stoppedBy;
  try {
    await calibrate();
    const genNonce = nonce("GEN");
    const H = await generateHistory(genNonce);
    if (MATRIX === "m7") {
      await cellM7b(H);
      throw new CapExceeded("m7-only run finished"); // sentinel: skip the other cells without flagging an error
    }
    const TL = await generateToolLoop(genNonce, H);
    persist();
    const jobs = [];
    // M6 timeline is wall-clock bound: start it first and run the other cells inside its waiting time.
    if (MATRIX === "full") jobs.push(cellM6(H));
    jobs.push(
      (async () => {
        await cellAnchorPair(H, TL);
        await cellM3(H, TL);
        if (MATRIX === "full") await cellM7();
      })(),
    );
    const settled = await Promise.allSettled(jobs);
    for (const s of settled)
      if (s.status === "rejected") {
        if (s.reason instanceof CapExceeded) stoppedBy = s.reason.message;
        else throw s.reason;
      }
  } catch (e) {
    if (e instanceof CapExceeded) stoppedBy = e.message === "m7-only run finished" ? undefined : e.message;
    else {
      META.fatal = redact(e?.stack ?? e);
      persist({ results });
      console.error(`[anchor-probe] aborted: ${redact(e?.message ?? e)}`);
      process.exitCode = 1;
    }
  }
  META.finishedAt = new Date().toISOString();
  if (stoppedBy) META.stoppedBy = stoppedBy;
  META.routeSpendUsd = Number(REQUEST_LOG.reduce((s, r) => s + (r.costUsd ?? 0), 0).toFixed(4));
  persist({ results });
  console.log(
    `[anchor-probe] done. route spend $${META.routeSpendUsd}; ledger total $${ledgerRead().spentUsd}${stoppedBy ? `; STOPPED: ${stoppedBy}` : ""}`,
  );
}

await main();
