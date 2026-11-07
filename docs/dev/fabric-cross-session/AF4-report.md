# AF4 命令包交付报告（#72 alias-force-default r2）

工作区：`/tmp/alias-af4`；分支：`feat/alias-72-af4`；基线：`9ce5abc7`（AF0）。仅实现 §10 AF4，未 install、未改主工作区、未修改其它包或 `tests/fixtures/`。README 的终局更新仍由 AF6 负责。

## 提交与文件

1. `8c548777` — `feat(fabric): remember human alias decisions per session`
2. `f9c85441` — `feat(fabric): preview and confirm forced alias takeovers`
3. 最后一条提交仅包含本报告。

| 文件（均相对本 worktree）                     | 内容                                                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/fabric/xs/alias-decided.ts`              | 新增 entry、完整 entries 读回、同步先内存后 persist 的决定端口                                                                            |
| `tests/fabric/xs-alias-decided.test.ts`       | 9 个测试：五种 via、顺序、失败写盘、sid 隔离、全 entries 与 tree 分支差异、损坏条目不能撤销决定                                           |
| `src/commands/fabric-xs.ts`                   | force 互斥解析与预览、写前钩子、确认/错误/clear 文案、status 后缀与本地补全；可选装配端口                                                 |
| `tests/commands/fabric-xs-alias.test.ts`      | 67 个命令测试（含既有用例），覆盖互斥零请求/零标记、TUI 确认与取消、web/RPC 确认行解析、写前持久化、失败写入、飞书入口与 v1/auto-off 兼容 |
| `docs/dev/fabric-cross-session/AF4-report.md` | 本报告与 AFW 接口约定                                                                                                                     |

## 行为与边界

- `--force` 仅预览。与 `--take`、`--take=<token>`（含空值）、`--clear` 任意次序组合，重复 force，或 `--force=<值>`，均在任何桥请求、确认或决定标记之前报用法错误。执行仍调用 `bridge.take(alias, token)`，不新增执行帧或客户端 mode 参数。
- TUI 本地确认后才写标记并执行。web（包括 mode=tui 的 web 调用）/RPC 只回显预览，最后一行仍由 `formatTakeConfirmLine` 生成；`parseTakeConfirm` / 正则未改，真实往返断言通过。
- force 确认显示清理后的对方目录、在线/离线时长、自动认领来源以及之后的消息改投和已发消息 pin 语义。v2 下 take 的 online/recent 错误、set 的 taken 错误提示 `--force`；confusable 不误导抢占。unnotifiable 使用方案的明确拒绝文案。
- 设置、清除、显式 token 执行，以及 TUI 确认后的 token 执行，均在桥写请求前同步 `markDecided`。D6 也覆盖 hub/IO 失败、离线本地拒绝、非法别名和非法 token 的人工写意图；纯语法错误、get、预览、取消、alias disabled 和飞书入口不写。
- 决定 entry 是 `custom` 而非 provider 消息；本包不新增工具、命令注册或 agent 入口。飞书 handler 首段的硬拒绝保持，测试证明拒绝时连 alias/enable 端口都没有读取。
- 无模块级可变状态、无新 timer/轮询/后台任务、无新 deadline。决定端口随 stack 重建；token 来源提示缓存仅在命令闭包中，容量最多 32（FIFO）。不改 PROTO、wire schema、HubConfig、secure 门禁或三个 fabric off golden。

## 给 AFW 的接口（需接线，否则新钩子/显示保持关闭）

### 1. 决定 entry 与端口

`src/fabric/xs/alias-decided.ts` 导出：

```ts
XS_ALIAS_DECIDED_CUSTOM_TYPE = "subagent:xs-alias-decided";
type XsAliasDecidedVia = "set" | "clear" | "take" | "force" | "inherit";
interface XsAliasDecidedEntryData {
  v: 1;
  sessionId: string;
  at: number;
  via: XsAliasDecidedVia;
}
type XsAliasMarkDecided = (via: XsAliasDecidedVia) => void;
interface XsAliasDecidedPort {
  decided(): boolean;
  markDecided: XsAliasMarkDecided;
}
```

- `readXsAliasDecidedEntry(entries, sessionId)`：从后往前找最近的合法同 sid 决定。忽略异 sid、坏版本、非法 via、非法时间；坏的新条目不会撤销早先的合法决定。传 **getEntries()**，不能传 getBranch()。fork 的旧 sid 被忽略；`/tree` 不撤销人工决定。
- `createXsAliasDecided({sessionId, entries, persist, now?})`：返回上述端口，每个 stack/sid 一个实例。`persist` 是同步 `(data: XsAliasDecidedEntryData) => void`，AFW 适配 `pi.appendEntry(XS_ALIAS_DECIDED_CUSTOM_TYPE, data)`；不要传异步写盘函数。先置内存 true 再 persist，异常吞掉，不回退内存标志；每次人工操作仍会 append 一条。
- AFW 把同一个实例的 `decided()` 供给 AF3 auto 判定，把 `markDecided`/`decided` 供给命令。沿现有 main/xsOn/alias.enabled 门禁构建，secure 的 D8 强制关闭不能通过新端口绕开。AF7 继承时用新 sid 的实例 `markDecided("inherit")`。

### 2. 命令端口

`src/commands/fabric-xs.ts` 的 `FabricXsAliasPort` 在 v1 上追加可选字段：

| 字段                                                       | AFW 应提供                                                                                                  |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `hubAliasV2?(): boolean`                                   | 当前 hub caps 是否包含 `xs.alias.v2`，不能用本地设置或仅有 v1 cap 代替；应随当前连接动态读取                |
| `bridge.forcePreview?(rawAlias)`                           | AF3 的 v2 预览方法；其余 get/set/clear/takePreview/take 不变。没有 v2 能力或该方法时 force 本地拒绝，不请求 |
| `autoFromCwd?: boolean`                                    | stack 冻结的本地设置；不写入 hub 配置                                                                       |
| `markDecided?: XsAliasMarkDecided` / `decided?(): boolean` | 上一节的同一决定实例                                                                                        |
| `cache.current().origin?: "auto"`                          | AF3 对账缓存里的来源，仅用于 status 的 `(auto)`；可选扩展，v1 cache 仍可直接赋值                            |
| `autoSkipReason?(): XsAliasAutoSkipReason \| undefined`    | AF3 自动引擎的缓存跳过原因，只读，不触发新的 auto；活的 decided=true 优先于陈旧的缓存原因                   |

- 自动后缀只在 local alias usable、`autoFromCwd===true` 且当前 hub v2 时启用。held 显示 `alias @x held (auto) · lease … · cool …`；none/lost 行保留原主体再追加 ` · auto skip:<token>`。内部 `handoff-pending` 不属于这个显示端口。
- 命令不重新推导 cwd；AF3 负责候选及跳过原因，AFW 转发缓存即可。现有 suggestions 端口仍用于补全，未新增 IO。
- AF0 的 `XsAliasBridgePortV2` / `XsAliasStorePortV2` 签名未修改。命令端口只取 v2 的可选 `forcePreview`，不要求 v1 bridge 实现 auto/handoff，也不要求其它包在本次开发时已合入。

## 与方案的偏差/明确取舍

1. **旧 hub 的 status 不加 `auto skip:hub-cap`。** 方案 §3.4 有此后缀，但本次派单明确要求「无 v2 对端时行为与现状字节一致」，因此优先执行派单：旧 hub 的 status、take/clear 文案和既有补全不变；显式新 `--force` 调用才返回升级提示。测试对整段 status 做严格相等断言，涵盖 none、held-auto、lost。保留 `hub-cap` 为可用的缓存原因令牌，但无 v2 时不展示新后缀。
2. **显式 token 的 via 是提示性来源，不参与权限或执行。** hub token 才拥有 mode；命令闭包记住最近至多 32 个 force 预览 token，使同实例的 web/RPC 执行能写 `via:"force"`。reload 后或来源缓存被挤出时写 `via:"take"`；两者都永久 decided，执行仍由 hub 按 token 中真实 mode 校验。没有额外 wire 字段或跨 activation 全局缓存。
3. `cwd` 没有新增到命令端口：status 转发 AF3 的派生结果，避免命令与 auto 引擎重复计算。AFW 可用适配层连接其最终 API。
4. README 未修改，因为 §10 将其冻结给 AF6；实现与接口细节集中在本报告。
5. 当前工具集没有 Agent/verifier 委派入口，故**未进行独立模型验收**；本报告只声明实际运行的本地门禁，不把自验冒充独立验收。AFW/终局仍需验收真实 v2 装配；本分支基线只含 AF0，不能声称已完成在线 force 推送、auto 引擎或真实 v2 hub 端到端验收。

## 自验

所有命令均在 `/tmp/alias-af4` 执行。共享 `node_modules` 是只读符号链接：使用 `--no-install`，未安装依赖；Vitest 加 `--no-cache` 防止向链接目标写 `.vite/vitest` 缓存。

| 命令                                                                                                                                                                                                                                  | 结果                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `npm run typecheck`                                                                                                                                                                                                                   | 通过（TS7 两项 + vue-tsc）                                                           |
| `npm run build`                                                                                                                                                                                                                       | 通过                                                                                 |
| `npx --no-install vitest run tests/commands/fabric-xs-alias.test.ts tests/fabric/xs-alias-decided.test.ts --maxWorkers=2 --no-cache`                                                                                                  | 2 文件、76 测试通过                                                                  |
| `npx --no-install vitest run tests/fabric tests/web-hub/hub tests/web-hub/agent tests/web-hub/protocol tests/commands --maxWorkers=2 --no-cache`                                                                                      | 420 文件、10036 通过、3 既有 skip；末次日志 `af4-broad-test.log`（忽略文件，不提交） |
| `npx --no-install vitest run tests/integration/fabric-xs-off-golden.test.ts tests/integration/fabric-xs-alias.test.ts tests/integration/fabric-xs-alias-wiring.test.ts tests/conformance/fabric-xs.test.ts --maxWorkers=2 --no-cache` | 4 文件、34 通过；C-X6 内委派的 fabric-wake 8 项也通过                                |
| `npm run format:check`                                                                                                                                                                                                                | 通过（报告落盘后再执行）                                                             |
| `git diff --check`                                                                                                                                                                                                                    | 通过                                                                                 |
| `git diff --quiet 9ce5abc7 -- tests/fixtures/`                                                                                                                                                                                        | 通过；所有 fixtures 字节未改                                                         |

首次新增测试使用了本项目 Vitest 2 不支持的 `toHaveBeenCalledExactlyOnceWith`，导致两个 matcher 失败；已改为次数及参数的独立真实断言，随后定向与完整指定门禁通过。没有放宽产品断言或更改 fixtures。

没有 push；没有发布；没有改动 AF1/AF2/AF3/AFU/AFW/AF6/AF7 的实现文件。
