# Fast · 开发者要点

## 当前实现边界（task55 P4a）

已实现共享合同与配置解析，**尚未实现 `/fast` 命令、请求 hook、持久化、child 首 prompt 接线或 queue 捕获**。设计见 [plan.md](./plan.md) 与 [arch.md](./arch.md)。本 README 后续由集中 P4b owner 维护；不能将默认开关已解析表述为功能已经可用。

- `src/core/types.ts`：pi-free 的 `FastMode = "inherit" | "on" | "off"`；`FastRecord` / `FastSeed` 仅包含 readonly `v: 1` 与 `mode`。内部 `SpawnRequest` / `SessionSpec` 的 `readonly fastSeed?: FastSeed` 为可选字段，缺省不制造 `undefined` 键；不进入 Agent schema/description、promptNotes、worker 公共 options 或网络 PROTO。
- `src/fast/ports.ts`：纯结构合同，无实现、pi 导入、模块可变状态、全局 registry、Symbol、timer 或新 store。
  - `FastSnapshot` 包含 mode/revision/incarnation，仅供 activation 内使用；seed、record、journal hash **只能投影 v/mode，不传播 volatile 字段**。
  - `FastParentPort.snapshot(parentRunId?)` 提供受理时父模式；`FastWorkflowPort.capture()` 为 host-only、replay/FIFO 前捕获端口。disabled 返回 undefined，不能制造 inherit seed。
  - `FastOwner` 用受信 `parentRunId` 和 owner `incarnation` 绑定具体 child；`FastChildStatePort.bind(owner, readMode)` 绑定只读当前 branch mode，返回同步幂等 cleanup。旧 owner cleanup 不得撤销替代绑定；abort/create 失败/dispose 都必须清理，不能只等 session_shutdown。绑定前用已受理 seed，不回查 root；这些是未来实现必须满足的端口语义，本包未实现 registry。
- `fast.enabled` 使用既有 `EnabledGroup` / `parseEnabledGroup` / boolean spec：默认 true；显式 false 为未来的 I9 零接线总开关。异常 block/非 boolean 值回退 true，不做字符串/数字强转。非 live，修改后需 `/reload`。不新增全局默认 mode，session 初始 inherit 由未来 wire 实现。

## 集成门与未完成项

P1/P2/P3/P4b 消费这些合同，不反向依赖未落地的 state/wire。按 root 单点追加授权，`src/service/request-threading.ts` 的 NOT_THREADED 精确分类 fastSeed：它是控制面 seed，不是 `ResolvedSpawnRequest` runner 字段；原 Gate A/B/C 不放松。**当前 adapter 尚未消费该字段，P3 必须显式完成 request → SessionSpec.fastSeed 传递并添加行为断言**，不得以“不进 runner”为由永久丢弃。两层 queue、nested 当前 branch、terminal resume seed 覆盖、同 bus receiver 就绪及身份清理必须由对应包验证；本包不宣称已集成。

V4 旧 SDK append ghost **仍是持久化集成阻塞**；`getBranch()` 不是持久证明。本包不解决它、不加 sidecar 或私有 rollback、不扩 peer。V2 双 loader 就绪仍需独立证明。原 secure D8 强制 off 列表不变，无新明文 store；未来 wire 必须接原 locked/cross-domain guard，不新增例外。

本包没有注册 command/hooks，所以不改 activation trace；未来 P4b 默认 true profile 的 B 级 trace 刷新须集中授权，显式 false 与旧 disabled 基线一致。A 类及 nested golden 永不重生。新增 setting 的兼容检查由 P4a 配置 owner 按追加授权整合：旧 spec 精确剔除 `fast.enabled` 后保持全部原列表/相对顺序/逐项及整体 hash；另断仅新增这一项、末尾 UI 排序及精确 spec/default true。旧 settings DTO 只剔除顶层 fast，逐 case 断其为 `{ enabled: true }` 后，保留旧字段顺序/值/warns/files 全部原 hash。`__corpus__`、模板、baseline hash 与 generator 非投影路径不变，不重生旧 refactor corpus。

## 定向验证

- `tests/config/fast-settings.test.ts`：默认 true、显式 false、旧 caller、异常值、非 live boolean spec 及输入 validation。
- `tests/fast/ports.test.ts`：可选 seed / legacy caller、仅 v/mode 序列化、同步只读与 owner-scoped cleanup 的类型合同；端口没有运行时实现，因此不冒充 cleanup 行为测试。`expectTypeOf` 断言须另跑 TypeScript 检查，普通 Vitest transpile 不验证类型。
- 既有 `tests/boundary/pi-free.test.ts` 与定向 config 回归；精确 prettier、typecheck 及 diff check。隔离 worktree 的 runner/cache 必须指向自己的 `/tmp`，不得向共享 node_modules 写 `.vite` / JITI cache。
