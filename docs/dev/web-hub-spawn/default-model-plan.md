# web-hub 受管会话「新建会话默认模型」— 实施方案 v2

> 范围：web-hub 设置面板新增「新建会话默认模型」，只作用于 hub 自己 fork 的 `pi --mode rpc` 子进程
> （`/api/headless*`，supervisor 在 `src/web-hub/hub/spawn/`）。**绝不读写 `~/.pi/agent/settings.json`。**
> 依赖：`arch.md`（§4.5 admit、§7.7 store、§8.2 路由矩阵）、`plan.md`（SP9 幂等/门序）。v1 被评审打回，修订见 §9。
> pi 行号均指 devDependency `@earendil-works/pi-coding-agent@1.0.2` 的 `dist/`。

## 0. 调研结论（已核实）

| 事实                                                                                                                                                                                                                  | 证据                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| fork 不经 shell：`spawnFn(launcher[0], [launcher[1], "--mode", "rpc"], {cwd, detached, stdio, env})`                                                                                                                  | `hub/spawn/supervisor.ts:1278`                                                        |
| fork → identity → `exit`/`error` 监听 → stdout/stderr `data` 监听 全在 `start()` 同一同步段内（`supervisor.ts:1258-1334` 无 await）；Node 只在后续事件循环轮次派发 `data`/`exit`，**不会漏掉早期 stderr**             | 同上                                                                                  |
| 真正的竞态：`exit` 与最后一块 stderr `data` 的先后不保证；且 `onChildExit → finalizeTerminal` 立即 `cleanupHandles`（丢弃 `rec.sink`，之后的 stderr `data` 被 `rec.sink?.push` 丢掉）；无 `stderrDir` 时根本没有 sink | `supervisor.ts:990-1005,848-855,1322-1334`                                            |
| `exited_early` ∈ `BREAKER_REASONS`；熔断在 `finalizeTerminal` 内**一次性**结算（`!rec.breakerExempt`）；4 次/10min 开闸 10min，单探针半开                                                                             | `supervisor.ts:360-365,601-612,873`                                                   |
| pi `--model <s>`（hub 绝不传 `--provider`）：首个 `/` 前缀是已知 provider ⇒ 在该 provider 内做 exact→**子串**模糊匹配（`anthropic/opus` 会静默选中一个 opus）                                                         | `model-resolver.js:328-337,105-112,381-383`                                           |
| 前缀**不是**已知 provider ⇒ 整串 exact 匹配；>1 且未能按认证唯一化 ⇒ error `Model "s" is ambiguous across providers…`；0 ⇒ 全量模糊，仍无 ⇒ error `Model "s" not found.`                                              | `model-resolver.js:344-371,456-462`                                                   |
| 已知 provider + 未知 id ⇒ `buildFallbackModel` 造 custom model，仅 warning（`…Using custom model id.`），子进程正常 live，首条 prompt 才在 provider API 失败                                                          | `model-resolver.js:130-143,447-454`                                                   |
| `Unknown provider "x"` **只**在显式 `--provider` 时出现 ⇒ hub 场景永不出现（v1 错误）                                                                                                                                 | `model-resolver.js:312-318`                                                           |
| 诊断写 stderr：`Error: `/`Warning: ` 前缀，经 chalk（`FORCE_COLOR` 时含 ANSI）；有 error ⇒ `process.exit(1)`，早于 live                                                                                               | `main.js:69-75,742-750`                                                               |
| `--model` 只写会话，不写 settings.json                                                                                                                                                                                | `core/sdk.js:287`、`agent-session.js:1919`                                            |
| pi 改写 `process.title`，`/proc/<pid>/cmdline` **看不到** `--mode`/`--model`（v1 A3 用 cmdline 验收是错的）                                                                                                           | `tests/conformance/rpc-spawn.test.ts` C3                                              |
| 两处 cap 面各自**展开**同一个 `extraHubCaps` 源数组生成新数组——集合与顺序一致，**不是同一实例**（v1 与现有注释措辞错误）                                                                                              | `hub/hub.ts:213-217,345-351`、`hub/agent-server.ts:175-179`                           |
| LAN `spawn.lan:"off"`：`http.ts` 不分派到 spawn 路由（落穿原 404），`routes.ts handle()` 再守一次 404 pre-auth                                                                                                        | `http.ts:1267-1290`、`spawn/routes.ts:722-726`                                        |
| LAN 会话映射为不同 principal（`u<userId>`），测试里同时存在 Alice/Bob                                                                                                                                                 | `http.ts:1281-1284`、`tests/web-hub/http/lan-headless.test.ts:29-55`                  |
| spawn 写路径的二次授权模式：body 读与 admit 之后 `authorizeOrAudit`，其后到 `supervisor.start` 全同步                                                                                                                 | `spawn/routes.ts:569-589`；rotation/logout 由二次 authorize 捕获：`http.ts:1856-1867` |
| `spawns.json` 写纪律：同步 `writeFileSync(0600)`→`renameSync`，pid+gen tmp 名，进程崩溃无需 fsync                                                                                                                     | `spawn/store.ts:1-22,391,445-451`                                                     |
| 设置面板桌面 popover：`.settings-panel { width: min(400px, calc(100vw - 24px)) }`，`right:0` 贴齿轮；只在 ≥768px 存在，≤767px 是 PickerSheet 底部抽屉；`.settings-inner max-width:640px`                              | `styles/shell.css:123-150`、`styles/settings.css:19-28`                               |
| 模型列表：在线 agent 的 `StatusInfo.session.models`（SSE 快照），`@logic/models.js` 的 `modelsOf()`；provider/id 校验 `isValidProvider`/`isValidModelId`                                                              | `ModelSwitcher.vue:84`、`logic/models.js:52`、`protocol/models.ts`                    |

## 1. 决策

- **D1 全局单值偏好（显式安全决策）**：hub 侧 `<stateDir>/spawn-prefs.json` 一份，不按 principal 分片。依据用户裁定 **U1**
  （AGENTS.md web-hub preview 段：唯一 LAN 用户、密码认证后、风险显式接受）：**所有能到达 `/api/headless*` 的已认证 principal
  对该偏好同等可信**；同一人手机（LAN）+桌面（loopback）期望同一个值。约束：服从 `spawn.lan`——`lan:"off"` 时 LAN 读写均 404
  （与其它 headless 路由同一守卫，无新代码路径）；每次写都审计 `{principal, listener, ip, from, to}`。列为验收 A9。
  若未来出现真正的多用户 LAN，需重开此决策（分片或仅 loopback 可写），不在本期。空值 = 不传 `--model`。
- **D2 默认值在 hub 端解析**：请求体 `model` 三态——缺省 ⇒ hub 偏好；`""` ⇒ 显式 pi 默认；`provider/id` ⇒ 用它。
  旧缓存 UI / 重试 / 不认识字段的客户端自动吃默认。DirPicker 始终显式发送。
- **D3 记录持久化 `model`**：`StoredRecord.model?`、`SpawnRecordPublic.model?`（非敏感；SpawnRow 显示与忠实重试）。recovery 不 re-fork，不需要它。
- **D4 能力位**：hub cap `spawn.model.v1`，仅当 `config.spawn` 存在时加入 `extraHubCaps`（两面集合/顺序一致，见 §0）。
  旧 hub ⇒ 设置项禁用 +「请 /webhub restart 升级」；**UI 绝不向无 cap 的 hub 发 `model`**（旧 schema `additionalProperties:false` ⇒ 400）。
  旧 UI 收到未知 cap：现有逻辑全是 `caps.includes(x)`，未知值天然忽略（加测试钉住）。
- **D5 错模型不拖垮熔断 —「延迟熔断裁决」**（取代 v1 的「等 stderr end 再终态」）：
  - **终态结算不变、立即、唯一**：`onChildExit → finalizeTerminal` 照旧，状态机/计时器/`onTerminal`/stop/register-timeout 全不动。
  - **只把熔断计数推迟**，且只针对 `reason === "exited_early" && rec.model !== undefined`（`exited_early` 只在 `onChildExit` 非 stopping/非 live
    分支产生，`supervisor.ts:996-1004`；register_timeout/spawn_error/用户 stop 走原路径照常计数）。`finalizeTerminal` 中该条件成立时不调
    `noteLaunchFailure()`，改置 `rec.breakerVerdict = "pending"` 并 `arm(MODEL_VERDICT_GRACE_MS=250, settle)`（unref'd，独立字段，不进 `clearRecordTimers`）。
  - **独立探针缓冲**：`start()` 中 stderr 监听改为 `chunk => { rec.sink?.push(chunk); if (rec.rejectProbe !== undefined) appendCapped(rec.rejectProbe, chunk, 4 KiB 尾) }`，
    仅 `rec.model !== undefined` 时初始化；不依赖 sink（`cleanupHandles` 后、无 `stderrDir` 时都仍有效）。在同一同步段（`exit` 监听旁）
    挂 `child.once("close", () => settleVerdict(rec))`——Node 保证 `close` 在 `exit` 且全部 stdio 关闭之后，此时尾巴完整。
  - `settleVerdict(rec)`：`if (rec.breakerVerdict !== "pending") return;` 置 `"done"`、清计时器、取探针后丢弃；去 ANSI 后匹配
    `MODEL_REJECT_RE = /^Error: Model "[^\n]{1,300}" (not found\.|is ambiguous across providers)/m` ⇒ 不计数，且若
    `records.get(id) === rec && !closed` 则 `rec.hint = "model-rejected"` + persistDebounced + schedulePush + 审计；否则 `noteLaunchFailure()`。
    `close` 与 grace 谁先到都只结算一次；`close` 早于 `finalizeTerminal` 不可能（`close` 必在 `exit` 后，`exit` 同步进 finalize）。
  - 代价（接受）：≤250ms 窗口内并发 `start()` 少看到这一次失败；hint 在终态后 ≤250ms 补上（终态后注解，不是状态迁移）。
  - 不选「完全去掉豁免」：错默认值 4 次即开闸 10min，连显式好模型也被挡，修正设置后仍需等待——自伤；不选「新 pending 状态」：要改状态机矩阵。
  - **只覆盖 pi 能在启动期识别的拒绝**（not found / ambiguous）。known-provider + 错 id、provider 内子串误匹配 ⇒ 子进程 live，首条 prompt 才失败，hub 无法预检（不导入 pi）——见 R1。
- **D6 DirPicker「本次模型」**：独立组件 `SpawnModelField.vue`，DirPicker 只加 ~10 行挂载透传，在并行的 DirPicker Teleport 模态改造合入后叠加（包 F2）。
- **D7 模型列表**：在线 agent `session.models.items` 并集（去重 `provider/id`，cap 160），非空时写 localStorage `pwh_spawn_models_cache`
  （仅 `{provider,id,name?}`）；无在线 agent 用缓存；始终允许自由输入 + `<datalist>`；不在列表 ⇒ 软警告。不新增拉取请求。

## 2. 协议 / 校验（`src/web-hub/protocol/`）

- `spawn.ts`：`SPAWN_MODEL_MAX_BYTES = 257`；`parseSpawnModelRef(s)`：首个 `/` 切分，`isValidProvider && isValidModelId`，
  provider 另要求 `^[A-Za-z0-9][A-Za-z0-9._-]*$`（拒前导 `-`，防旗标混淆），UTF-8 ≤ 上限；id 允许 `/ : . @`（`:<thinking>` 交给 pi）。
  `SpawnRequestBody.model?: string`（schema `Type.Optional(Type.String({maxLength}))`）；`parseSpawnRequestBody` 新 error `"model-invalid"`（非 `""` 且解析失败）。
  `SpawnRecordPublic.model?`、`SpawnAccepted.model?`（生效值）；`SpawnHint` 加 `"model-rejected"`。
  偏好：`SpawnPrefsWire { defaultModel: string | null }`；`SpawnPrefsRequestSchema = {defaultModel: string}` strict（`""` = 清空）；`SPAWN_PREFS_BODY_MAX = 1024`。
- `version.ts`：`SPAWN_MODEL_HUB_CAP = "spawn.model.v1"`。`paths.ts`：`webHubSpawnFiles().prefsJson`。drift guard 保持。

## 3. Hub 侧（`src/web-hub/hub/`）

| 文件                                                               | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spawn/prefs.ts`（新，zero-`as`，注入 `SyncFs` 同 `store.ts:154`） | 见 §3.1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `spawn/routes.ts`                                                  | ① `SpawnIntent.model`；`intentDigest` 仅 `model !== undefined` 时追加（旧请求 digest 字节不变）；同 id 换 model ⇒ 现有 409。② **生效值在 gate 10 二次授权之后、gate 11 `supervisor.start` 之前的同步段**解析：`effective = intent.model ?? prefs.get() ?? ""` 写入 `AdmittedRequest.model`（`""`⇒undefined）；dup 命中返回原记录，不受后改偏好影响。③ `GET /api/headless` 加 `prefs`。④ `POST /api/headless/prefs`（`handle()` 新分支，GET ⇒ 404；lan-off 守卫已在其前）：strictCsrf → authorize#1 → 桶 `${principal}:spawn-prefs`（10/min）→ `readJson(≤1 KiB, 有界预算)` → schema/`parseSpawnModelRef` → **authorize#2**（照 `routes.ts:569-572`）→ **同步** `prefs.set` → 审计 → 200 `{prefs}`；#2 与 set 之间无 await。持久化失败 ⇒ 503 `E_LAUNCHER{reason:"persist"}`。⑤ `model-invalid` ⇒ 400 `E_BAD_REQUEST{reason}` |
| `spawn/supervisor.ts`                                              | `AdmittedRequest.model?`、`Supervised.{model, rejectProbe, breakerVerdict, verdictTimer}`；argv `[launcher[1], "--mode", "rpc", ...(model ? ["--model", model] : [])]`（独立元素，不拼串）；D5 全部逻辑；`storedSnapshot`/审计带 `model`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `spawn/store.ts`                                                   | `StoredRecord.model?`；读回 `parseSpawnModelRef` 失败 ⇒ 丢字段留记录；`HINTS` 加 `model-rejected`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `spawn/project.ts`                                                 | `toPublic` 透出 `model`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `audit.ts`                                                         | `SPAWN_AUDIT_KEYS` 加 `model`、`from`、`to`；endpoint 联合加 `"prefs"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `hub.ts`                                                           | `hub.ts:481` 旁构造 `createSpawnPrefs` 注入 routes；`extraHubCaps` 加 `SPAWN_MODEL_HUB_CAP`；修正 `hub.ts:210,341`、`agent-server.ts:176` 的「same array instance」注释为「同源数组展开，集合/顺序一致」                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `http.ts`                                                          | 无改动（前缀分派 `http.ts:1221`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### 3.1 `prefs.ts` 持久化规格（单值小文件，按比例从简）

- 文件 `{"v":1,"defaultModel":string|null}`；内存 `current: string | null`。无 debounce、无计时器、无 generation、无 unhealthy 态——每次 set 全量覆盖，rename 原子性保证磁盘只有「旧值」或「新值」。
- **load（hub 启动同步一次）**：先清理 `spawn-prefs.json.tmp-*` 残留（`readdirSync` 前缀匹配，`lstat` 为 regular 才 unlink）；
  `lstat(file)`：ENOENT ⇒ null；非 regular（symlink/目录/FIFO）或 `uid !== getuid()` 或 size > 4 KiB ⇒ null + warn 一次，**不动文件**；
  `open(O_RDONLY|O_NOFOLLOW)` 读 ≤4 KiB；JSON/`v`/`parseSpawnModelRef` 任一失败 ⇒ null + warn（不做 corrupt-rename，下次 set 覆盖）；mode ≠ 0600 ⇒ warn + 尽力 `chmod 0600`。
- **set(v)**：`tmp = ${file}.tmp-${randomBytes(6).toString("hex")}`；`openSync(tmp, "wx", 0o600)`（O_EXCL，不跟随预埋 symlink）→ `writeSync` → `closeSync` →
  `renameSync(tmp, file)` → `lstat(file)` 复核 regular 且 `(mode & 0o777) === 0o600`（否则 `chmodSync` 后再复核，仍失败视为失败）。
  不 fsync（同 `store.ts:8`：进程崩溃页缓存仍在；掉电最多回退到旧偏好，可接受）。
  任一步抛错 ⇒ best-effort unlink tmp，**内存不变**，返回 `{ok:false, code}`，路由审计 `code` 并 503。成功后才更新内存。
- 崩溃语义：tmp 写完 rename 前崩溃 ⇒ 旧值 + 残留 tmp（下次 load 清理）；rename 后、200 前崩溃 ⇒ 新值已落盘，客户端可重新 GET。
- `close()`：无事可做（无挂起写）。

argv 安全：无 shell；值经 `parseSpawnModelRef`（拒空白/控制/前导 `-`），无法注入旗标。

## 4. 前端（`src/web-hub/ui/src/`）

| 文件                                                      | 改动                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transport/types.ts`                                      | `SpawnListOutcome.ok.prefs?`；`SpawnTransport.setPrefs?(defaultModel)`（可选，旧 fake 不破）                                                                                                                                                                                                                                      |
| `logic/{token-client,password-client,contract}.js`        | 端点 `headlessPrefs`；两客户端 `setPrefs`（沿用 headless 的 withRelogin / 401⇒auth）                                                                                                                                                                                                                                              |
| `logic/models.js`                                         | `knownModelRefs(agents)`（并集去重 cap 160）、`readModelCache/writeModelCache`（容错）、`isSpawnModelRef`（经 `@protocol` 复用 `parseSpawnModelRef`）                                                                                                                                                                             |
| `logic/spawn.js`                                          | `spawnModelSupported(hubCaps)`；`classifySpawnError` 映射 `model-invalid`；hint `model-rejected` 文案 key；未知 hint 安全降级（无 default 分支则补）                                                                                                                                                                              |
| `composables/useSpawn.ts`、`useNewSession.ts`、`types.ts` | `prefs` ref / `refreshPrefs()` / `setDefaultModel()`；`NewSessionInput.model?` 仅在 cap 存在时进 body（二次 cap 守卫）                                                                                                                                                                                                            |
| `components/shell/SettingsView.vue`                       | 新卡片「新建会话默认模型」：input+datalist +「使用 pi 默认」+ 保存；本地校验；保存中/已保存/失败（role=status）；无 `spawn.v1` 不渲染；无 `spawn.model.v1` 禁用+升级提示；说明「仅影响 hub 新建的会话，不修改 ~/.pi/agent/settings.json；所有登录设备共享此值」                                                                   |
| `components/spawn/SpawnModelField.vue`（新，F2）          | props `{modelValue, defaultModel, options}`；占位「默认：x / pi 默认」                                                                                                                                                                                                                                                            |
| `components/spawn/DirPicker.vue`（F2，模态改造合入后）    | cap 存在时挂字段，初值 `prefs.defaultModel ?? ""`，`onSubmit` 显式带 `model`（含 `""`）；无效禁用提交                                                                                                                                                                                                                             |
| `components/spawn/SpawnRow.vue`                           | `model` 小标签（English token）；重试带 `model: rec.model ?? ""`（仅 cap 存在）                                                                                                                                                                                                                                                   |
| `styles/shell.css`                                        | `.settings-panel { width: min(720px, calc(100vw - 32px)); }`（写字面 32px，不经 token）                                                                                                                                                                                                                                           |
| `styles/settings.css`                                     | `.settings-inner` 去 `max-width:640px`；`.settings-grid { display:grid; gap:var(--sp-4); grid-template-columns: repeat(auto-fit, minmax(300px,1fr)); }`（主题+字号同行，投递方式与默认模型 `grid-column:1/-1`）；`.settings-model-row` input `flex:1; min-width:0`，长 provider/id `overflow-wrap:anywhere`；coarse pointer ≥44px |
| `i18n/{zh,en}/{settings,spawn}.ts`                        | settings：`defaultModel{Section,Hint,Placeholder,UsePi,Save,Saved,Invalid,Unsupported,SaveFailed,NoList,NotInList,Shared}`；spawn：`pickerModel{Label,Default}`、`errModelInvalid`、`hintModelRejected`（F1 一次加齐，F2 不动 i18n）。不碰他人改动中的 `i18n/en/shell.ts`                                                         |

## 5. 包划分与并行

| 包                    | 文件域                                                                                                                                                                                                                                                                           | 依赖                        | 并行                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------- |
| **H1 protocol**       | `protocol/{spawn,version,paths}.ts` + 对应测试                                                                                                                                                                                                                                   | —                           | 先行，冻结接口               |
| **H2 hub**            | `hub/spawn/{prefs(新),routes,supervisor,store,project}.ts`、`hub/{audit,hub,agent-server}.ts`（后者仅注释）、`tests/web-hub/{hub/spawn,http}/*`、`tests/integration/web-hub-headless.test.ts`、`fixtures/fake-rpc-pi.mjs`、`tests/conformance/rpc-spawn.test.ts`、`arch.md` 措辞 | H1                          | 与 F1 并行                   |
| **F1 前端设置**       | §4 除 F2 外全部 + UI 测试                                                                                                                                                                                                                                                        | H1                          | 与 H2 并行（fake transport） |
| **F2 DirPicker 字段** | `SpawnModelField.vue`、`DirPicker.vue`、`dir-picker.test.ts`                                                                                                                                                                                                                     | F1 + DirPicker 模态改造合入 | 最后串行                     |

## 6. 测试

- **protocol**：`parseSpawnModelRef` 正例（`anthropic/claude-opus-4-5`、`openrouter/openai/gpt-4o:extended`、`vertex/claude@2024`）/反例（空 provider、`-x/y`、空白、`\n`、`\u200b`、>257B、无 `/`）；body 三态 + `model-invalid`；cap 值钉死；prefs schema strict。
- **prefs.ts 单测**（注入 SyncFs / 真 tmpdir）：缺失 ⇒ null；symlink / 目录 / FIFO / 他人 uid / >4 KiB / 坏 JSON / 非法模型 ⇒ null 且文件原样；残留 `.tmp-*` 被清、非 regular 残留不碰；set 后 mode 0600；`wx` 撞名 / write / rename 抛错 ⇒ 内存不变、tmp 被删、返回 code；mode 复核失败 ⇒ 失败。
- **supervisor**（`spawnFn` 接缝 + fake timers）：无 model argv 与旧版逐元素相同；有 model 末尾两个独立元素、opts 无 `shell`；D5 组合矩阵，每格断言「终态恰一次 + 熔断计数恰 0/1 次」：
  `data(拒绝)→exit→close`、`exit→data(拒绝)→close`、`exit→close` 无 stderr、`exit` 后 close 永不来（grace 到点按已收尾巴）、grace 后迟到的 `close`/`data`（无二次结算）、
  ANSI 着色拒绝文案、`Warning: …Using custom model id.`（不豁免）、无 `stderrDir`（探针仍生效）、record 在 pending 内被 trim/delete（计数仍结算、不注解）、`close()` 期间 pending、
  无 model 的 `exited_early`（同步计数，与旧版一致）、stopping 中 exit / register_timeout / spawn_error（原路径，不进 pending）；连续 5 次拒绝不开闸，4 次普通早退照旧开闸。
- **store**：`model` 往返；非法丢字段；旧文件兼容；新 hint 读回。
- **routes / HTTP**（`tests/web-hub/http/api-headless.test.ts`、`lan-headless.test.ts`，真 HTTP + fake supervisor kit）：
  缺省 ⇒ 用偏好、`""` ⇒ 不加旗标、同 id 换 model ⇒ 409、同 id 同 model 重放在改偏好后仍返回原记录、无 model 请求 digest 钉已知 hex；
  prefs POST 的 CSRF 四件套 / 401 / 429 / schema / 持久化失败 503；
  **二次授权竞态**：照 `api-headless.test.ts:64,464` 的 `parkedSpawnPost` 两段 body，中途 loopback `/api/logout` ⇒ 401 且 `prefs.set` 未调用、值未变；token rotate 同测；LAN 中途 `revokeAllSessions` 同测；
  **全局共享（U1）**：Alice（LAN）写 ⇒ Bob（LAN）与 loopback 的 `GET /api/headless` 看到同值，loopback 随后新建的 `startCalls[0].model` 即该值；审计行含 `user:"u1"`、`listener:"lan"`、from/to；
  **`lan:"off"`**：LAN `POST /api/headless/prefs` 与 `GET /api/headless` 均 404（pre-auth，与未启用字节一致），loopback 同时正常读写。
- **caps**（扩 `caps-coexist.test.ts`、`hub-spawn.test.ts`）：`config.spawn` 存在 ⇒ 两面同含 `spawn.v1`+`spawn.model.v1` 且序列相等；关闭 ⇒ 字节不变；`logic-spawn.test.ts`：多一个未知 cap 时 `spawnAvailability` 结果不变。
- **integration**（`tests/integration/web-hub-headless.test.ts`，真 hub 子进程，新 H9）：`fake-rpc-pi.mjs` 加 `FAKE_ARGV_OUT` 把 `process.argv` 写文件 ⇒ 断言 `--model` 两元素到达；
  fake 遇 `--model nosuch/x` 打 `Error: Model "nosuch/x" not found.` 并 exit 1 ⇒ `failed{exited_early, hint:"model-rejected"}`，连续 5 次后普通新建不被 `E_LAUNCHER{breaker}` 挡；
  POST prefs 后 SIGTERM hub、再起 ⇒ GET 值保持；POST 200 后立即 SIGKILL hub、再起 ⇒ 值保持；手工放 `spawn-prefs.json.tmp-x` 残留 ⇒ 重启后被清；把 prefs 换成 symlink ⇒ 重启读为 null 且不跟随。
- **conformance（必测，`tests/conformance/rpc-spawn.test.ts`，真 pi，temp HOME 写 `models.json` 两个自定义 provider `p1`/`p2` 各含 id `dup/m`）**：
  CM1 `--model nosuch-prov/zz-nope` ⇒ exit 1、无 session 帧、stderr 命中 `MODEL_REJECT_RE`；CM2 `--model dup/m` ⇒ exit 1、命中 ambiguous 分支；
  CM3 `--model p1/typo-xyz` ⇒ stderr 只有 `Warning: …Using custom model id.`、**不**命中正则、hello+session 到达（live）；CM4 `FORCE_COLOR=1` 下 CM1 去 ANSI 后仍命中；
  CM5 `--model p1/<真实 id>` ⇒ rpc `get_state` 回报该模型（替代 v1 错误的 cmdline 断言）。正则从 supervisor 导出供测试共用。
  该套件 `describe.skipIf(!existsSync(PI_CLI))`，不进默认 CI ⇒ H2 合并前必须本地 `npm run test:conformance` 全绿并在 PR 记录；pi 升级若 CM1/CM2 失败，D5 退化为 fail-safe（照常计数、无 hint），**不得宣称 A6 已验收**。
- **UI**：`settings-view.test.ts`（无 cap 不渲染 / 旧 hub 禁用 / 本地校验 / 保存成功失败 / datalist 并集 / 无 agent 用缓存 / 不在列表软警告）；`logic-models.test.ts`；`logic-spawn.test.ts`；
  `logic-client*.test.ts`（`setPrefs` 路径与 401）；`use-new-session` / SpawnRow：无 cap 时 body 无 `model` 键、有 cap 重试带 model；`settings-overlay.test.ts`（宽度规则文本钉住）；
  F2 `dir-picker.test.ts`；`i18n-parity`、`source-scan`（zero-`as`、`no-innerhtml`）保持绿。

## 7. 风险

- **R1** known-provider + 拼错 id / provider 内子串误匹配：子进程 live，首条 prompt 才在 provider 报错（或静默用了别的模型），hub 无法预检。缓解：列表优先 + 不在列表软警告；SpawnRow 显示 `model` 标签，会话 header 显示实际模型。验收 A6b 单列。
- **R2** D5 依赖 pi 文案：变化只会退化为「计数 + 无 hint」，不会误豁免；由 conformance CM1-CM4 守。
- **R3** D1 全局共享：基于 U1 接受；若 LAN 出现第二个真实用户需重开。
- **R4** 与 DirPicker 模态改造冲突：F2 严格后置、独立组件。
- **R5** `arch.md`「hub forks a FIXED argv」措辞改为「固定前缀 + 可选 `--model <ref>` 尾部」，`fake-rpc-pi.mjs` 注释同步。

## 8. 验收标准

- **A1** 视口 1440 / 1024 / 768：`.settings-panel` computed width = `min(720, innerWidth − 32)` px，`getBoundingClientRect()` 左 ≥0、右 ≤ innerWidth，主题/字号并排（≥1024），
  datalist 展开、保存状态行、257B 长 provider/id 均无横向溢出；767 / 320：无 `.settings-panel`，为底部抽屉单列且无溢出（DevEye 真机走查记录截图）。
- **A2** 默认模型重启 hub 后保持；`~/.pi/agent/settings.json` mtime/内容不变。
- **A3** 新建会话实际使用该模型：fake-pi argv 文件含 `--model <ref>`（H9）、真 pi `get_state` 回报（CM5）、会话 header 显示；清空后 argv 无 `--model`。
- **A4** DirPicker「本次模型」预填默认，改写只影响本次；清空 ⇒ pi 默认。
- **A5** 非法输入（空白、前导 `-`、控制字符）前后端都拒，400 `model-invalid`；同 id 换 model ⇒ 409。
- **A6** 启动期可识别拒绝（not found / ambiguous）⇒ `failed{exited_early}` +「模型无效」hint，连续 5 次不开闸；普通早退 4 次仍开闸。仅当 CM1/CM2 绿时可宣称。
- **A6b** known-provider 错 id ⇒ 会话 live，首条 prompt 报 provider 错，hub 不豁免、不打 hint（行为如实记录）。
- **A7** 旧 hub（无 `spawn.model.v1`）：设置项禁用并提示升级，新建请求无 `model` 键，功能与改前一致；旧 UI 对新 hub 不受影响。
- **A8** `npm run format:check && typecheck && test && build && build:web` 全绿；H1–H8 不回归；`test:conformance` 全绿（记录于 PR）。
- **A9（安全）** 全局单值按 U1 显式接受：LAN 用户写入即影响 loopback 与其他 LAN 会话的新建，审计行带 principal；`lan:"off"` 时 LAN 读写均 404；logout/rotate 与 body 读竞态时写入被拒且值不变。

## 9. v2 修订记录

| #   | 评审问题                         | 处理                                                                                                                                         |
| --- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 全局偏好可被任意 LAN 用户改      | 保留全局单值，改为基于 U1 的**显式安全决策**（D1），服从 `spawn.lan`（off ⇒ 404），审计带 principal，验收 A9 + HTTP 测试                     |
| 2   | prefs 写缺二次授权               | authorize#2 紧贴同步 `prefs.set`（§3 ④，照 `routes.ts:569-572`）；loopback logout / rotate / LAN revoke 竞态测试                             |
| 3   | stderr 等待竞态与熔断重复结算    | 澄清监听同步段内安装不漏早期数据；改为「终态立即且不变 + 熔断裁决一次性延迟」（D5），独立探针 + `close`/250ms grace 二选一结算；组合矩阵测试 |
| 4   | 未知 provider/模型描述不准       | §0 按 pi 源码重写：hub 无 `--provider` ⇒ 无 `Unknown provider`；只认 not-found / ambiguous；custom-id 与子串误匹配归 R1 / A6b                |
| 5   | prefs 持久化规格不全             | §3.1：随机 `wx` tmp、rename、0600 复核、残留清理、读上限、非 regular/symlink/他人 uid 拒绝、失败内存不变 + 审计、崩溃语义                    |
| 6   | 「同一数组实例」错误             | 改为「同源展开、集合/顺序一致」，顺手修现有注释；未知 cap 降级与缺 cap 不发 `model` 加测试                                                   |
| 7   | 宽度验收绑定 token、视口边界不清 | 字面 `32px`；A1 按 1440/1024/768/767/320 computed-style 验收，含 datalist/状态/长 id                                                         |
| 8   | 测试未覆盖授权与跨用户语义       | §6 HTTP/integration 增：二次授权竞态、Alice/Bob/loopback 共享与生效、lan-off 双向、重启/崩溃、残留 tmp、symlink                              |
| 9   | 真 pi conformance 可选           | 改为必测 CM1-CM5（含 ambiguous、custom-id）；失败则 D5 退化 fail-safe 且不宣称 A6                                                            |
| —   | v1 A3 用 cmdline 验收            | pi 改写 title（C3），改为 fake-pi argv 文件 + 真 pi `get_state`                                                                              |

## 10. v2 复审（PASS-with-changes）并入项

- R2-1：真 pi conformance（CM1–CM5）列为 H2 合入闸门：本机有 pi 时必须执行并通过；无 pi 环境须显式标记「环境阻断」，不得宣称 A6 已验收。
- R2-2：routes 测试补 `SpawnAccepted.model` 响应断言：首次 202、同 id 重放 dup 202、显式 `""`（省略 model）、偏好变更后重放（仍返回原记录的 model），均与持久化 record / argv 一致。
