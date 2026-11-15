# WebHub terminal · 集成验收清单

此清单是执行契约，不是永久 PASS 标签。每次验收须绑定 Git HEAD、Node/Python/shell/browser/xterm 版本、生产 UI manifest/hash、命令 exit、原始日志与截图。开发包自验、异源验收、Chromium contract-fake 与真实跨层须分别记录。

## 环境安全（开始前必查）

- [ ] 仅授权 worktree；初始 HEAD/status、node_modules symlink target 已记录；不 install、不写共享依赖/cache。
- [ ] owned0700 短 HOME/XDG_CACHE_HOME/TMPDIR；unset XDG_RUNTIME_DIR/NODE_OPTIONS/PI_CODING_AGENT_DIR；umask0022；私有 PWH_UI_CACHE_DIR。
- [ ] 离线 Playwright1.63.0 + revision1243 Chromium 确实存在；`npm_config_offline=true` 禁止 loader 在线回退；浏览器只允许该 probe 自建 loopback origin。
- [ ] 真 shell 通过 internal isolated UID/rc fixture：启动前 realpath/owner/0700/system-rc 审核；不执行用户真实 rc、不读 ~/.pi/凭据、不接运行中 hub。
- [ ] 所有命令外部 timeout、Vitest --no-cache；日常真实PTY建议1–2 workers，#45 指定完整验收门为 workers4；创建进程有 bounded cleanup。

## 自动化证据矩阵

| 门                         | 必须验证的事实                                                                                                                                                               | 执行入口/证据                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| F1 / mixed / T-OLD-HUB     | 专用帧/伪造/未知/late 在 registry/bus/两 listener ring 零进入；普通旧帧字节 parity；旧 hub 诱导零敏感 mint/read/send                                                         | tier2 `web-hub-terminal-ingress.test.ts`、`web-hub-terminal-old-hub.test.ts`；保存测试原文与 fixture零差 |
| F2 Q1–Q4                   | 当前身份/世代、完整 count/digest/覆盖、ONLY B 缺席 lost 无 TTL 放行、真物理 proof+durable CAS/prune/ACK 后只释放一次                                                         | tier2 `web-hub-terminal-{quarantine,journal,local,wiring}.test.ts`                                       |
| authority / receipt / cold | 生产 guarded 文件与独立 OS verifier，不能注入恒真 authority/proof；正常末次 close 后三次冷启；resolved-before-prune / pruned-before-ACK 真 fsync crash window；伪 ACK 无删除 | wiring/local；journal、receipt与真实 PID/组事实断言，不只 close ACK                                      |
| PTY / shell / isolation    | isatty、winsize、真实 bash/zsh rc顺序/env deny、前后台不同pgid/收养waitpid/EOF/Ctrl+C/父死/late spawn                                                                        | tier2 `web-hub-terminal-pty.test.ts`；不是 secure mount skip                                             |
| auth / privacy / HTTP      | loopback/LAN origin/CSRF、原 SSE object/expiry、revoke先 fence、marked/unknown/degraded 拒绝，真实 cleanup                                                                   | tier2 `web-hub-terminal-http.test.ts` + wiring；LAN password和loopback各自保留证据                       |
| UI async authority         | 每个 await 的旧成功/错误/finally 不能提交后继权限/metadata；renderer/paste/focus/键盘/offDOM                                                                                 | tier1 `tests/web-hub/ui/terminal-*.test.ts`                                                              |
| I9/I10/I3/I8/D8            | off零副作用/原字节、无 hello/PROTO bump、原 activate trace、pi-free boundary、两 loader secure/locked强关                                                                    | directed tier1 + off-golden/tier2 + fixtures baseline diff                                               |
| build / CSP / license      | 生产 build+check、真实图 E=M\A、首屏 CSS零增、独立预算、notices与schema --check                                                                                              | typecheck/build/build:web/check:web/notices；保存数值/hash与notice计数                                   |
| Chromium七案例             | 6正例0违规/0DOM fallback；negative恰1违规+1console error；一次恢复/第二次拒启                                                                                                | `probe:csp -- --suite terminal --browser chromium`；正式组件，明确 contract-fake HTTP                    |
| 真后端 UI                  | 下面逐项；不能用 contract-fake替代                                                                                                                                           | `probe:terminal-e2e` 的 JSON、操作计数、8张截图                                                          |

## #45 per-session · T1–T15（必须逐格记录，不以单包 PASS 代替）

O 锁定完整 `4e15fac15ee42293eac7c19943655537bd21b7c2`。baseline helper 从本地 git objects archive
到 owned scratch，只读复用依赖，无 patch/安装/版本号伪装；保存 tar、源树、package/lock、SDK/Node/工具版本、
adapter 及自建 UI manifest/artifact hash。old backend 真 open/PID/pwd/reap 是后续混版格的前置。
旧 hub 的默认 gzip 浏览器必须记录 **KNOWN_OLD_DEFECT_NOT_DOWNGRADE_PASS**：
/api/login200、/api/events200 后 ERR_CONTENT_DECODING_FAILED、零新 UI fork；获批 identity 编码只作其余旧行为补充。
N hub 的真实 UI 必须保持 gzip（不是换 identity 消红），所有正例 CSP/page error 独立为零。

| ID  | 必须保留的行为断言 / 执行入口                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1  | 不合格 launcher 的真实 wireWebHub→spawnHub→main，launch config 无 terminal；机器 on 急切 ready；后来合格独立 agent authority/HTTP/PTy open 无需 restart。`per-session.test.ts`                                                                         |
| T2  | plain/denied/unknown/坏枚举分别启动；denied/unknown unavailable，后来目标不能解禁；secure/locked→denied 的冻结 domain/launcher 映射另跑原 agent 单测，不把非法字符串 secure/locked 当真实 secure mount。                                               |
| T3  | 三组分开：①无 legacy + 合法机器 off + agent off，完整 raw hello/ack/session/status/HTTP/SSE 与 helper 内新增 locked-old frozen golden；②legacy 键冲突不解禁，属于行为变化；③坏 JSON/不可读/坏 enabled block/unknown 来源 unavailable，不归一化为 off。 |
| T4  | 两个独立 Node agent + 独立 hub，process.cwd 第三目录；真 PTY PID/pwd-P 等于各自 canonical ctx.cwd，真实 close 后 PID gone、journal至少两次 durable revision/prune/receipt ACK。                                                                        |
| T5  | 同会话 ctx.cwd 更新，新 shell 用新 cwd、旧 PID/cwd 不迁移；同进程 new/resume/fork session_start 后新 open 取新 context。原生 rc 可 cd，不抑制。                                                                                                        |
| T6  | 抓真实 socket 第一张重连 status，guardfalse/throw、generic SlotFlush 异常、断线期 session 切换；raw stored 无正声明；XS 专用异常/投影另跑既有 `agent/terminal-session.test.ts`。不得只看最终 registry。                                                |
| T7  | 本 boot fresh login 真 open；真实 restart 后 oldcookie SSE401/无 binding、old open拒绝且零新 backend；真实重新登录后可开。不 synthetic loginComplete。                                                                                                 |
| T8  | privacyfalse+terminalon 实际 HTTP/history fork，fake-pi 子进程入口见新 id mark；坏 store/真实 mark 写失败零 fork；public privacy routes404。精确 supervisor.start 之前 mark 顺序及 missing/degraded/throw 窗口另跑 P-H privacy-fork 单测。             |
| T9  | 同实际 SSE A→零→B，双 cap 不变、hello/private binding 各一次；B不重新登录，旧 A ticket 拒绝、不碰 B输出。浏览器 listener once 另保留 P-U transport/component门。                                                                                       |
| T10 | 独立 agents 冲突 global 声明1/32不改变机器 ceiling；两个真实 login principal 共享 maxTotal、不共享 principal quota，session ceiling 跨 principal；全部真实终端 final durable drain，不加 retry/额外 prepare 假修复。                                   |
| T11 | 撤回/真 socket断开/独立新process epoch拒旧票据，零新fork；原真实authority tamper/proc/receipt全文件保留；queued negotiation continuation 专用反证另保留 P-H 门。                                                                                       |
| T12 | compat.test.ts 每格独立选择完整 hub/agent/UI root、真实 manifest 校验、具体DOM/零prepare/open、HTTP fixed unsupported、old-gzip缺陷与identity补充分别记录。                                                                                            |
| T13 | N真实 drain/ACK→同 scratch O冷读相同journal/witness→真实新login/open/reap；真实producer SIGKILL无receipt的dirty状态与独立poison状态不重开、不删/重建证明。                                                                                             |
| T14 | 非root不存在/非目录/chmod不可 traverse，真实 production backend constructor fixed E_BAD_REQUEST、零新managed/helper；测试只复用已审计uid/rc，不让fixture preflight遮住生产cwd预检。                                                                    |
| T15 | 原8个 terminal integration 全文件148项，身份/OS/proof/revision≥before+2/ACK断言不缩水；withdraw的共享SSE合同按r2调整，不误要求A撤回关闭B的boot binding。                                                                                               |

true-off raw comparison 的确定化仅枚举 agent nonce/PID/epoch、ctx.cwd、fixture argv、agentKey、SSE clientId、
hub PID/port/启动时间与 models.sampledAt。**没有删除 features/caps/status、排序对象或归一化 unavailable**。
旧 UI 自建使用 commit 的 SOURCE_DATE_EPOCH + 显式 NODE_ENV=production；两个 off 后端均以 archive install
启动，均正常没有 git bootHead，选同一个真实验证过的旧 UI root以隔离构建身份，而不是剥除 bootHead/伪造 assets。
另外真实 N/O UI off DOM/零 API 按自身构建单独验。golden 在新 helper 内，既有 tests/fixtures 不改。

### #45 门禁与编码证据

- `npm run typecheck`；`PI_TOOLKIT_TEST_WORKERS=4 npm run test:tier1 -- --no-cache`（完整结束，失败必须列原始日志/独立复跑，不改范围外代码）。
- `vitest run --no-cache --project tier2` **显式列出全部** `tests/integration/web-hub-terminal-*.test.ts`；integration 不移 secure借 skip。
- `tests/governance/test-tiers.test.ts`，`npm run build:web && npm run check:web`，改动路径 Prettier/diff检查；
  `git diff --quiet 4e15fac1 -- tests/fixtures/`。
- e2e probe 已扩展双独立 agent/current cwd；只从明确 `TPS_PLAYWRIGHT_MODULE`/`TPS_CHROMIUM` 加载已有离线资产，
  不走 npx/安装 fallback。只允许私有 loopback origin；真实 token/SID只内存，证据仅非秘密序号。
- deliberate privacy/logout 会同步 abort 原 gzip socket；Chromium可能报 `/api/events` 的
  `ERR_INCOMPLETE_CHUNKED_ENCODING`，仅在明确撤权窗口、精确URL/错误字串分开记录 expectedRevocationErrors。
  **ERR_CONTENT_DECODING_FAILED 从不在 N-hub 允许列表**；正常连接出现任一传输错误不能用此规则吞掉。
- 两个 O 既有缺陷都须单列：私帧绕gzip encoder（已修）、多agent inventory end publication碰全局busy丢drain（已修）。
  FIFO修复不得扩原deadline/重试/提前unlock/放松receipt或双CAS；直接queue abort/error/继承测试仍是独立门。

## 真后端 Chromium 路径

- [ ] 真实 hub HTTP + 真实独立 Node agent连接（fake-pi仅SDK宿主）+ Linux Python PTY/helper；端口0/private Unix socket。
- [ ] 真实 manifest-verified 构建 UI → token login → terminal按钮 → body底部列表 →新建。
- [ ] 键盘输入 `echo` 得到真实输出；`printf`/`echo $$` 获取数值 PID，避免把终端输入回显误判为执行结果。
- [ ] 最大化后 TTY 原生 Esc 不关闭、不退出最大化、不 close shell；截图。
- [ ] 真实 WEBGL_lose_context →重建renderer→attach原termId；再次输出同PID；prepare/open/close计数不增。
- [ ] 点击「放到后台」，等待 action 真完成/面板消失，再真实 reload →列表→接回；输出同PID，open总数仍1；对 SID（不是整个 cookie 对象属性）和同一 Page/Context 做断言。context-wide auth trace 只记录 SID 序号，不记录值/hash。
- [ ] 验证 ResizeObserver 在 replay/cutover 前零 resize；cutover 后恰一次 latest dimensions，修复前该回归必须红。启动 capability 失败显示安全手动重试提示，不自动重开未知 shell。
- [ ] 点击终止先见确认框，确认前无 close；确认后原PID消失、journal零资源、receipt exact ACK删除。
- [ ] 释放后可再开；循环次数超过默认 quota2，不能手工 fence.begin/reset 代替回收。
- [ ] privacy lock、真实 logout/revoke后≤2s面板失效（记录实测毫秒），旧writer不能输入；shell真实清理。
- [ ] 主路径CSP违规0/无未处理页面异常；保存console error与有界warnings（64条×2048字符+droppedWarnings），不混入negative。
- [ ] W/i/m在实际fontFamily下advance差<0.5px；真实GPU cell符合floor(advance×DPR)/DPR；A−/A+、loss与真实刷新后字体链/字号保持；中文宽glyph回退保留。比例fontFamily实际构建mutation必须exit1，不能用构建语法失败冒充红。
- [ ] 字体就绪等待≤500ms且包含在renderer3s内；超时仍开、迟到ready/loadingdone重测，dispose撤订阅；无字体资产/CSP放宽/负letterSpacing。
- [ ] 独立 `--disable-webgl` Chromium中文「终端未启动」，0 xterm/prepare/open；CSP违规0。
- [ ] 截图实际打开阅读，非空白/错误页；报告写出证据绝对路径与最终退出码。

## 时序回归

- [ ] separate-process durable-resolution用例连续10次全绿；所选用例其它44个 `-t` skip 不计执行覆盖。
- [ ] 仍要求 journal revision≥before+2、rows=0、receipt目录空、真实PID gone、私有SSE无id。
- [ ] 有界等待与生产 reaper60s一致，测试总界300s；失败输出 stage/journal/receipt物理事实/agent/reaper PID状态；不放宽断言、不把exit当release。
- [ ] 完整terminal tier2在maxWorkers2下连跑10轮；另两个owned CPU忙循环负载下3轮。原始输出保留，包括初败根因和修复后轮次，不用单跑绿代替此门。
- [ ] stdout压力的2s控制应答与原5s物理核验/≤60s reaper分开；cold receipt等原reaper+control上限的真正durable ACK，不抬产品deadline/不放宽reaped断言。
- [ ] 真实setpgid屏障验证同PID前后组/role历史都在最终proof，forkpty暂态helper组不发布为shell；H覆盖/receipt/OS guards不得为消红而放宽。

## 必须单列的 NOT RUN / 限界

- **Firefox NOT RUN**：已接受 GTK3/NSS环境限制，不安装系统库，不以Chromium外推。
- OS级中文IME、手机实机/移动键盘、真实系统剪贴板/完整拖放、preview/hold-stop/767px drawer全键盘共存：需专门设备/交互证据；纯组件或部分键盘测试不冒充全套。
- 8路持续真PTY + 慢renderer联合RSS/流控/公平压测：单PTY+限额单元/HTTP peer不等同此门。
- 真实用户登录rc、真实运行中的hub、真实用户reload：**故意不触碰**；隔离fixture证明实现路径而非用户机器配置。
- 全量 npm test、全tier2/secure挂载、发布/推送：仅在独立授权且遵守正式secure预检后执行；没有跑必须注明，外部-only skip写 mount coverage NOT RUN。

证据包建议：`environment.json`、`commands.tsv`、`e2e-report.json`、`report-r3.json`、PNG、各门原始log、explicit-files清单、fixtures/diff-check输出、git log/status。不得保存 token/grant/lease/nonce/正文hash或真实用户秘密；本probe的受控echo/PID样本可以保存。
