# WebHub terminal · 集成验收清单

此清单是执行契约，不是永久 PASS 标签。每次验收须绑定 Git HEAD、Node/Python/shell/browser/xterm 版本、生产 UI manifest/hash、命令 exit、原始日志与截图。开发包自验、异源验收、Chromium contract-fake 与真实跨层须分别记录。

## 环境安全（开始前必查）

- [ ] 仅授权 worktree；初始 HEAD/status、node_modules symlink target 已记录；不 install、不写共享依赖/cache。
- [ ] owned0700 短 HOME/XDG_CACHE_HOME/TMPDIR；unset XDG_RUNTIME_DIR/NODE_OPTIONS/PI_CODING_AGENT_DIR；umask0022；私有 PWH_UI_CACHE_DIR。
- [ ] 离线 Playwright1.63.0 + revision1243 Chromium 确实存在；`npm_config_offline=true` 禁止 loader 在线回退；浏览器只允许该 probe 自建 loopback origin。
- [ ] 真 shell 通过 internal isolated UID/rc fixture：启动前 realpath/owner/0700/system-rc 审核；不执行用户真实 rc、不读 ~/.pi/凭据、不接运行中 hub。
- [ ] 所有命令外部 timeout、Vitest --no-cache、workers≤2（真实PTY建议1）；创建进程有 bounded cleanup。

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

## 真后端 Chromium 路径

- [ ] 真实 hub HTTP + 真实独立 Node agent连接（fake-pi仅SDK宿主）+ Linux Python PTY/helper；端口0/private Unix socket。
- [ ] 真实 manifest-verified 构建 UI → token login → terminal按钮 → body底部列表 →新建。
- [ ] 键盘输入 `echo` 得到真实输出；`printf`/`echo $$` 获取数值 PID，避免把终端输入回显误判为执行结果。
- [ ] 最大化后 TTY 原生 Esc 不关闭、不退出最大化、不 close shell；截图。
- [ ] 真实 WEBGL_lose_context →重建renderer→attach原termId；再次输出同PID；prepare/open/close计数不增。
- [ ] 点击「放到后台」，等待 action 真完成/面板消失，再真实 reload →列表→接回；输出同PID，open总数仍1。
- [ ] 点击终止先见确认框，确认前无 close；确认后原PID消失、journal零资源、receipt exact ACK删除。
- [ ] 释放后可再开；循环次数超过默认 quota2，不能手工 fence.begin/reset 代替回收。
- [ ] privacy lock、真实 logout/revoke后≤2s面板失效（记录实测毫秒），旧writer不能输入；shell真实清理。
- [ ] 主路径CSP违规0/无未处理页面异常；保存console error/warnings，不混入negative。
- [ ] 独立 `--disable-webgl` Chromium中文「终端未启动」，0 xterm/prepare/open；CSP违规0。
- [ ] 截图实际打开阅读，非空白/错误页；报告写出证据绝对路径与最终退出码。

## 时序回归

- [ ] separate-process durable-resolution用例连续10次全绿；所选用例其它44个 `-t` skip 不计执行覆盖。
- [ ] 仍要求 journal revision≥before+2、rows=0、receipt目录空、真实PID gone、私有SSE无id。
- [ ] 有界等待与生产 reaper60s一致，测试总界300s；失败输出 stage/journal/receipt物理事实/agent/reaper PID状态；不放宽断言、不把exit当release。
- [ ] 完整 terminal tier2全跑一次（不是十次单例代替全套）。

## 必须单列的 NOT RUN / 限界

- **Firefox NOT RUN**：已接受 GTK3/NSS环境限制，不安装系统库，不以Chromium外推。
- OS级中文IME、手机实机/移动键盘、真实系统剪贴板/完整拖放、preview/hold-stop/767px drawer全键盘共存：需专门设备/交互证据；纯组件或部分键盘测试不冒充全套。
- 8路持续真PTY + 慢renderer联合RSS/流控/公平压测：单PTY+限额单元/HTTP peer不等同此门。
- 真实用户登录rc、真实运行中的hub、真实用户reload：**故意不触碰**；隔离fixture证明实现路径而非用户机器配置。
- 全量 npm test、全tier2/secure挂载、发布/推送：仅在独立授权且遵守正式secure预检后执行；没有跑必须注明，外部-only skip写 mount coverage NOT RUN。

证据包建议：`environment.json`、`commands.tsv`、`e2e-report.json`、`report-r3.json`、PNG、各门原始log、explicit-files清单、fixtures/diff-check输出、git log/status。不得保存 token/grant/lease/nonce/正文hash或真实用户秘密；本probe的受控echo/PID样本可以保存。
