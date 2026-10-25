# PS2 报告：settings + AGENTS.md + 下沉 README 收口（#40）

基线：dev @ `8000a519`，未提交（零 git 写操作）。

## 改动

- **settings**：`src/config/settings.ts` 删 `ConsultSettings`、`DEFAULT_SETTINGS.consult`、`parseConsultSettings`、`loadSettings` 里的 consult 解析、`TIME_SETTING_MS_PATHS` 的 `consult.timeoutMs`；`src/config/setting-specs.ts` 删 7 个 `consult.*` spec，`budget.maxTotalFactor` 描述去掉 "consult,"。TUI settings-editor 的条目由 SETTING_SPECS 派生，随之消失（无单独条目）。`rg -n -i consult src/config` 为空（`settings.ts:284` 的英文动词 "never consulted" 顺手改为 "never read"）。
- **兼容读取**：`tests/config/consult-settings.test.ts` 改写（2 例）：默认值/spec/时间键里没有 consult；带完整 consult 块（及 `"invalid"`/7/null/[]/垃圾对象）的 settings 与不带时 `loadSettings` 结果 `toEqual`，不抛、`console.warn/error` 零调用，旁边的真实设置不受影响。
- **AGENTS.md**：删 peer bump 第 2 条的 `consult-preserve` 与末尾 `consult → docs/dev/consult/README.md`；`skills/` 行改为 "asking the parent via `message_agent`"；删 `src/consult/` 行；`src/workflow/` 行去 experts；`docs/dev/` 行改为 "consult (removed in #40; archive only)"。
- **删除** `docs/dev/consult/README.md`（`rm`，与 AGENTS.md 行同一改动，K8 绿）；`docs/dev/consult/REMOVED.md` 更新一句。`tests/docs/agents-md.test.ts` K2 名单去 `consult-preserve`，注释改中性。
- **scripts/dev/agents-split.mjs**：方案未规定。按「P1 历史切片脚本」处理——文件头加 HISTORICAL 注释，D17 行加说明，**不改逻辑**（`build/check` 对 pre-#40 srcRev 的复现不再成立，已写明）。
- **README 收口**（按方案处理表）：`subagent-core`（4 处 + 新增 legacy 段：旧 diag 字段/abArm 被忽略、displayAgentType 折叠、保留资产与兼容测试）、`context-switch`、`fabric-cross-session`（wakeExclusion 加 `consult_fork` legacy 说明；删两处 consult-preserve）、`scheduled-reports`（删 consult-preserve + `bg.consultMain` legacy 行）、`workflow`（7 个 key；删 `agent({experts})` 整段与 chain-taint 的 experts 描述，改为 isolation 是唯一 taint 触发；experts 专用拒绝说明；workflow-experts 链接加「已随 #40 移除」）、`data-encryption`（改为 `legacyConsultForkDir()` 的 legacy 说明，STATE_SUBDIRS 保留）、`external-agent`（2 处）、`sysload`。`web-hub:201`、`fabric-cross-session:205` 是英文动词，未改。
- **注释**：`src/core/verdict-schema.ts` 头部改为档案 + #40 已移除措辞，并去掉指向已删 `skills/dev-flow/references/consult-ab.md` 的引用。
- **plan.md §4.3**：PS1b 判据改为「空，除 PS2 域与旧数据/否定断言允许列表外」，新增「允许列表（PS2 定稿）」；`source-governance/analysis.md` 附录 D 末尾加指向本 plan 的一行。
- skills/：`rg -i consult skills` 无命中，无需处理。

## 闭合检查结果

- `rg -n "consult-preserve" AGENTS.md docs/dev/*/README.md skills`：空。
- `rg -n -i consult AGENTS.md docs/dev/*/README.md`：全部为 legacy/#40/removed 标记行（subagent-core:43、scheduled-reports:55、fabric-cross-session:44、data-encryption:10、AGENTS.md:138）或英文动词（web-hub:201、fabric-cross-session:205）。
- `rg -n -i consult src skills AGENTS.md docs/dev/*/README.md`：src 约 190 行，已按类别归入 plan §4.3 允许列表：① 英文动词 consulted/consults（大多数）；② 保留资产（`RESERVED_TOOL_NAMES`、`legacy-consult-forks.ts`、`cap-watcher.ts`、`LEGACY_CONSULT_MAIN_AGENT_TYPE`、`consult_fork` 字面量、`--consult` 报错）；③ append-only wire/UI 兼容（protocol/messages、run-transcript、schedule consultMain、`hub/run-transcript.ts` fallback）；④ `src/secure/**` consult-sessions/STATE_SUBDIRS（#43 冻结）；⑤ 历史出处注释（`consult plan §x`、`consult A/B instrumentation plan §x`、`non-consult`、「作者 consult 裁定」），不描述现行行为，本包未改。
- 残留风险（不阻塞）：⑤类注释和 `src/traffic`、`src/web-hub/protocol/{worktree-graph,feishu}.ts` 里的「consult 裁定」是过时措辞，建议后续顺手清理；本包按方案范围不碰。

## 自验

- `npm run typecheck`：通过（tsc ×2 + vue-tsc，exit 0）。
- `npx vitest run tests/config tests/docs tests/ui tests/commands tests/core tests/workflow/agent-opts.test.ts`：89 文件 2117 例全绿。
- `npx vitest run tests/integration/consult-legacy-entries.test.ts tests/tools tests/secure/{guard-points,stack-roots}.test.ts`：29 文件 435 例全绿。
- `npm run format:check`：通过。
- `git diff --stat -- tests/fixtures | wc -l`：0。
- 未跑：全量、conformance、build:web（留给 I4）。
