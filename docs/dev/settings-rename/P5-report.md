# #54 P5：文案与文档（设置文件 pi-toolkit.json）

依据 `plan.md` r3（含拍板①②③④与文末 r2/r3 修订）实施 §6.2 的 P5 行 + §6.5 全部。**零 git 写操作**；`tests/fixtures/` 未动（`git diff --quiet HEAD -- tests/fixtures/` 通过）；未打印任何真实设置文件内容；并行包 #69 的文件（`src/secure/bin/convert.mjs`、`tests/secure/launcher-private-cmd.test.ts`）未触碰（其工作已由对方以 `edf7c88b` 提交）。

## 交付内容

**用户可见运行时文案（§6.5 列出的 src 文件，锁名 / Symbol 键未动）**

- `src/commands/webhub.ts`：`/webhub feishu status` 的设置告警行指向 `~/.pi/agent/pi-toolkit.json`。
- `src/web-hub/ui/src/i18n/{zh,en}/spawn.ts`：网页新建会话的 how-to-enable 提示指向 `~/.pi/agent/pi-toolkit.json`。
- `src/config/setting-specs.ts:1170`（注释）：`feishuBot.debounceMs` 的手工编辑位置改为 `pi-toolkit.json`（注明旧名）。
- `src/secure/config.ts:9`（文件头契约注释）：设置文件名改为 `pi-toolkit.json`，注明旧名是 read fallback / 兼容链接。
- `src/config/settings.ts:3642`（注释）：`readSettingsNoMigrate` 文档里的旧默认路径改为 `~/.pi/agent/pi-toolkit.json`（P2 重写注释时的漏网，仅注释）。
- `src/traffic/state.ts`：P3 已同步为新规则，本次确认无需再改。

**P2 遗留：`/agent settings list` 文本头补来源后缀**

- `src/commands/status.ts` `renderSettings`：文本头 `Extension settings — <path>:` 在 `store.pathNote` 存在时追加 ` (<pathNote>)`，与 TUI 编辑器标题（`src/ui/settings-editor.ts`）同一信息、同一措辞；默认 scope 输出逐字节不变。
- `tests/commands/status.test.ts`：新增用例——带 `pathNote: "inherited from ~/.pi/agent"` 时头行含后缀；不带时头行无后缀。

**README（中 / 英）**

- 配置节首行：主名 `<agentDir>/pi-toolkit.json`（默认 `~/.pi/agent`，跟随 `PI_CODING_AGENT_DIR`）；新增一条说明：旧名自动迁移、保留为兼容链接、两份分叉时以新名为准并给出可见告警、「请编辑 pi-toolkit.json」、无 flock 主机不迁移继续用旧名。
- 新增 `## PI_CODING_AGENT_DIR 与本插件` / `## PI_CODING_AGENT_DIR and this plugin`：§5.7 跟随/固定清单表、inherited 规则（不自动复制的理由）、相对变量值被忽略、traffic.db 手动迁移步骤（`/record off` → 退出 → `mv records/`）、hub 级单一 agentDir（`/webhub status` mismatch 提示与 restart 切换）、pi-secure 与 pi 须同一套环境变量、agentDir-in-vault 属不支持配置。
- 新增 `## 降级与回滚` / `## Downgrade and rollback`（§7）：`mv pi-toolkit.json pi-subagent.json` 回旧布局、S6b 手工合并（secure 段不一致时 fail-closed）、旧 pi-secure 启动器的 `ln -sf` 修复与临时 `mv` 补救（同版发布提醒）、traffic 无数据操作。
- 飞书机器人设置节、`secure:invalid` 故障行（补「新旧两份 secure 段不一致」情形）、traffic 节三处（intro、库路径句——原文「不随 PI_CODING_AGENT_DIR」已过时、迁移步骤 4）全部改为新名/新规则。
- pi-secure 前提与安装节：新增「链接必须指向当前插件检出、同版发布」提示。

**AGENTS.md**

- "What this is" 段：设置文件已迁到 `~/.pi/agent/pi-toolkit.json`（#54，跟随 `PI_CODING_AGENT_DIR` 带 home 回退）；旧名仅为 read fallback / 兼容链接；锁名固定 `.pi-subagent.json.lock`；`Do NOT "finish the rename"` 句保留（K7）。
- I7 按 §6.5 精确改写：设置文件名已迁，其余 `Symbol.for("pi-subagent:*")`、`subagent:*` customTypes/事件、widget/status 键、`[pi-subagent]` 日志前缀仍不得改；`pi-subagent.json` 子串保留（K7 不改）。
- peer bump 清单第 2 条加入 `tests/conformance/agent-dir.test.ts`（公开导出 + 行为探针，#54 新增）。

**子系统 README**

- `docs/dev/data-encryption/README.md`：新增「设置文件协议（#54）」一节——锁名固定及理由、launcher 镜像解析 + 新名优先 + 无文件默认旧名 + status 后缀、S6b secure 段不一致 fail-closed、agentDir-in-vault fail-closed（78）、`/secure status` 旧启动器探测与同版发布要求。
- `docs/dev/feishu-bot/README.md`、`docs/dev/external-agent/README.md`：启用步骤的设置文件改为 `pi-toolkit.json`（注旧名与 agentDir 跟随）。
- `docs/guide/tools.md`：开关所在文件改为 `~/.pi/agent/pi-toolkit.json`（注旧名兼容链接与跟随）。
- `docs/dev/web-hub/README.md`（§3.7 规则）与 `docs/dev/traffic-merge/README.md`（1b 修订标注）已分别由 P4 / P3 完成，本次未动。
- `docs/dev/settings-rename/README.md`：方案 §6.5 未要求新建子系统 README，不建。

**批量替换范围**：仅以上文件；`tests/fixtures/`、`docs/dev/**` 历史文档（plan 规定不改）、锁文件名、`Symbol` 键均未动。

## 剩余 `pi-subagent.json` 引用（grep 清单，均为有意保留）

| 位置                                                                                                                                            | 理由                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `README.md`/`README.en.md` 配置节迁移说明、降级与回滚节（各 3 处）                                                                              | 迁移/回滚说明必须提及旧名                                                                                                   |
| `docs/guide/tools.md:3`                                                                                                                         | 同上（注明旧名是兼容链接）                                                                                                  |
| `AGENTS.md:31-32, 63`                                                                                                                           | "What this is" 与 I7 的改名约定本身；K7 钉住子串                                                                            |
| `src/config/settings.ts:3459/3490/3515/3516`                                                                                                    | 迁移协议的注释与 S6b 冲突告警文案（指引用户处理旧名文件）                                                                   |
| `src/config/setting-specs.ts:1170`                                                                                                              | 注释中注明旧名                                                                                                              |
| `src/secure/bin/helper.mjs:441/447/562/681`、`src/secure/settings-lock.ts:3/12/53/55/338`、`src/secure/domain.ts:109`、`src/secure/config.ts:9` | 协议常量（`LEGACY_SETTINGS_FILE_NAME`、固定锁名 `.pi-subagent.json.lock`、`.lnk` 残留清理正则）与协议注释——I7/§5.5 规定不动 |

## 自验

| 命令                                                                         | 结果                                                |
| ---------------------------------------------------------------------------- | --------------------------------------------------- |
| `npm run typecheck`                                                          | PASS（tsconfig ×2 + vue-tsc）                       |
| `npm run build:web >/dev/null && npm run check:web`                          | PASS（dist/web-hub-ui OK，各尺寸门未变）            |
| `npx vitest run tests/commands tests/config tests/web-hub/ui --maxWorkers=4` | PASS：330 文件 / 6850 通过                          |
| `npx vitest run tests/docs`                                                  | PASS：10/10（K7 含 `pi-subagent.json` 子串断言）    |
| `npm run format:check`                                                       | PASS（改前曾对 #69 的未跟踪文件报警；其提交后全绿） |
| `git diff --quiet HEAD -- tests/fixtures/`                                   | PASS                                                |
| `grep -rn "pi-subagent.json" README* docs/guide AGENTS.md src` 逐条复核      | 剩余引用全部有意保留，见上表                        |

另：`tests/integration/settings-rename-activate.test.ts:105,120` 断言的 `Extension settings — <NEW>` 头行在默认 scope 下无后缀，文本头改动与之兼容（已在上述套件中间接覆盖默认路径；inherited 后缀由新增单测覆盖）。

## 遗留问题

- 端到端真机验收（§6.6 六场景）不在 P5 范围，仍待调度方安排。
- README 新节的锚点未在模块总览表登记（与既有风格一致，无链接指向它们）。

## 改动文件（绝对路径）

- `/home/bluecake/ai/pi-toolkit/src/commands/webhub.ts`
- `/home/bluecake/ai/pi-toolkit/src/commands/status.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/i18n/zh/spawn.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/i18n/en/spawn.ts`
- `/home/bluecake/ai/pi-toolkit/src/config/setting-specs.ts`
- `/home/bluecake/ai/pi-toolkit/src/config/settings.ts`（仅注释）
- `/home/bluecake/ai/pi-toolkit/src/secure/config.ts`（仅文件头注释）
- `/home/bluecake/ai/pi-toolkit/tests/commands/status.test.ts`
- `/home/bluecake/ai/pi-toolkit/README.md`
- `/home/bluecake/ai/pi-toolkit/README.en.md`
- `/home/bluecake/ai/pi-toolkit/AGENTS.md`
- `/home/bluecake/ai/pi-toolkit/docs/guide/tools.md`
- `/home/bluecake/ai/pi-toolkit/docs/dev/data-encryption/README.md`
- `/home/bluecake/ai/pi-toolkit/docs/dev/feishu-bot/README.md`
- `/home/bluecake/ai/pi-toolkit/docs/dev/external-agent/README.md`
- `/home/bluecake/ai/pi-toolkit/docs/dev/settings-rename/P5-report.md`（本报告）

建议 commit message（仅建议，未提交）：

```text
docs(config): rename user-facing settings references to pi-toolkit.json (#54 P5)

Point all user-visible copy (webhub feishu warning, web UI spawn hints, README
zh/en, tools guide, subsystem READMEs) at pi-toolkit.json and document the new
rules: legacy pi-subagent.json is migrated with a compat symlink kept (no-flock
hosts stay on the old name), settings and traffic.db follow PI_CODING_AGENT_DIR
with a home fallback, hub has a single agentDir, and pi-secure must run from the
same checkout/environment as the plugin. AGENTS.md I7 is reworded (lock name
.pi-subagent.json.lock and the other runtime identifiers stay) and the peer-bump
checklist gains tests/conformance/agent-dir.test.ts. Also closes the P2 leftover:
`/agent settings list` text header now carries the same source suffix as the TUI
editor title. tests/fixtures/ untouched.
```
