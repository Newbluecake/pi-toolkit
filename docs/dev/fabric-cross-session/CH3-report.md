# CH3 report — 成员关系 / 接收端 / 渲染 / 命令

> 规格：`channel-plan.md` §2.2–§2.4、§4.4/§4.5、§5.3、§6.3、§8、§9.1 CH3、§10 CH3 行。依赖 CH0（92ccc0ec）。未 commit。

## 改动文件

| 文件                                                                             | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/home/bluecake/ai/pi-toolkit/src/fabric/xs/membership.ts`                       | `joinedState` → `channelPref`；`XsMembership implements XsChannelView`（`pref/effective/link/linkJoined` + `suspended()` + `channelsEnabled`）；`joined ⇔ effective ≠ ∅`；`join(channels?)` 增量 / `leave(channels?)`（无参 = 清空含挂起频道）；整条拒绝 `channels_disabled / invalid / reserved / too_many`，集合不变 ⇒ `already_joined / not_joined` 不 bump；§2.4 写出与读回规则；新 dep `channelsEnabled?`（默认 true，Q6）                                                                                           |
| `/home/bluecake/ai/pi-toolkit/src/fabric/xs/receiver.ts`                         | stage 3 将 `membership.joined` 换成 `channelScopeOk`：`chs = bc ? [bc.channel] : (via ?? [default])` 必须与 `membership.link(hubCap)` 有交集（与 block/allowFrom 同一关口，位于 3b classify / stage 6 reserve 之前）；`XsDeliverInput.via?/bc?`；新 dep `hubChannelCap?`；`bc` 写入 deliver-only `details.bc`、format 元数据，并传入 Controller 请求                                                                                                                                                                      |
| `/home/bluecake/ai/pi-toolkit/src/fabric/root-wake.ts`                           | `RootWakeRequest.bc?` 与 `RootWakeMessage.details.bc?`（类型为 `XsBroadcastMark`）；dispatch 时把它写进 details；没有 bc 时 details 的键序列不变                                                                                                                                                                                                                                                                                                                                                                          |
| `/home/bluecake/ai/pi-toolkit/src/fabric/xs/format.ts`                           | `XsMessageMeta.bc?`；首行 `]` 前追加 `channel="#x" kind="broadcast"`，并在第二行加宿主说明 `XS_BROADCAST_NOTE`；没有 bc 时输出逐字节不变（三份 golden 通过）                                                                                                                                                                                                                                                                                                                                                              |
| `/home/bluecake/ai/pi-toolkit/src/fabric/xs/render.ts`                           | `XsDisplayKind` 增加 `"broadcast"`，`XsDisplayView.channel?`；优先取 `details.bc`（按频道名正则校验），否则读首行标记；头部渲染为 `xs ← <from> · <cwd> · #team broadcast`；回复不会被识别为广播                                                                                                                                                                                                                                                                                                                           |
| `/home/bluecake/ai/pi-toolkit/src/commands/fabric-xs.ts`                         | `join #a #b` / `leave #a` 的回显（结果集合、挂起集合、`#default` 与命名频道并存时的隔离提示）；拒绝文案（`channels.enabled=false` 时为「频道功能未启用（…）」）；新增 `channels` 子命令（本地 pref/effective/suspended，以及 hub 频道名和人数）；status 新增 `channels … (n/4) · hub-cap on\|off\|n/a · suspended …`、旧 hub 链路说明、autoJoin 全部非法提示和 `broadcast ≤…/h · wake ≤…/h ≤… rcpt · usage n/a`；补全只读缓存；新增可选 deps `channels / hubChannelCap / directoryChannels / broadcast / autoJoinInvalid` |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/command-policy.ts`               | `FABRIC_KNOWN_SUBS` 加入 `channels`（基线 allow，受 `fabric` 整名 override 约束）                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `/home/bluecake/ai/pi-toolkit/tests/fabric/xs-channel-ch3.test.ts`（新）         | 25 例，覆盖 §9.1 CH3 的全部要点（见下）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `/home/bluecake/ai/pi-toolkit/tests/fabric/root-wake.test.ts`                    | Controller 转发 `bc` 的用例，并断言无 bc 时 details 的键序列不变                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `/home/bluecake/ai/pi-toolkit/tests/commands/fabric-xs.test.ts`                  | 子命令补全总数从 9 改为 10（新增 `channels`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/command-policy-fabric.test.ts` | `channels` 为 allow 且受 override 约束；`join #a` / `leave #default` 为 allow；`channelsx` 为 deny                                                                                                                                                                                                                                                                                                                                                                                                                        |

## 新测试覆盖（§9.1 CH3）

- **entry 三种形状**：pref 为 ∅ 时写 `joined:false`；`[default]` 时与 golden 形状逐字节相同（键序也一致）；命名频道时写 `joined: pref∋default` 加 `channels`。
- **读回**：合法数组以它为准，规范化后截断到 4 个；垃圾数组回落到 `joined ⇒ [default]`；fork 不继承。
- **挂起与恢复**：保存 `[a]` → 关闭频道 → reload ⇒ 未加入、entry 不改写 → 开启 → reload ⇒ `[a]`。关闭时 `[default,a]` 只生效 default；命名频道的 join/leave 被拒；无参 join/leave 照常可用。
- **增量 join**：从未加入时 `join #a` 只进 `#a`（Q3）；已在 default 时得到 `[default,a]`；`leave #default` 是隔离方式；集合有变化才 bump epoch；非法名、保留名、超过 4 个都整条拒绝且什么都不改。
- **stage 3 复核**：
  - default-only 的原真值表不变；
  - `via`/`bc` 判定（bc 优先于 via）；
  - `linkChannels`：cap 关闭或端口未接线 ⇒ 只在命名频道的会话被拒；`[default,team]` 在旧 hub 上仍可经 default 送达；
  - 端口抛异常时视为无 cap；
  - §4.5：stage 3 之前 leave ⇒ rejected；dispatch 之后 leave ⇒ dedup 重放 applied，不回滚。
- **Q4**：没有共享频道时回复被拒，`reserve` 未被调用、凭证仍是 pending、replyInbox 为 0；重新共享频道后重发的回复被接收。
- **广播展示**：format 首行标记与宿主说明，去掉新增部分后与 plain 逐字节相同；render 走 details 与首行两条路径，正文里伪造的标记和非法的 `details.bc` 都不会被识别为广播；receiver 写入 details.bc、Controller 收到 `bc`；replies 模式拒收广播。
- **命令**：回显与隔离提示；拒绝文案；飞书对 `join #a` / `leave #default` 硬拒（`channels` 放行）；`channels` 列表；status 各行；补全不触发 I/O，只在 status/join 之后刷新缓存；端口抛异常不影响命令。

## 自验

```
npx vitest run tests/fabric tests/commands tests/web-hub/agent/command-policy* tests/integration/fabric-xs-off-golden.test.ts tests/integration/fabric-xs-reply-off-golden.test.ts tests/integration/fabric-wake-off-golden.test.ts tests/fabric/xs-channel-ch3.test.ts --maxWorkers=3
 Test Files  55 passed (55)
      Tests  1022 passed (1022)

npm run typecheck   # tsc ×2 + vue-tsc 全部通过（包括他包在途改动）
npx prettier --check <上表 11 个文件>   # All matched files use Prettier code style!
```

补充回归：

- 引用这几个模块的其余测试（slash-args、topic-fence、tx-xs、conformance/fabric-xs 等）：9 files / 207 passed；
- `tests/integration/fabric-xs* tests/web-hub/agent/xs* tests/mention`：19 files / 180 passed。

三份 off golden 未改动，也未重新生成；`membership.join()` 在 default-only 时仍返回 `{ok:true, epoch}`（golden 断言为 `toEqual`）。

## 设计取舍（需要知会）

1. **stage 3 的 hubCap**：优先使用注入的 `hubChannelCap` 端口；端口缺失、返回 false 或抛错都视为无 cap（失败关闭）。例外：帧里带有 hub 盖章的 `via`/`bc` 时，直接视为该 hub 具备 cap，因为只有带 cap 的 hub 才会写这两个键。这样即使 CHW 漏接端口，命名频道也不会失效，同时不放宽范围：没有 via 时始终按 `[default]` 判定。
2. **`joinedAt`**：只在从「未加入」变为「加入」时（或此前从未记录时）更新；向已加入的集合增量 join 不刷新。default-only 时与原行为一致。
3. **`/fabric status` 首行**的 `joined` 仍是本地 `effective ≠ ∅`；链路上的差异（旧 hub）由 channels 行的 `link … (hub-cap off: …)` 说明。
4. **补全**：join 候选 = (pref ∪ 目录行频道 ∪ 最近一次 channels 结果) − 已加入 − 本行已输入；leave 候选 = pref。`#default` 的离开项附「离开后不再与默认频道会话互通」。

## 遗留 / 交给 CHW（`stack.ts` / `index.ts` 不在本包文件域）

- `new XsMembership({... channelsEnabled: config.channels.enabled })`。
- autoJoin 改为 `membership.join(config.channels.autoJoin)`（`autoJoinInvalid` ⇒ 不调用）。注意：`channels.enabled=false` 时，如果 autoJoin 含命名频道，join 会整条返回 `channels_disabled`。建议 CHW 在关闭时只传 `autoJoin ∩ {default}`。
- 给 `XsReceiver` 传 `hubChannelCap: () => port.hubChannelCap?.() === true`。
- `stack.ts` 中直接读 `membership.joined` 的地方（NoticeGate `joined`、`reply.receivable`、directory `view()`、`member()`/`status()`），按 §2.3 应改为 `linkJoined(hubCap)` 或 `effective()`。`member()` 需要写出 `channels: channelsFieldToWrite(...)`（CH2/CHW）。
- `createFabricXsCommand` 新 deps 的接线：
  - `channels` → `sender.channels()`，把 `status:"ok"` 映射为 `{ok:true, channels}`，其余映射为 `{ok:false, reason}`；
  - `hubChannelCap`；
  - `directoryChannels` → 目录行的 `channels` 并集；
  - `broadcast` → `config.channels.broadcast`；
  - `autoJoinInvalid`。
- IBW 之后在同一文件加 unread status 行：本包已在 `channelStatusLines` 之后、`view.lines` 之前留出位置，直接追加即可。
- 范围外观察：`src/commands/status.ts:659`（`/agent status`）仍显示 `joined/left`，频道信息不在本包范围。
