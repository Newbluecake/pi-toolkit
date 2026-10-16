# P1 delivery report (dev:web-resume-p1)

# P1 (session-nav) 交付报告 — web-resume plan v2+r2

## 改动文件清单（绝对路径）

**新增（src）**

- `/home/bluecake/ai/pi-toolkit/src/session-nav/session-head.ts` — §2.2 冻结 API：`HeadLimits`/`SessionHead`/`HeadResult`、`readSessionHeadFd`（有界头/尾读取器，285）、`FileFact`（63）、`SESSION_READ_FLAGS` = `O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_NOCTTY`（28）、`openSessionNoFollow`（76）/`openSessionNoFollowAsync`（99）
- `/home/bluecake/ai/pi-toolkit/src/session-nav/provenance.ts` — §2.1 目录级 provenance 索引：冻结 `ProvenanceIndex`（43）+ `advanceProvenance`（:443 起，见导出 44）；cache v2（`provenance-v2/<sha256[0:16]>.json`，0600，tmp+rename，16 MiB 读/写双上限）、`scannedTo` 增量回填、48h lane①（≤半字节预算）+ 持久化 round-robin lane②（8 MiB/chunk/call）、20 000 文件 / 2 048 marks / 512 KiB entry / 16 MiB cache 容量语义
- `/home/bluecake/ai/pi-toolkit/src/session-nav/classify.ts` — 冻结 API：`isSubagentSession`（20，§2.1 规则：self-marker OR index）、`displayTitle`（39，name/first/none，skill 信封剥离、C0→空格、≤120 UTF-16、代理对安全）

**重写（src）**

- `/home/bluecake/ai/pi-toolkit/src/session-nav/subagent-sessions.ts`（-173/+24 净减）— v1 marks 缓存与 `markSubagentSessions`（`[sub:type]` retitle）按 D1 删除；新增 `collectSubagentSessions`（36，advanceProvenance + 每候选 ≤16 并发有界头读）+ 保留 `listSessionFiles`（70）
- `/home/bluecake/ai/pi-toolkit/src/session-nav/recent-sessions.ts` — §2.3 五步管线；`SessionListProgress` 升为 3 参（21）；wrappedProgress 先 temp→real 映射再丢 sub 行（78-90）；AbortSignal 全程穿透、finally 清 temp dir
- `/home/bluecake/ai/pi-toolkit/src/session-nav/index.ts` — allLoader/recentLoader 走新管线（112-133），sub 行在 partial 与最终列表都整行丢弃；输入形式/completions/busy/TUI 守卫/exit 拦截不变，**无 `--sub`、无开关、无计数行（D1）**

**测试（tests/session-nav/）**：`helpers.ts`、`session-head.test.ts`(20)、`provenance.test.ts`(19)、`classify.test.ts`(14)、`open-discipline.test.ts`(8)、`source-pins.test.ts`(4)、`recent-sessions.test.ts`(6)、重写 `subagent-sessions.test.ts`(9)；`editor.test.ts`/`skill-titles.test.ts` 未动仍绿。

## Plan §4 P1 需求 → 实现/测试映射

| Plan 要求                                                                             | 实现                                                                                                                                       | 测试                                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| header/marker/name in head+tail、first-user 松散提取、oversized line、too-long header | session-head.ts:285 `readSessionHeadFd`（`\n` 字节切行；id 须匹配 `RESTORE_SESSION_ID_RE`——运行时从 `web-hub/protocol/spawn.js` 单源导入） | session-head.test.ts:43,57,94,108,116,126,137,146,153,162-192      |
| 冷缓存 + 48h 外旧父 + 无 self-marker 的新子 ⇒ 回填后隐藏                              | provenance.ts 全目录索引                                                                                                                   | provenance.test.ts:53                                              |
| 预算耗尽 ⇒ `complete:false` 再收敛；时间预算同理                                      | lane①/② 预算检查                                                                                                                           | provenance.test.ts:84,106                                          |
| 暖缓存零读取预算仍服务（lower bound，无 re-stat）                                     | loadCache∪entries 并集                                                                                                                     | provenance.test.ts:117                                             |
| v1 缓存被忽略                                                                         | 仅新路径读写                                                                                                                               | provenance.test.ts:127                                             |
| append 后从 `scannedTo` 续扫；身份变化/收缩 ⇒ 归零丢 marks                            | scanFileChunk 恢复规则                                                                                                                     | provenance.test.ts:150,165,183                                     |
| 单个 200 MiB 父不饿死其他文件（round-robin、8 MiB chunk）且收敛                       | 每文件每调用 ≤8 MiB + 持久 cursor                                                                                                          | provenance.test.ts:273（小文件标记第 1 次调用即见，≤30 次收敛）    |
| 20 001 文件 ⇒ `capacity:"files"`，self-marked 子仍隐藏                                | 容量表 + 头读保证                                                                                                                          | provenance.test.ts:323                                             |
| mark(2048)/entry(512 KiB)/cache(16 MiB) 上限；超大 cache 视为缺失                     | storeMark/sanitizeEntry/saveCache                                                                                                          | provenance.test.ts:365,379,199,215（写侧逐出至 ≤16 MiB、最旧先逐） |
| renamed child 仍隐藏（身份过滤，retitle 豁免取消）                                    | 身份集合过滤                                                                                                                               | recent-sessions.test.ts:77、subagent-sessions.test.ts:62           |
| partial 进度用真实临时目录路径、sub 行到不了选择器                                    | recent-sessions.ts:78-90                                                                                                                   | recent-sessions.test.ts:43                                         |
| AbortSignal 不留 temp dir                                                             | finally rm                                                                                                                                 | recent-sessions.test.ts:119                                        |
| Open discipline：FIFO/设备/符号链接/fd 基线（2s 硬超时）                              | session-head.ts:28,76,99；provenance 扫描与 cache 读同走该口                                                                               | open-discipline.test.ts:31-104                                     |
| 字面量 pin + 无 `readFile(path)`/`createReadStream(path)` 源扫描                      | 常量 + 源扫描测试                                                                                                                          | source-pins.test.ts:25,31,37,55                                    |

## 偏差（含理由）

1. **`SessionListProgress` 为本地 3 参别名**（recent-sessions.ts:21）：pi 未从包根导出该类型（exports map 只有 `.`/`./rpc-entry`），无法“用 pi 的导出”；形状与 pi 1.2 声明结构一致（F4），已在文件头注明。
2. **冻结 §2.2 API 之外的可加性导出**（冻结形状逐字未动）：`provenanceStatus()`/`ProvenanceIndexWithStatus`（含返回对象上的 `status`/`capacity` 字段）与 `DEFAULT_PROVENANCE_BUDGET` 等常量——§2.4 wire 需要 `"complete"|"partial"|"capacity"`，纯 `complete:boolean` 无法表达；P2 的 `resume-list.ts` 已在 import `provenanceStatus` 并结构化探测 `capacity`，两侧无需改动对方文件即对齐。
3. **松散提取增加了未闭合尾部回退**（`"text":"…` 被窗口截断时取可见前缀）：head.ts 先例的正则只匹配闭合引号，纯复用会让“行大于窗口”用例取不到任何文本；行为仅放宽不收紧。
4. **`complete` 的身份校验用 dev/ino/size**（lstat，mtime 不参与相等判断，mtime 仍被记录/刷新）：mtime-only 变化（touch）不重扫也能收敛；恢复规则本身与 plan 逐字一致（dev/ino + size ≥ scannedTo）。
5. **signal 已中止 ⇒ 跳过 cache 写**：对 §2.4 “old epoch 的迟到完成不写 cache” 取保守读法（代价只是 TUI 中止路径少存一次增量）。
6. **末行无 `\n` 的文件（截断/写一半）保持 pending**：由 “scannedTo = 最后完整 `\n` 之后” 定义内生决定，下一次 append 即收敛。
7. **“当前会话永不隐藏”** 按 §2.1 规则的推论实现（TUI 主会话两信号均不成立）；§2.3 管线未给 loader 传当前文件（pi picker 已单独接收用于高亮），未加额外管道。
8. 旧 v1 缓存文件 `subagent-marks.json` 只是不再读写（§2.1 “simply ignored”），磁盘残留清理不在 P1 范围。

并行包说明：P2 的 `resume-list.ts`/`resume-exec.ts`/`builtin-bridge.ts` 曾在我开发中途处于中间态（typecheck 一度过不了），均在其专属文件内且其后自愈；最终全项目 typecheck 通过，冻结 API 形状未变。

## 自验命令及结果（真实输出）

```
$ timeout 400 npx vitest run tests/session-nav
 Test Files  9 passed (9)
      Tests  95 passed (95)
   Start at  12:42:42    Duration  6.76s
（连续 4 次全绿；含 200 MiB 回填 405ms、20 001 文件容量 4.6s、写逐出 615ms）

$ timeout 300 npm run typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
TYPECHECK EXIT: 0        # 全项目，含并行 P2/P3 当前文件

$ npx prettier --check src/session-nav/*.ts tests/session-nav/*.ts
All matched files use Prettier code style!
```

未运行全量 `npm test`、未 commit、未做全树 git 操作（按指示）。遗留：无（AGENTS.md session-nav 段落更新与 `docs/dev/web-resume/acceptance.md` 属 P4）。
