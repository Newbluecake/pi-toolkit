# #28 P1b report（plan r3 §2 第 9–10 项，文档收口）

前提：P1a 代码修复已提交（`b217a4bf`，报告 `P1a-report.md`）。本包纯文档；未运行任何 secure 测试/挂载/gocryptfs/fusermount 命令；无 git 写操作。

## 改动文件

- `docs/dev/data-encryption/README.md` — 新增两节（插在「设置文件协议」之前；B0 在 D8 清单里新加的 `reflex` 文案未动）：
  - 「挂载拼写契约与威胁模型残留（#28）」：普通 launcher 以挂载前一次性算出的物理 cipher（`realpath(<dir>)/cipher`）与物理挂载点传给 gocryptfs，与 private 模式一致；判定不放宽（plan §1.1/§1.5）。威胁模型残留按 plan §1.3 已定 (ii)：cipher 物理祖先可被可写父目录的属主替换 ⇒ 检测不到（R2），只影响可用性与目录级完整性，机密性由挂载点祖先链规则、cipher 0700 与口令兜住，缺口先于本修复；附用户侧建议（`<dir>` 放在只有本人和 root 可写的链下）。
  - 「旧版本楔死保险库的恢复（人工，无自动化脚本）」：plan §1.7 原文要点——`findmnt -J -o TARGET,FSTYPE,SOURCE --mountpoint <mnt>` 精确查询（禁 grep mountinfo）；5 条人工确认条件（措辞「可能一致，无法据此证明归属」）；`fuser -vm` + `fusermount3 -u` 卸载，`-uz` 不等价已锁定只作最后手段；收尾 `findmnt` 无记录 + `flock -n mount.lease true` 后再 unlock。无自动化脚本、无 status 运行时诊断（用户已拍板延后）。
- `AGENTS.md:185` — 「the 16 real-mount files」→「the 17 real-mount files」。已核对 `tests/tiers.ts` 的 `SECURE_MOUNT_FILES` 实际长度为 17（含 P1a 新登记的 `launcher-symlink.test.ts`）。
- `docs/dev/test-speed/README.md` — 行 9 计数 16→17（注明以 `tests/tiers.ts` 实际长度为准）；「#28 产品侧符号链接 bug」残留段改为「已修」，描述对齐缺陷本质（`<dir>` 词法链含符号链接 ⇒ 词法 cipher 挂载、物理判定 ⇒ foreign 卡死），附 `docs/dev/secure-symlink/plan.md`（r3）链接；注明 D15/D16 测试侧缓解保留、`symlinked-tmpdir` 预检判定现状保留。

## 自验（真实输出）

- `npx vitest run tests/docs/agents-md.test.ts`：Test Files 1 passed · Tests 10 passed。
- `npx prettier --check` 三份文档：All matched files use Prettier code style!
- `wc -c AGENTS.md`：27504（≤32 KiB）。
- `rg -n "16|17" … | rg -i secure`：仅剩 17（AGENTS.md:33 的「17,000+ tests」与本包无关，未动）。

## 说明

- `git status` 中 `src/tools/message-agent-tool.ts`、`tests/fabric/**`、`src/reflex/**`、`docs/dev/fabric-kind-guidance/` 为并行包的工作区改动，本包未触碰；本包 diff 仅三份文档 + 本报告。
- 无遗留问题。
