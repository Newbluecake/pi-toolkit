# AF0 契约包 · 交付报告（#72 alias-force-default r2）

范围：`alias-force-default-plan.md` §10 AF0 行 + §3 协议 + §5.2 `deriveAliasFromDirName` + §6 设置 + §9 中 AF0 的单测。
只做契约（类型、schema、纯函数、设置键）；hub 和 agent 行为未改，`tests/fixtures/` 未动，未做任何 git 写操作。

## 改动

| 文件                                                                   | 内容                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/web-hub/protocol/xs.ts`                                           | `XS_ALIAS_V2_HUB_CAP` / `XS_ALIAS_V2_AGENT_CAP`（`"xs.alias.v2"`）；`XS_ALIAS_INTENTS` + `XsAliasIntent`；`XsReqSchema` / `XsReqFrame` 追加可选 `intent`、`prevSessionId`；`XsAliasEvtSchema` / `XsAliasEvtFrame` 进 `XS_HUB_FRAME_SCHEMAS`；`XsAliasStateWire.origin?`、`lost.forced?`；预览 `take.online?` / `take.auto?`；`XsAliasTakeDetail` 追加 `unnotifiable`；错误码注释。`XS_AGENT_CAPS` 与既有 schema 字段不动 |
| `src/web-hub/protocol/messages.ts`                                     | 只追加：`HubFrame` 联合 `\| XsAliasEvtFrame`，以及类型 re-export                                                                                                                                                                                                                                                                                                                                                         |
| `src/web-hub/protocol/xs-alias.ts`                                     | 新导出 `isAliasCodePoint`（`normalizeAlias` 的字符筛查改为调用它，行为不变，语料全绿）、`deriveAliasFromDirName`、`XsAliasDeriveResult`                                                                                                                                                                                                                                                                                  |
| `src/fabric/xs/alias-auto.ts`（新）                                    | 纯函数 `deriveAutoAlias(cwd, {home,tmpdir})`（`/`、`$HOME`、tmpdir ⇒ `dir`；不可派生 ⇒ `invalid`）和 `shouldAutoClaim(facts)`（按 §5.1 的顺序返回首个不满足的 skip 原因）                                                                                                                                                                                                                                                |
| `src/fabric/xs/alias-suggest.ts`                                       | cwd 末段候选改为 `deriveAliasFromDirName(末段)`；不可派生则不出该项。其余候选不变                                                                                                                                                                                                                                                                                                                                        |
| `src/fabric/xs/types-alias.ts`                                         | 仅类型：`XsAliasRecord.origin?`、`XsAliasTombstone.forced?`（可选键，不新增 reason 枚举，S6）；TAKE 细节改用 `XsAliasTakeDetail`；`XsAliasPresence`、`XsAliasTakeMode`、`XsAliasAutoSkipReason`；`XsAliasStorePortV2` / `XsAliasBridgePortV2`（**独立的 extends 接口**，v1 接口与其实现者零改动，签名是给 AF1/AF3 的提案，可由它们调整或并入）                                                                           |
| `src/fabric/settings.ts`                                               | `FabricXsAliasSettings.autoFromCwd`（默认 true）、解析、默认值。**未写入 hub 配置**（`activate.ts` 仍只取 3 个 hub 字段）                                                                                                                                                                                                                                                                                                |
| `src/fabric/setting-specs.ts`                                          | 末尾追加 `fabric.crossSession.alias.autoFromCwd`（bool，非 live）                                                                                                                                                                                                                                                                                                                                                        |
| `tests/config/__corpus__/setting-specs-pin.json`                       | 有意更新：只多一行 `fabric.crossSession.alias.autoFromCwd` 和聚合 `all` 哈希（见下）                                                                                                                                                                                                                                                                                                                                     |
| `tests/config/__corpus__/settings-corpus.json` ⚠ 方案文件域之外        | 见「偏差」                                                                                                                                                                                                                                                                                                                                                                                                               |
| `tests/web-hub/protocol/xs-alias-derive.test.ts`（新）                 | 语料：合法、点号、空格、emoji、首字符非法、ASCII/CJK/扩展 B 在 16 簇 / 48 字节边界的截断、`id_like`、`reserved`（`pi-toolkit` 跳过不剥前缀）；`isAliasCodePoint` 与 `normalizeAlias` 在 BMP 全量 + 部分 astral 上一致                                                                                                                                                                                                    |
| `tests/web-hub/protocol/xs-alias-frames.test.ts`                       | v2 caps、intent/prevSessionId 的 decode 与非法值丢弃、**旧 v0.7.1 schema 整帧丢弃**、`xs_alias_evt` strict schema 与 hub 帧注册、agent 解码器忽略、`xs_res.alias` 新键                                                                                                                                                                                                                                                   |
| `tests/fabric/xs-alias-auto.test.ts`（新）                             | `deriveAutoAlias`；`shouldAutoClaim` 7 个事实的 128 种组合真值表 + 原因顺序                                                                                                                                                                                                                                                                                                                                              |
| `tests/fabric/xs-alias-suggest.test.ts`                                | chip ≡ derive、auto 与 chip 一致、跳过的目录不出候选                                                                                                                                                                                                                                                                                                                                                                     |
| `tests/config/settings-fabric-xs-alias.test.ts`、`…-fabric-xs.test.ts` | 默认值含 `autoFromCwd:true`；解析/回落；spec 为非 live bool、位于 fabric 分片末尾、是 `/agent settings` 上唯一的 crossSession 键；`writeSetting` 往返                                                                                                                                                                                                                                                                    |

## 偏差（需要你知道）

**`tests/config/__corpus__/settings-corpus.json` 被重新生成。** 方案只预见了 `setting-specs-pin`，但今天刚钉的 ⑧ 设置解析语料逐字节固定 `DEFAULT_SETTINGS`，任何新增默认键都会让它红（3 个用例）。我没有为过测试而放宽它，做法如下：

1. 用 `git archive HEAD` 的干净副本和当前改动各跑一遍 `GOV_CORPUS_DUMP`，共 1317 个用例；
2. 新输出去掉 `,"autoFromCwd":(true|false)` 后与旧输出**逐字节一致，0 例例外**（输入侧用的是语料里冻结的旧 template，所以两边输入相同）；
3. 再用语料自带的 `captured` 输入原样执行 `GOV_CORPUS_GENERATE` 重生，`captured` 输入列表不变，只有 `template`、`defaultsSha` 和各 sha 变化；再 prettier 格式化。

若你不同意改这个文件，可 `git checkout` 回去，但 `tests/config` 会有 3 个红用例；这是任何设置键落地都会遇到的代价，后续包（AF3/AF4）不需要再动它。

## 自验

| 命令                                                                                                                             | 结果                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                                                                                              | 通过（TS7 ×2 + vue-tsc）                                                                                                                                               |
| `npx vitest run tests/web-hub/protocol tests/fabric tests/config tests/web-hub/boundary.test.ts --maxWorkers=3`                  | 140 文件 / 3429 通过 / 3 skip（既有）                                                                                                                                  |
| `npx vitest run tests/integration/fabric-xs-off-golden.test.ts tests/conformance/fabric-xs.test.ts --maxWorkers=2`               | 2 文件 / 23 通过                                                                                                                                                       |
| `npx prettier --check src tests docs/dev/fabric-cross-session`                                                                   | 通过                                                                                                                                                                   |
| `git diff --quiet HEAD -- tests/fixtures/`                                                                                       | 干净                                                                                                                                                                   |
| 补充：`npx vitest run tests/web-hub --maxWorkers=4`                                                                              | 708 文件 / 15871 通过 / 3 skip                                                                                                                                         |
| 补充：`tests/{governance,commands,ui,mention,rpc,sysprompt}` + `integration/fabric-xs-alias-wiring` + `fabric-xs-channel-compat` | 42 文件 / 720 通过                                                                                                                                                     |
| 全量 `npx vitest run`（3 workers）                                                                                               | 未跑完：25 分钟 timeout 前尚未结束，其中 `tests/secure/launcher-private-unit` 单文件 258s（与本改动无关）。未见任何失败，但**不能当作全量绿**；CI 的全量结果以 CI 为准 |

## 契约要点备忘（给后续包）

- `intent` 是字面量联合：非法值会在 hub 解码时被**静默丢弃**（agent 侧永远只发 3 个合法值）；intent 与 alias/take/clear/prevSessionId 的**组合**合法性留给 router（`E_XS_BAD_FRAME`），schema 刻意放行。
- `deriveAliasFromDirName` 第 2 步用 `stripAt:false`：目录名 `@foo` 走清洗得到 `foo`。第 2 步 `normalizeAlias` 直接成功的名字**原样采用**（如 `foo__` 不修剪），只有失败后才进入清洗。`pi.toolkit` 清洗成 `pi-toolkit` 后命中保留前缀 ⇒ 跳过，这与方案 §9 一致。
- `shouldAutoClaim` 多一个内部 skip 值 `"handoff-pending"`，它不在 §7 的 status 令牌表里，AF3/AF4 决定是否渲染。
- `deriveAutoAlias` 的 `home`/`tmpdir` 由调用方注入（模块不读环境）；比较按路径段，忽略尾部/重复分隔符，不做 realpath。
- `autoFromCwd` 不进 `HubConfig`：hub 字节不变。off/v1 路径未触碰（off golden、C-X 通过）。

## 建议 commit message

```
feat(fabric): alias v2 contract — xs.alias.v2 caps, intent frames, cwd-basename derivation, autoFromCwd (#72 AF0)

Contract only; no hub or agent behaviour changes, v1 wire bytes unchanged.

- protocol: xs.alias.v2 hub/agent caps; optional xs_req intent/prevSessionId (auto|force|handoff);
  hub→agent xs_alias_evt frame (strict, HubFrame union append); alias state/preview wire keys
  (origin, lost.forced, take.online/auto); E_XS_ALIAS_TAKE{unnotifiable}
- xs-alias: isAliasCodePoint (shared by normalizeAlias) and deriveAliasFromDirName
  (sanitise → truncate on grapheme boundary; reserved/id-like skipped, prefix never stripped)
- fabric: alias-auto.ts (deriveAutoAlias, shouldAutoClaim); alias-suggest cwd chip now uses the
  same derivation; types-alias gains origin/forced and v2 port interfaces (types only)
- settings: fabric.crossSession.alias.autoFromCwd (default true, non-live, agent-side only,
  never sent to the hub) + /agent settings spec

Tests: setting-specs-pin.json gains exactly one entry (+ aggregate hash) for the new spec — intentional.
settings-corpus.json is regenerated because it pins DEFAULT_SETTINGS byte-for-byte; verified that
all 1317 pinned outputs differ from the previous ones only by `"autoFromCwd":<bool>`.
```
