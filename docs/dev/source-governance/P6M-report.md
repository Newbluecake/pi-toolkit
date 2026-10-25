# P6M 报告（四组纯移动，4 个 commit，base 85cf78bb）

| 组  | from → to                                                                                                                                                                     | commit 主题                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| M1  | src/service/cache-keepalive.ts → src/cache-ttl/keepalive-service.ts                                                                                                           | refactor(cache-ttl)            |
| M2  | src/tools/bash-tool.ts → src/bash/tool.ts；bash-job-tool.ts → src/bash/job-tool.ts（+3 个 1:1 测试 → tests/bash/{tool,job-tool,tools-golden}.test.ts）                        | refactor(bash)                 |
| M3  | switch-context-tool → src/context-switch/tool.ts；compact-tool → src/compact-hint/compact-tool.ts；set-compact-threshold-tool → src/compact-hint/threshold-tool.ts（+3 测试） | refactor(context-switch)       |
| M4  | src/web-hub/agent/command-capture.ts → src/commands/capture.ts（+测试 → tests/commands/capture.test.ts）                                                                      | refactor(commands)（含本报告） |

无 re-export 垫片；导出名/函数体未动；tests/fixtures、tests/web-hub/boundary.test.ts 未改；无 consult 代码改动。

## 迁移测试相对导入（逐条改写 + existsSync 检查，全部通过）

- capture.test.ts：`../../../src/web-hub/agent/command-capture.js`→`../../src/commands/capture.js`；`../../../src/web-hub/agent/index.js`→`../../src/web-hub/agent/index.js`；`./helpers.js`→`../web-hub/agent/helpers.js`。
- bash 三个测试、context-switch/tool.test.ts、compact-hint/{compact-tool,threshold-tool}.test.ts：仅被移模块的说明符改变（同层深度，其余不变），与附表一致。
- 检查脚本：对每个迁移测试解析 from/import()/vi.mock/new URL 的相对说明符并 existsSync，M2/M3/M4 全部 ok。
- M1 源码字符串：tests/integration/keepalive-pipeline-service.test.ts:491 已改为 './src/cache-ttl/keepalive-service.ts'，该用例（tsx -e 子进程）通过。
- 偏差：方案列 src/web-hub/agent/index.ts 为 M1 importer，实际不导入该服务，无需改；M3 describe 标题里的旧路径字面量一并改为新路径以满足 rg 0 命中；tool.test.ts 导入因变短被 prettier 折成一行。

## 旧路径 rg（src tests scripts，排除 tests/fixtures）

service/cache-keepalive、tools/bash-(job-)?tool、tools/(switch-context|compact|set-compact-threshold)-tool、agent/command-capture：均 0 命中。

## 自验

- npm run typecheck：每组通过。prettier --check 改动文件：通过。
- (a) 接线：M1 tests/cache-ttl+cache-ttl-removal+child-keepalive 1284 通过；M2 585 通过；M3 382 通过；M4 162 文件/3086 通过。
- (b) 真实加载门禁（末态）：conformance/{rpc-spawn 21,rpc-bash-jobs 3,slash-args 3,history-restore 4}、keepalive-pipeline 10、integration/keepalive-pipeline-service 15、web-hub/boundary 13，共 7 文件 69 测试全部通过，无 skip。
- git diff 85cf78bb -- tests/fixtures | wc -l = 0。
