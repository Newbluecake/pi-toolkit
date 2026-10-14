/**
 * 外部 agent 定价（external-agent plan §3.1/§3.3 L7）。pi-free 纯函数。
 * resolveExternalPricing：外部 agent 模型 id → 底层模型 → pi 注册表价格；priceUsage：按 tier 计价。
 */
import type { ExternalPriceRates, ExternalPriceTable, ExternalPricing } from "../core/types.js";
import type { PriceCandidate, PriceUsage, ResolveExternalPricing } from "./types.js";

const CANONICAL: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["anthropic"],
  openai: ["openai"],
  google: ["google", "google-vertex"],
  xai: ["xai"],
};

const FAMILY: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["claude-", ["anthropic"]],
  ["gpt-", ["openai"]],
  ["gemini-", ["google"]],
  ["grok-", ["xai"]],
  ["kimi-", ["moonshotai"]],
  ["glm-", ["zai"]],
  ["deepseek-", ["deepseek"]],
  ["minimax-", ["minimax"]],
  ["mistral-", ["mistral"]],
];

const norm = (s: string): string => s.toLowerCase().replaceAll(".", "-");
const base = (s: string): string => norm(s).replace(/-\d{8}$/, "");

const RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function isNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function nonZero(t: ExternalPriceTable | undefined): t is ExternalPriceTable {
  if (t === undefined || t === null || typeof t !== "object") return false;
  return RATE_KEYS.some((k) => isNum(t[k]) && t[k] > 0);
}

function ratesEqual(a: ExternalPriceRates, b: ExternalPriceRates): boolean {
  return RATE_KEYS.every((k) => a[k] === b[k]);
}

function tablesEqual(a: ExternalPriceTable, b: ExternalPriceTable): boolean {
  if (!ratesEqual(a, b)) return false;
  const ta = a.tiers ?? [];
  const tb = b.tiers ?? [];
  if (ta.length !== tb.length) return false;
  const sa = [...ta].sort((x, y) => x.inputTokensAbove - y.inputTokensAbove);
  const sb = [...tb].sort((x, y) => x.inputTokensAbove - y.inputTokensAbove);
  return sa.every((t, i) => {
    const o = sb[i];
    return o !== undefined && t.inputTokensAbove === o.inputTokensAbove && ratesEqual(t, o);
  });
}

const full = (c: PriceCandidate): string => `${c.provider}/${c.id}`;

function priced(c: PriceCandidate, basis: "upstream" | "family" | "consensus", approx: boolean): ExternalPricing {
  return { status: "priced", source: full(c), basis, approx, table: c.cost as ExternalPriceTable };
}

/** 同 provider 内多个命中：优先 norm 精确；价格不一致 ⇒ undefined（ambiguous）。 */
function pickWithin(hits: readonly PriceCandidate[], modelNorm: string): PriceCandidate | undefined | "ambiguous" {
  if (hits.length === 0) return undefined;
  const exact = hits.filter((h) => norm(h.id) === modelNorm);
  const pool = exact.length > 0 ? exact : hits;
  const first = pool[0] as PriceCandidate;
  for (const h of pool) {
    if (!tablesEqual(first.cost as ExternalPriceTable, h.cost as ExternalPriceTable)) return "ambiguous";
  }
  return [...pool].sort((a, b) => full(a).localeCompare(full(b)))[0];
}

export const resolveExternalPricing: ResolveExternalPricing = (input) => {
  const { modelId, info, registry, override } = input;

  // 0. override
  if (override !== undefined) {
    if (override === "unpriced") return { status: "unpriced", reason: "override_unpriced" };
    if (typeof override === "object") {
      return {
        status: "priced",
        source: "settings",
        basis: "override",
        approx: false,
        table: {
          input: override.input,
          output: override.output,
          cacheRead: override.cacheRead,
          cacheWrite: override.cacheWrite,
        },
      };
    }
    const slash = override.indexOf("/");
    const hit =
      slash > 0
        ? (registry ?? []).find((c) => c.provider === override.slice(0, slash) && c.id === override.slice(slash + 1))
        : undefined;
    if (hit !== undefined && nonZero(hit.cost)) {
      return { status: "priced", source: override, basis: "override", approx: false, table: hit.cost };
    }
    return { status: "unpriced", reason: "invalid_override", detail: override };
  }

  // 1. router
  if (info?.kind === "router" || modelId === "auto") return { status: "unpriced", reason: "router_model" };

  // 2. registry
  if (registry === undefined || registry.length === 0) return { status: "unpriced", reason: "registry_unavailable" };

  // 3. id 等价
  const mn = norm(modelId);
  const mb = base(modelId);
  const matches = registry.filter((c) => norm(c.id) === mn || base(c.id) === mb);
  if (matches.length === 0) return { status: "unpriced", reason: "no_match" };

  // 4. 零价
  const usable = matches.filter((c) => nonZero(c.cost));
  if (usable.length === 0) return { status: "unpriced", reason: "zero_price" };

  // 5. 规范 provider 优先
  const up = info?.upstreamProvider;
  const canonicalList = up !== undefined ? CANONICAL[up] : undefined;
  let providers: readonly string[] | undefined;
  let basis: "upstream" | "family" = "upstream";
  if (canonicalList !== undefined) {
    providers = canonicalList;
  } else {
    const lower = modelId.toLowerCase();
    const fam = FAMILY.find(([prefix]) => lower.startsWith(prefix));
    if (fam !== undefined) {
      providers = fam[1];
      basis = "family";
    }
  }
  if (providers !== undefined) {
    for (const p of providers) {
      const r = pickWithin(
        usable.filter((c) => c.provider === p),
        mn,
      );
      if (r === "ambiguous") {
        return {
          status: "unpriced",
          reason: "ambiguous",
          detail: `${p}: conflicting prices for ${modelId}`,
        };
      }
      if (r !== undefined) return priced(r, basis, basis === "family");
    }
  }

  // 6. 共识兜底
  const firstTable = usable[0]?.cost as ExternalPriceTable;
  if (usable.every((c) => tablesEqual(firstTable, c.cost as ExternalPriceTable))) {
    const chosen = [...usable].sort((a, b) => full(a).localeCompare(full(b)))[0] as PriceCandidate;
    return priced(chosen, "consensus", true);
  }
  const detail = usable
    .slice(0, 5)
    .map((c) => `${full(c)} ${c.cost?.input}/${c.cost?.output}`)
    .join(", ");
  return { status: "unpriced", reason: "ambiguous", detail };
};

const clampN = (n: unknown): number => (isNum(n) && n > 0 ? n : 0);

export const priceUsage: PriceUsage = (tokens, table, requestInputTokens) => {
  const input = clampN(tokens.input);
  const output = clampN(tokens.output);
  const cacheRead = clampN(tokens.cacheRead);
  const cacheWrite = clampN(tokens.cacheWrite);
  const reqInput = isNum(requestInputTokens) ? requestInputTokens : input + cacheRead + cacheWrite;
  let rates: ExternalPriceRates = table;
  let above = -1;
  for (const t of table.tiers ?? []) {
    if (isNum(t.inputTokensAbove) && reqInput > t.inputTokensAbove && t.inputTokensAbove > above) {
      rates = t;
      above = t.inputTokensAbove;
    }
  }
  const usd =
    (input * rates.input + output * rates.output + cacheRead * rates.cacheRead + cacheWrite * rates.cacheWrite) /
    1_000_000;
  return Number.isFinite(usd) && usd > 0 ? usd : 0;
};
