/**
 * 外部 agent 端口组装（external-agent plan §5.5，P5）：把 P2 框架实现 + P3 droid 适配器
 * 组装成 service/stack 消费的单一 `ExternalAgentsPort` 门面。enabled=false ⇒ 返回
 * undefined（stack.ts 因此完全不构造路由 driver / 不注入任何 dep —— 关闭态零接线）。
 *
 * 本文件是 P2/P3 实现的唯一消费者（pi-free 侧的胶水）：spawnChild/createRpc/openTranscript
 * 等冻结工厂全部来自 `./`（P2）与 `./droid/`（P3），provider 名冲突 / 二进制缺失 /
 * strict 目录漂移三类「整体不可用」在这里判定（§5.1 准入拒绝文案来源）。
 */
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Clock } from "../core/clock.js";
import type { ExternalContextBlock, ExternalPricing, ExternalRunSpec } from "../core/types.js";
import type { ExternalAgentsSettings } from "../config/settings.js";
import { createCatalogStore } from "./catalog-store.js";
import { createDroidProvider } from "./droid/provider.js";
import { unknownDroidModelMessage } from "./droid/catalog.js";
import { createJsonRpcClient } from "./jsonrpc.js";
import {
  capabilitiesText,
  msgBinaryNotFound,
  msgDroidModelNotAllowed,
  msgProviderNameCollision,
  msgProtocolDrift,
} from "./messages.js";
import { probeCwd } from "./paths.js";
import { resolveExternalPricing } from "./pricing.js";
import { spawnManagedChild } from "./process.js";
import { createRedactor } from "./redact.js";
import type {
  ExternalAdvertisedModel,
  ExternalAgentProvider,
  ExternalAgentsPort,
  ExternalFrameworkDeps,
  ExternalModelInfo,
  PlanRunInput,
} from "./types.js";
import { openTranscript, readTranscriptHeader } from "./transcript.js";
import { createUsageLedger } from "./usage-ledger.js";

/** 定价 memo TTL（§2.9 `pricingFor`：60s）。 */
const PRICING_MEMO_MS = 60_000;

/** 与 process.ts 的 binaryResolvable 同口径的有界同步探测（ENOENT ⇒ 整体不可用）。 */
function binaryResolvable(binary: string, cwd: string): boolean {
  const isExecutable = (p: string): boolean => {
    try {
      return statSync(p).isFile() && (statSync(p).mode & 0o111) !== 0;
    } catch {
      return false;
    }
  };
  if (binary.includes("/")) return isExecutable(resolve(cwd, binary));
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir !== "" && isExecutable(join(dir, binary))) return true;
  }
  return false;
}

export function createExternalAgentsPort(o: {
  settings: ExternalAgentsSettings;
  agentDir: string;
  clock: Clock;
  /** ctx.modelRegistry.getAll() 的 {provider,id,cost} 投影（try/catch，失败 ⇒ undefined）。 */
  registry: () => readonly import("./types.js").PriceCandidate[] | undefined;
  /** pi 注册表 provider 名集合（冲突检测；`droid-completion` 这类不冲突）。 */
  piProviders: () => readonly string[];
  /** memory 关闭或 injectMemory:false 时不传（P4a renderForExternal）。 */
  memoryBlock?: (cwd: string) => string | undefined;
  warnOnce(key: string, message: string): void;
}): { port: ExternalAgentsPort; providers: ReadonlyMap<string, ExternalAgentProvider> } | undefined {
  const settings = o.settings;
  if (!settings.droid.enabled) return undefined;

  const deps: ExternalFrameworkDeps = {
    spawnChild: spawnManagedChild,
    createRpc: createJsonRpcClient,
    openTranscript,
    readTranscriptHeader,
    createLedger: createUsageLedger,
    catalogStore: createCatalogStore(o.agentDir),
    clock: o.clock,
    agentDir: o.agentDir,
    redact: createRedactor(process.env),
    warnOnce: o.warnOnce,
  };
  const droid = createDroidProvider(deps, () => settings.droid);
  const providers: ReadonlyMap<string, ExternalAgentProvider> = new Map([["droid", droid]]);

  // 整体不可用原因（§5.1 ③）：构造期可判定的两项——provider 名冲突（fail closed）与
  // 二进制缺失（与 spawn 期 ENOENT 同文案，但这里零副作用、在准入就拒绝）。
  let fixedReason: string | undefined;
  try {
    if (o.piProviders().includes("droid")) {
      fixedReason = msgProviderNameCollision("droid");
      o.warnOnce("external-agent-provider-collision", fixedReason);
    }
  } catch {
    /* 注册表读取失败不阻断——冲突检测是防御性的 */
  }
  if (fixedReason === undefined && !binaryResolvable(settings.droid.binary, probeCwd(o.agentDir))) {
    fixedReason = msgBinaryNotFound(settings.droid.binary);
  }

  // 定价 memo（60s；目录/设置不变期间复用）。
  const pricingMemo = new Map<string, { at: number; value: ExternalPricing }>();
  const pricingFor = (ref: { provider: string; id: string }): ExternalPricing => {
    const key = `${ref.provider}/${ref.id}`;
    const now = o.clock.now();
    const hit = pricingMemo.get(key);
    if (hit !== undefined && now - hit.at < PRICING_MEMO_MS) return hit.value;
    const info: ExternalModelInfo | undefined = droid.catalog.snapshot()?.models.find((m) => m.id === ref.id);
    let registry: readonly import("./types.js").PriceCandidate[] | undefined;
    try {
      registry = o.registry();
    } catch {
      registry = undefined;
    }
    const value = resolveExternalPricing({
      modelId: ref.id,
      ...(info === undefined ? {} : { info }),
      registry,
      ...(settings.droid.pricing[ref.id] === undefined ? {} : { override: settings.droid.pricing[ref.id] }),
    });
    pricingMemo.set(key, { at: now, value });
    return value;
  };

  /** 目录展示列表（§5.3 / §15：tokenMultiplier 折进 note；advertiseMax 截断由调用方做）。 */
  const advertised = (): readonly ExternalAdvertisedModel[] => {
    const catalog = droid.catalog.snapshot();
    const byId = new Map((catalog?.models ?? []).map((m) => [m.id, m]));
    const one = (id: string): ExternalAdvertisedModel => {
      const info = byId.get(id);
      const multiplier =
        info?.tokenMultiplier !== undefined &&
        Number.isFinite(info.tokenMultiplier) &&
        info.tokenMultiplier > 0 &&
        info.tokenMultiplier !== 1
          ? `×${info.tokenMultiplier}`
          : undefined;
      return {
        provider: "droid",
        id,
        ...(info?.displayName === undefined ? {} : { name: info.displayName }),
        ...(multiplier === undefined ? {} : { note: multiplier }),
      };
    };
    if (settings.droid.models.length > 0) return settings.droid.models.map(one);
    return (catalog?.models ?? [])
      .filter((m) => !m.deprecated && m.kind !== "router" && !m.id.startsWith("custom:"))
      .map((m) => one(m.id));
  };

  const port: ExternalAgentsPort = {
    owns(provider) {
      return provider === "droid";
    },
    exists(ref) {
      if (ref.provider !== "droid") return false;
      const catalog = droid.catalog.snapshot();
      if (catalog === undefined) return undefined; // 目录不可用 ⇒ fail-open，交给 init+update 校验
      return catalog.models.some((m) => m.id === ref.id);
    },
    // 白名单判定（2026-10-16 拍板）不依赖目录：目录不可用时准入也只放行名单内 id。
    // resume 继承的模型由 spawn-service 豁免（不调本方法），老 run 不因名单收紧而无法续跑。
    modelAllowlistRejection(ref) {
      if (ref.provider !== "droid") return undefined;
      const allowed = settings.droid.models;
      if (allowed.length === 0 || allowed.includes(ref.id)) return undefined;
      return msgDroidModelNotAllowed(ref.id, allowed);
    },
    unavailableReason(provider) {
      if (provider !== "droid") return undefined;
      if (fixedReason !== undefined) return fixedReason;
      const drift = droid.catalog.snapshot()?.drift;
      if (drift !== undefined && settings.droid.protocolCheck === "strict")
        return msgProtocolDrift(drift.actual, drift.expected, droid.catalog.snapshot()?.agentVersion);
      return undefined;
    },
    unknownModelMessage(ref) {
      return unknownDroidModelMessage(ref.id, droid.catalog.snapshot(), settings.droid.models);
    },
    advertised,
    ownerOfSessionFile(path) {
      try {
        return droid.ownsSessionFile(path) ? "droid" : undefined;
      } catch {
        return undefined;
      }
    },
    planRun(input: PlanRunInput): ExternalRunSpec {
      const contextBlocks: ExternalContextBlock[] = [];
      const degraded: string[] = [];
      if (!input.resume) {
        if (settings.droid.injectMemory && o.memoryBlock !== undefined) {
          try {
            const text = o.memoryBlock(input.cwd);
            if (text !== undefined && text.trim().length > 0) contextBlocks.push({ kind: "memory", text });
          } catch {
            /* 记忆导出异常 ⇒ 静默跳过（P4a 契约） */
          }
        }
        contextBlocks.push({
          kind: "capabilities",
          text: capabilitiesText({ canSpawn: input.canSpawn, canMessage: input.canMessage }),
        });
      }
      if (input.schema !== undefined) degraded.push("schema_text");
      if (input.canMessage) degraded.push("message_agent");
      if (input.canSpawn) degraded.push("nested_agent");
      if (input.declaresTools) degraded.push("type_tools_ignored");
      return {
        provider: "droid",
        modelId: input.model.id,
        ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
        roleName: input.typeName,
        ...(input.rolePrompt === undefined ? {} : { rolePrompt: input.rolePrompt }),
        contextBlocks,
        ...(input.schema === undefined ? {} : { schema: input.schema }),
        persistTranscript: input.persist,
        runId: input.runId,
        pricing: pricingFor(input.model),
        degraded,
      };
    },
    pricingFor,
    dispose() {
      droid.dispose();
      pricingMemo.clear();
    },
  };
  return { port, providers };
}
