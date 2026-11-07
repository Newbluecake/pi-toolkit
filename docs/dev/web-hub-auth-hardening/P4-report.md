# #66 P4 · 弱口令实施报告

日期：2026-10-26。车道：L2，复用已确认的 r3 方案及 D5；没有 git 写操作，没有修改 P1 文件域或 `tests/fixtures/`。

建议 commit message（仅建议，未提交）：

```text
feat(web-hub): reject weak LAN passwords with a shared password policy
```

## 改动文件（绝对路径）

- `/home/bluecake/ai/pi-toolkit/src/web-hub/protocol/password-policy.ts`（新）：共享匹配策略、v1、惰性查询缓存。
- `/home/bluecake/ai/pi-toolkit/src/web-hub/protocol/common-passwords.ts`（新）：有出处、固定版本与 MIT 许可的纯数据。
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/admin.ts`：权威校验、256 码元上限、拒绝审计。
- `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/passwd-prompt.ts`：发送任何 `lan_req` 前执行同一策略。
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/protocol/password-policy.test.ts`（新）：31 项策略、数据及边界测试。
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/admin.test.ts`：KDF/write 零调用、长度上限、原串传入 KDF、审计脱敏。
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/passwd-prompt.test.ts`：本地拒绝不发请求、原串发送、未知错误码透传。
- `/home/bluecake/ai/pi-toolkit/docs/dev/web-hub-auth-hardening/P4-report.md`（本报告）。

## 实施口径

- 原串按 UTF-16 码元计数，范围直接引用 `MIN_LAN_PASSWORD_LENGTH=10` / `MAX_LAN_PASSWORD_LENGTH=256`；长度越界仍为 `E_BAD_REQUEST`。hub 在用户名 lookup 前检查长度，超长输入不会进入 KDF 或写入。
- 仅匹配使用 NFKC + lowercase；传输、KDF 输入和存储均保持原串。
- 拒绝：高频黑名单；基词整串加数字/符号包裹及 leet（每个 `1` 可独立解释为 i/l）；单字符或 1..3 字符单元重复（含截断）；等差码点序列；键盘行连续片段及反向；包含长度至少 3 的归一化用户名或 `webhub`（同时覆盖 `pi-webhub`）。
- **D5 覆盖正文 variety 条款**：不实施独立字符种类数、字符组合或熵门槛。接口保留方案中的 `"variety"` 类型字面量，但没有返回该原因的规则；四字符非规律口令正例证明没有暗加种类数门槛。
- hub 和 TUI 共享 `checkLanPassword`；错误码 `E_WEAK_PASSWORD` 是直接新增的字面量，未改 strict schema、PROTO 或现有错误码。失败 message 固定为 `password rejected: <reason>`，不含输入；审计仅有既有 admin 元数据与 `ok/code/reason`，无用户名或口令；不调用 `kdf.run` / `setPassword`。
- 只在设置密码时检测，不改登录、存量口令或初始账号生成。
- **I8**：策略只相对导入同目录 `lan.js`、`common-passwords.js`，没有新白名单或外部依赖；common-passwords 零 import。正文“两个文件零 import”与实际拆分共享数据要求有冲突，采用已允许的 protocol 内部相对导入，而非复制数据/长度常量。boundary 20 项全部通过。
- **I4**：首次需要黑名单匹配时创建 Set，并封装在不可外部访问的 lookup closure；使用 `Symbol.for("pi-subagent:lan-password-policy:v1")` 共享。容量固定为一个 corpus Set 和一个基词 regex；生命周期为进程，静态版本化数据无需 TTL，不保留用户输入，不引入模块级可变变量、I/O 或定时器。惰性与重复调用复用均有断言。

## 口令表出处与体积

- 来源：SecLists `Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt`。
- 固定 revision：`1a7bb9127eca9e6ff2fc0301c597fe6e16a0cb56`；获取日期 2026-10-26。
- 原始文件 SHA-256：`c2e5696882c603b76bb67a47ee970897e5a76fc4c3f5547abe3d0ca340c576e0`；固定 revision 下载再次核验一致。
- 取前 100,000 行（源文件实际 99,840 行），先按原串 UTF-16 长度 ≥10 筛选，再 NFKC、lowercase、去重、排序：**9,126 条**，不是方案估算的 1–2 万条；没有合成条目凑数。
- 数据按每条一行计算为 **106,125 UTF-8 字节**；含来源、完整 MIT 许可和导出语句的 TS 文件实际 **108,077 字节**，测试门禁 `<150,000` 字节。
- 另有 **165 个人工挑选的高频基词**；只做整串匹配，不作为任意子串词典。
- 来源与 MIT 许可全文保存在数据文件头；没有运行时下载、新依赖或 web UI 导入路径。测试固定版本、唯一条数和归一化 corpus 内容 SHA-256。

## 验证命令与结果

| 命令                                                                                                                                                                                    | 最终结果                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `npm run typecheck`                                                                                                                                                                     | 通过：两次 TS 7 strict 检查及 vue-tsc，exit 0                                       |
| `npm run build`                                                                                                                                                                         | 通过，exit 0                                                                        |
| `npx vitest run tests/web-hub --maxWorkers=4`                                                                                                                                           | 最终复验通过：700 文件，15,579 passed / 3 skipped（15,582 total），203.92 s，exit 0 |
| `npx vitest run tests/web-hub/protocol/password-policy.test.ts tests/web-hub/hub/admin.test.ts tests/web-hub/agent/passwd-prompt.test.ts tests/web-hub/boundary.test.ts --maxWorkers=4` | 4 文件、119 项通过，exit 0                                                          |
| `npx prettier --write <上述七个源码/测试精确路径>`                                                                                                                                      | 完成；未格式化其它文件或 fixtures                                                   |
| `npx prettier --check <上述八个交付文件精确路径>`                                                                                                                                       | 通过，exit 0（本报告写入后执行）                                                    |
| `git diff --quiet HEAD -- tests/fixtures/`                                                                                                                                              | 通过，exit 0                                                                        |
| `npm run format:check`                                                                                                                                                                  | 全仓门禁失败，仅剩范围外 `docs/dev/scheduled-reports/confirm-plan.md`；未越界修改   |

首次全量 web-hub 验证曾有 4 个并行 P1 相关失败：旧 KDF 参数上界断言 3 项、登录补偿 KDF 次数 1 项。未修改这些文件；P1 更新后再次运行全量，以上失败全部消失。最终结果来自共享工作区当时的真实运行，不将其它并行包的改动算入 P4。

## 遗留与边界

- P4 定向测试、typecheck、build、全量 web-hub 测试及 fixtures 门禁均通过。
- 全仓格式门禁仍受范围外 scheduled-reports 文档阻塞，P4 精确文件格式门禁通过。
- 未执行独立模型 verifier：当前工具集没有 Agent/verifier 调度工具；本报告只声明实际自验结果，不冒充异源验收。
- README 未修改，遵守本次精确文件域约束；后续文档包可引用本报告同步弱口令与静态缓存说明。
- 无 commit、add、stash、checkout、rebase、push 等 git 写操作；没有修改 fixtures、P1 或其它范围外文件。
