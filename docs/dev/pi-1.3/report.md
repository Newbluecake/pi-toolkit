# pi 1.3.0 升级报告（chore/pi-1.3）

日期：2026-10-21。工作区：`/home/bluecake/ai/pi-toolkit-pi13`（branch `chore/pi-1.3`）。
peer 范围已放宽到 `>=1.0.0 <1.4.0`，devDeps `^1.3.0`，node_modules 实装 pi-coding-agent / pi-ai / pi-tui / pi-agent-core 1.3.0。
peer 下限保持 1.0.0 —— 所有改动同时兼容 pi 1.0–1.2（主检出仍是 1.2.0 验证基线）。

## 一、两个 conformance 失败的根因与修复

### 1. history-restore RH1–RH4：首个 resume POST `expected 503 to be 202`

**根因**：与 pi 行为无关，是我们自己的版本闸门。hub 的 managed-spawn 准入在 supervisor `init()`
里跑 `checkLauncherAsync`（`src/web-hub/hub/spawn/launcher-check.ts`），校验 launcher 所属
`@earendil-works/pi-coding-agent` 包的版本必须落在
`SUPPORTED_PI_RANGE`（`src/web-hub/protocol/spawn.ts:709`）内。该常量写死
`{ min: "1.0.0", maxExclusive: "1.3.0" }`，pi 1.3.0 恰好出界 ⇒ `policy.reason:"launcher"`
（detail `incompatible`）⇒ gate 3 拒绝 ⇒ `503 E_LAUNCHER`。每个测试的第一个
`POST /api/headless` 直接 503，根本走不到 fork。

**修复**（产品代码 + 版本钉扎测试同步更新）：

- `src/web-hub/protocol/spawn.ts`：`SUPPORTED_PI_RANGE.maxExclusive` `1.3.0` → `1.4.0`
  （该常量被 `tests/web-hub/protocol/spawn.test.ts` 钉扎为「必须等于 package.json peer 范围」，
  peer 已放宽到 `<1.4.0`，两者重新一致）。
- `src/adapters/pi-compat.ts`：`TESTED_PI_RANGE` → `"1.0.0 - 1.3.0"`；
  `isWithinTestedRange` 的 `minor <= 2` → `minor <= 3`（1.3 不再每 session_start 打
  「未验证版本」WARN；能力门仍是纯结构探测，I14 无版本分支）。
- 测试同步：`tests/web-hub/protocol/spawn.test.ts`、`tests/web-hub/hub/spawn/launcher-check.test.ts`
  （out-of-range 样例 1.3.0→1.4.0，in-range 增加 1.3.0）、`tests/web-hub/hub/spawn/supervisor.test.ts`
  （`badPkgFs("1.3.0")` → `"1.4.0"`）、`tests/adapters/pi-compat.test.ts`（warn 样例 1.3.0→1.4.0，
  no-warn 增加 1.3.x）。

**验证**：`tests/conformance/history-restore.test.ts` RH1–RH4 全过（~60s）。

### 2. measure-build「live round 3」managed-effort / both flags：`six safe writes built: expected false`

**根因**（pi-ai 1.3 行为变化，证据见下）：`/cache-ttl measure` 的受控发送走
`sendPipelinePing` → 真实 `ModelRegistry.streamSimple(model, ctx, { maxTokens:1, cacheRetention, … })`
—— 不传 `reasoning`。pi-ai 1.2 的 `buildParams`（`dist/api/anthropic-messages.js`）里
managed-effort 分支在最前：

```js
// pi-ai 1.2
if (model.compat?.supportsMidConvoEffort === true) {
  params.thinking = { type: "adaptive", display, block_binding: { prefix_mismatch_behavior: "drop_block" } };
  params.output_config = { effort: "high" };
} // → 另附一条空 content 的 system effort 消息（insertThinkingLevelMessages）
```

pi-ai 1.3 在同文件新增了 `thinkingDisabled` 分支并置于 managed 分支**之前**：

```js
// pi-ai 1.3
const thinkingDisabled = model.reasoning && options?.thinkingEnabled === false && model.thinkingLevelMap?.off !== null;
const effortMessages = model.compat?.supportsMidConvoEffort === true && !thinkingDisabled;
if (thinkingDisabled)
  params.thinking = { type: "disabled" }; // ← 新的最高优先级
else if (effortMessages) {
  /* 1.2 的 adaptive + output_config 构造 */
}
```

`streamSimple` 不传 `reasoning` ⇒ `thinkingEnabled:false`（1.2/1.3 相同），配合
`reasoning:true` 且无 `thinkingLevelMap`（`undefined !== null`）⇒ 1.3 下 managed 模型的
stock thinking-off 载荷变为 `thinking:{type:"disabled"}`、无 `output_config`、无尾部 effort
system 消息。实测（真实 ModelRuntime + stub，onPayload 截获）：1.3 构建
`thinking:{type:"disabled"}` + betas 仍在 + cache_control 正常。
我们的 `validateMeasurePayload`（`src/cache-ttl/measure-payload.ts`）对 `managedEffort`
只认 adaptive 形状 ⇒ `failed(payload:thinking)` ⇒ 流程停在六次安全写入之前。

这是 pi 对「thinking off 的会话」的合理修正（effort 标记在 thinking disabled 时无法改变，
且 Anthropic 拒绝 disabled thinking 配 `block_binding`），不是回归；且经 `streamSimple`
在 1.3 下**无法**用 cap 1 构造 adaptive 形状（传 `reasoning` 会走 budget 路径的
`adjustMaxTokensForThinking`，max_tokens 不再是 1，违背测量 cap 不变量）。所以正确修法是
让验证器接受 pi 1.3 的 stock 形状，而不是强行走旧形状。

**修复**：

- `src/cache-ttl/measure-payload.ts`：新增 `managedThinkingDisabled()` —— 恰好
  `thinking:{type:"disabled"}`（only `type` 键）且全载荷无 `output_config` 才算；
  `validThinking` 的 managed 分支接受该形状；`validateAnthropicPayload` 的消息数检查在该
  形状下要求 1 条（否则仍要求 2 条含尾部 effort 消息）。两种 stock 形状都接受，**混合形状
  （disabled thinking + 任何 effort 标记）仍拒绝**，拒绝词汇表不变。
- `src/cache-ttl/measure-command.ts`：更新过时注释（managed 构造在 1.3 下的新行为）。
- `tests/conformance/measure-build.test.ts`：managed 两例的精确期望按**实装 pi-ai 版本**
  分流（读 `node_modules/@earendil-works/pi-ai/package.json`；测试钉扎实装依赖的精确字节，
  产品代码无版本分支，I14 不涉）。其余 4 例（force-adaptive×2、plain×2）不受影响。
- `tests/cache-ttl/measure-payload.test.ts`：新增版本无关的单测，用合成载荷钉死
  「disabled 形状接受 + 混合形状逐一拒绝」。既有 `realBuild` 用例 fixture 模型
  `reasoning:false`，在 1.2/1.3 下都仍产 adaptive 形状，无需改动。

**验证**：`tests/conformance/measure-build.test.ts` 25/25、`tests/cache-ttl/measure-payload.test.ts` 41/41。

## 二、changelog 影响评审

| pi 1.3 变化                                                                | 涉及我们的代码                                                                                                                                                                                                      | 结论                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| kimi-coding 改 OpenAI Chat Completions（`https://api.kimi.com/coding/v1`） | `src/cache-ttl` keepalive 资格门 `api === "anthropic-messages"`（keepalive-state.ts）；`late-usage.ts` 种子 host `api.kimi.com`；`warmth.ts` `WARMTH_SUPPORTED_APIS=["anthropic-messages"]`；`provider-evidence.ts` | **行为变化但无需改代码**：stock kimi-coding 现在是 openai-completions ⇒ 自动不再 keepalive（与所有 OpenAI 协议 provider 一致）；warmth 判 `unknown` ⇒ topic-switch 闸门「不问」fail-open。late-usage 种子只剩「用户在 models.json 里仍声明 anthropic-messages 指 api.kimi.com」时生效，保留且注释已更新说明。实测 diff：`providers/kimi-coding.js` 仅 api/baseUrl 两行变化。 |
| 同上：models.json 覆盖须带 `/v1`                                           | 无（我们不管用户的 models.json）                                                                                                                                                                                    | 纯用户侧注意事项。                                                                                                                                                                                                                                                                                                                                                           |
| 同上：kimi 配额端点                                                        | `src/quota/adapters/kimi.ts` 用 `GET {baseUrl}/coding/v1/usages`（管理端点，非模型 API）                                                                                                                            | **不受影响**（changelog 未提 usages 端点变化；协议切换只涉及模型调用路径）。                                                                                                                                                                                                                                                                                                 |
| 模型切换丢弃异模型 thinking 块                                             | keepalive（按请求捕获真实载荷，原样重放）、consult C2 preserve（同模型 resume，无切换）                                                                                                                             | 无影响。切换导致的前缀变化本来就是真实 cache miss。                                                                                                                                                                                                                                                                                                                          |
| resume 恢复会话 active tools（`--tools +x/-x` 叠加；显式 tools 除外）      | `src/runtime/session-driver.ts`、`src/service/runtime-adapter.ts` 的 SessionSpec.tools、consult/tidy 只读域                                                                                                         | **兼容且有利**：readonly 域（consult fork、`toolDomain:"readonly"` tidy、C2 preserve）一律显式传 `tools` ⇒ 不触发恢复，只读保证不被恢复路径绕过（已核对 runtime-adapter.ts L1066 的强制 tools 赋值）。普通 child X2 resume 不显式传 tools ⇒ 恢复会话内激活的工具，正是我们想要的保真修复。agent-session.js 的 1.2→1.3 diff 仅这一个 hunk（30 行）。                          |
| 内部依赖钉死精确版本                                                       | 打包                                                                                                                                                                                                                | 无影响。                                                                                                                                                                                                                                                                                                                                                                     |
| gateway 错误重试增多                                                       | keepalive 把 5xx 当 retryable                                                                                                                                                                                       | 无影响（只减少瞬断）。                                                                                                                                                                                                                                                                                                                                                       |
| 畸形 tool-call JSON 直接校验失败                                           | 无                                                                                                                                                                                                                  | pi 侧行为，无影响。                                                                                                                                                                                                                                                                                                                                                          |
| `--model` 多 provider 消歧（model-resolver.js 重写）                       | 我们用自有 `parseStrictModelRef`/registry.find，child 显式 model 对象                                                                                                                                               | 无影响；rpc-spawn CM1–CM5 conformance 全过。                                                                                                                                                                                                                                                                                                                                 |
| `sessionShareDestination`、overlay done()、`/share`                        | settings-schema/settings-manager/interactive                                                                                                                                                                        | 我们不涉及。                                                                                                                                                                                                                                                                                                                                                                 |
| consult-preserve `PROVIDER_PREFIX_FIELDS`                                  | `src/consult/preserve-identity.ts` 冻结的 13 个顶层字段                                                                                                                                                             | 1.3 `buildParams` 顶层字段集合逐键核对**完全一致**（model/messages/max_tokens/stream/betas/system/temperature/tools/thinking/output_config/metadata/tool_choice/fallbacks）；C8 类「未知顶层字段即失败」未触发；consult-preserve conformance 全过。                                                                                                                          |
| sysprompt wake-replay / compat.ts                                          | `context_with_system`/forceSystemPrompt/getCurrentSystemMessage                                                                                                                                                     | agent-session.js diff 不含这些路径；wake-run-sysprompt conformance 全过。                                                                                                                                                                                                                                                                                                    |
| pi-tui / pi-agent-core                                                     | hud、ask-user 等                                                                                                                                                                                                    | 两包 dist **逐文件 byte-identical**，零风险。                                                                                                                                                                                                                                                                                                                                |

## 三、开放事项 / 需用户决策

1. **stock kimi-coding 失去 keepalive 覆盖**（pi 1.3 起）：kimi 的 Chat Completions 协议下
   prompt cache 是自动的、无 `cache_control` 语义，我们的 keepalive 机制（Anthropic 专有）
   本就不适用。如用户仍想要 kimi 线路的 TTL 保活，需要新机制（OpenAI 协议探测），属于新
   功能而非兼容修复 —— **建议不做**，等真实需求。
2. pi 1.3 的 `supportsMidConvoEffort` 现在也用于 openai-responses（GPT-6 thinking level 切换
   保缓存）。我们的 measure 验证器 openai-responses 分支不认这个新 compat 行为；
   `/cache-ttl measure` 若哪天支持 GPT-6 managed effort 需另行扩展 —— 现状无回归，暂不处理。

## 四、验证结果（本 worktree，pi 1.3.0）

| 命令                               | 结果                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                | ✅ 通过（tsc ×2 + vue-tsc）                                                                                                   |
| `npm run test:conformance`         | ✅ 22 文件全过，238 passed / 17 skipped（含 RH1–RH4、consult-preserve、fabric-wake、rpc-spawn、HC1–HC7、measure-build 25/25） |
| `npm test`（全量，265s）           | ✅ 1239 文件全过，**23806 passed / 26 skipped / 0 failed**                                                                    |
| `npx prettier --check`（改动文件） | ✅（两处经 --write 修正后通过）                                                                                               |

全量零失败，无需与主检出（1.2.0）对拍区分 flake。

## 五、改动文件清单（均为本 worktree，未 commit）

产品代码：

- `src/web-hub/protocol/spawn.ts` — SUPPORTED_PI_RANGE → `<1.4.0`
- `src/adapters/pi-compat.ts` — TESTED_PI_RANGE → 1.0.0-1.3.0；tested-range minor ≤ 3
- `src/cache-ttl/measure-payload.ts` — managedEffort 接受 pi 1.3 stock disabled 形状（+混合形状仍拒绝）
- `src/cache-ttl/measure-command.ts` — 注释更新
- `src/cache-ttl/late-usage.ts` — 注释更新（kimi 协议切换后种子 host 的适用范围）

测试：

- `tests/conformance/measure-build.test.ts` — managed 两例期望按实装 pi-ai 版本分流
- `tests/cache-ttl/measure-payload.test.ts` — 新增 disabled 形状接受/混合拒绝单测
- `tests/web-hub/protocol/spawn.test.ts`、`tests/web-hub/hub/spawn/launcher-check.test.ts`、
  `tests/web-hub/hub/spawn/supervisor.test.ts`、`tests/adapters/pi-compat.test.ts` — 版本钉扎样例同步
