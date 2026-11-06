# Fast · 开发者要点

## 当前实现边界（task55 P4a + P1）

已实现共享合同、配置解析与 **P1 状态/命令解析/最终 payload 判形的纯逻辑**，**尚未实现 `/fast` 命令接线、请求 hook、持久 controller、child 首 prompt 接线或 queue 捕获**。设计见 [plan.md](./plan.md) 与 [arch.md](./arch.md)；其中旧 SDK 兼容阻塞文字由 task45 独占更新，最新用户决定为整个 Toolkit 最低宿主提升到 pi 1.5。本 README 在 P1 交付后交回集中 P4b owner；不能将默认开关已解析或纯 helper 通过表述为功能已经可用。

- `src/core/types.ts`：pi-free 的 `FastMode = "inherit" | "on" | "off"`；`FastRecord` / `FastSeed` 仅包含 readonly `v: 1` 与 `mode`。内部 `SpawnRequest` / `SessionSpec` 的 `readonly fastSeed?: FastSeed` 为可选字段，缺省不制造 `undefined` 键；不进入 Agent schema/description、promptNotes、worker 公共 options 或网络 PROTO。
- `src/fast/ports.ts`：纯结构合同，无实现、pi 导入、模块可变状态、全局 registry、Symbol、timer 或新 store。
  - `FastSnapshot` 包含 mode/revision/incarnation，仅供 activation 内使用；seed、record、journal hash **只能投影 v/mode，不传播 volatile 字段**。
  - `FastParentPort.snapshot(parentRunId?)` 提供受理时父模式；`FastWorkflowPort.capture()` 为 host-only、replay/FIFO 前捕获端口。disabled 返回 undefined，不能制造 inherit seed。
  - `FastOwner` 用受信 `parentRunId` 和 owner `incarnation` 绑定具体 child；`FastChildStatePort.bind(owner, readMode)` 绑定只读当前 branch mode，返回同步幂等 cleanup。旧 owner cleanup 不得撤销替代绑定；abort/create 失败/dispose 都必须清理，不能只等 session_shutdown。绑定前用已受理 seed，不回查 root；这些是未来实现必须满足的端口语义，本包未实现 registry。
- `fast.enabled` 使用既有 `EnabledGroup` / `parseEnabledGroup` / boolean spec：默认 true；显式 false 为未来的 I9 零接线总开关。异常 block/非 boolean 值回退 true，不做字符串/数字强转。非 live，修改后需 `/reload`。不新增全局默认 mode，session 初始 inherit 由未来 wire 实现。

## 集成门与未完成项

P1/P2/P3/P4b 消费这些合同，不反向依赖未落地的 state/wire。按 root 单点追加授权，`src/service/request-threading.ts` 的 NOT_THREADED 精确分类 fastSeed：它是控制面 seed，不是 `ResolvedSpawnRequest` runner 字段；原 Gate A/B/C 不放松。**当前 adapter 尚未消费该字段，P3 必须显式完成 request → SessionSpec.fastSeed 传递并添加行为断言**，不得以“不进 runner”为由永久丢弃。两层 queue、nested 当前 branch、terminal resume seed 覆盖、同 bus receiver 就绪及身份清理必须由对应包验证；本包不宣称已集成。

P0 已独立验证 pi 1.5 七场景回滚，**只证明该故障回滚范围安全，不等于 Fast 全功能或生产故障处理已接线**。pi 1.4 characterization 测试绿表示复现已知不安全行为，不表示安全；1.4 已不在用户最新批准的目标支持范围。`getBranch()` 仍不是持久证明；P4b 必须保证 SDK 1.5 写失败时不应用/继承失败新值，保留最后成功状态与 storage-fault，初始化失败不得 prompt。P1 不做磁盘/SDK 写、不加 sidecar/私有 rollback/runtimeIO probe，也不修改 peer/package/lock（task45 owner）。V2 双 loader 就绪仍需独立集成证明。原 secure D8 强制 off 列表不变，无新明文 store；未来 wire 必须接原 locked/cross-domain guard，不新增例外。

本包没有注册 command/hooks，所以不改 activation trace；未来 P4b 默认 true profile 的 B 级 trace 刷新须集中授权，显式 false 与旧 disabled 基线一致。A 类及 nested golden 永不重生。新增 setting 的兼容检查由 P4a 配置 owner 按追加授权整合：旧 spec 精确剔除 `fast.enabled` 后保持全部原列表/相对顺序/逐项及整体 hash；另断仅新增这一项、末尾 UI 排序及精确 spec/default true。旧 settings DTO 只剔除顶层 fast，逐 case 断其为 `{ enabled: true }` 后，保留旧字段顺序/值/warns/files 全部原 hash。`__corpus__`、模板、baseline hash 与 generator 非投影路径不变，不重生旧 refactor corpus。

## 定向验证

- `tests/config/fast-settings.test.ts`：默认 true、显式 false、旧 caller、异常值、非 live boolean spec 及输入 validation。
- `tests/fast/ports.test.ts`：可选 seed / legacy caller、仅 v/mode 序列化、同步只读与 owner-scoped cleanup 的类型合同；端口没有运行时实现，因此不冒充 cleanup 行为测试。`expectTypeOf` 断言须另跑 TypeScript 检查，普通 Vitest transpile 不验证类型。
- 既有 `tests/boundary/pi-free.test.ts` 与定向 config 回归；精确 prettier、typecheck 及 diff check。隔离 worktree 的 runner/cache 必须指向自己的 `/tmp`，不得向共享 node_modules 写 `.vite` / JITI cache。

## P1 纯接口（供 P4b 消费）

- `state.ts` 使用冻结的 core `FastMode/FastRecord/FastSeed`，不创建平行模式类型。`foldFastBranch(branch)` 返回 `{ mode, invalidRecord }`；`readFastMode` 为只取 mode 的便捷函数。只看当前 branch 的最后 own `type=custom/customType=subagent:fast` 记录；未来版本/畸形最新记录返回 inherit+invalid，不穿透旧 on。普通或 null-prototype 记录只取 own data descriptor 的 v/mode，额外字段不读；恶意 entry prototype/accessor fail closed，不执行 getter。无记录 inherit。
- `validateFastRecord(unknown)` 返回新 `{v:1,mode}` 或 undefined；`snapshotToFastSeed(FastSnapshot)` 显式只投影 v/mode，不 spread revision/incarnation/owner。无持久化、controller、owner registry 或 SDK 对象。
- `parseFastCommand(args)` 返回 `{kind:"command",command:FastMode|"toggle"|"status"}` 或 `{kind:"usage"}`。trim+大小写不敏感；reset→inherit；空参数→toggle。`resolveFastCommandMode(current, parsed)` 返回需保存的新 mode，usage/status/同 mode 返回 undefined。`toggleFast` 为 on→off、off/inherit→on。helper 不写状态，**调用方须先保存成功再应用，不能先应用后补偿**。
- `classifyResponsesPayload(payload)` 返回 responses（含 family/payloadModel/结构 dialect）、other 或 unsupported。`rewriteFastPayload(payload, snapshot)` 在 inherit **直接返回 undefined，不触摸 payload、不遍历、不克隆、不删原 tier**；on/off 每次重新判形，不能拿 stale shape 绕门禁。返回 `applied` 时包含 `replacement/requestedTier/shape`，只浅拷贝顶层 service_tier 为 priority/default，所有嵌套引用、reasoning 和冻结原请求保持不变；没有 model/ctx 参数，selection/虚拟路由不能代替实际 body。
- unsupported 的 `reason` 是安全枚举：`unsafe-object | mixed-protocol | unknown-root-field | invalid-root | invalid-input | invalid-tools | invalid-tool-choice`。不携带 payload、正文、未知键名或捕获异常文本；other 为非 Responses suspended。两者均无 replacement，**原请求由 SDK 继续处理，不 throw 假装阻断，不添加重试/降级**。applied 只表示 at-hook 请求值，不能声称代理落实/逐请求 observed/费用确认。
- 根 allowlist、混合协议 denylist、各根字段类型、message/image/function/custom/output/reasoning/additional_tools/configuration_update/tool_search 与顶层 tools/tool_choice 均检查。JSON Schema 参数内部与图片正文不遍历、不 stringify。未知 variant 保守 unsupported，不按 provider/model 名单放行。dialect 仅结构提示，不是 API/transport 身份。
- incarnation 有效性、callback 入口 snapshot 捕获、storage-fault、旧响应丢弃、owner 绑定及 UI 全留 P4b。P1 无 timer/Symbol/模块可变状态/pi runtime 依赖。已交付 replacement 不随下一次切档变化；native warming 合法 body 使用相同 helper，不改变 warming 调度。premium 仍未知。

## P1 验证边界

- `tests/fast/{state,command-parser,payload}.test.ts` 是纯逻辑测试：branch/未来墓碑/own 属性/getter 零执行、仅两键 seed、非法命令零 transition、root/items/tools allowlist、混合协议与非法类型拒绝、inherit 零访问、冻结原对象/嵌套引用/reasoning、已交付 body 切档不变。
- `tests/conformance/fast-payload-sdk.test.ts` 属自动 tier2：调用已安装 **真实 pi-ai 1.5.0 的 stream/streamSimple 构造器**，在合参后的 onPayload 调用 helper，再捕获 SDK 最终 fetch body / Codex WebSocket `response.create` 帧；不是自造 buildParams。普通 Responses、Azure deployment、Codex SSE/受控 WS 三态，text/image/function/grammar/tool output/reasoning/additional tools/search/configuration update、空 input/warm-shaped 请求与不同 selection API 均覆盖。未知或混合真实构造器 body 仍发送一次原值，不静默重试。
- 测试只用 loopback URL 的进程内 fake fetch/受控 WebSocket；全局 fetch 同受 loopback guard，真实 Socket.connect 硬拒，fake Codex token 仅本地。无模型、认证、代理或外部网络。SDK 语料证明合法构造器形状与最终序列化，不冒充实际 CacheWarmer 调度、AgentSession 虚拟路由、故障 controller、wire 次序或全功能集成验证。
- P1 验证使用只读 `/tmp/c45-ccG9/node_modules` 的真实 1.5 依赖；本 worktree baseline package 声明仍为 1.4（task45 并行拥有修改）。cache/HOME/agent/TMPDIR 均独立 `/tmp/fast55-p1`，不向共享依赖写缓存，不安装依赖。未重跑历史 36 次线上报告，不宣称性能/收费证据。
