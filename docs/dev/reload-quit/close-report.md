# #24 结案报告：RC3 非缺陷确认 + README 区分表 + 日志轮转保留 3 份

> 任务：L1 快车道（2026-11-05 用户拍板）。依据 `docs/dev/reload-quit/explore.md`（#24 调研结论）。
> 范围冻结遵守：未触碰 `tests/fixtures/**`、wire/协议、`src/quota/**`、`docs/dev/secure-symlink/**`；无 git 写操作。

## 改动清单

| 文件                                   | 改动                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/web-hub/hub/log.ts`               | 轮转从保留 1 份改为保留 3 份：`rm(.3)` → `rename(.2→.3)` → `rename(.1→.2)` → `rename(hub.log→.1)`，每步独立 fail-soft（外层 try/catch 保留，绝不抛进 hub）。不改日志格式、不改 `DEFAULT_LOG_MAX_BYTES`/触发阈值、无 timer（本模块无计时器）。                                                                                                                                              |
| `tests/web-hub/hub/idle.test.ts`       | 原「rotates to .1」测试改为「keeps exactly three rotated backups」；新增「keeps at most hub.log.1/.2/.3 in order across multiple rotations」（临时目录，14 次写入后断言 `.4` 不存在、`.3/.2/.1` 依次持有 m10/m11/m12、live 持有 m13）。                                                                                                                                                    |
| `docs/dev/web-hub/README.md`           | 新增「Agent 下线原因区分表（#24 结案）」小节（quit / handover / detach-timeout / 无 bye stale→reap 四行，含 `pid-dead`/`reaped` 两个实际 reason 值，逐行代码出处），及「hub.log 轮转与保留」小节（3 份备份）。文首声明 RC3 已在 #24 确认为非缺陷。日志示例明确标注为字段级匹配指引（结构化 JSON，`"msg":"agent reclaimed",...,"epochChanged":true` 中间隔着 `agentKey`，勿 grep 连写串）。 |
| `docs/dev/reload-quit/close-report.md` | 本文件。                                                                                                                                                                                                                                                                                                                                                                                   |

## 关键事实核对（与 explore.md 的 [F] 结论对齐）

- `down()` 的 reason 原样来自 `bye` 帧：`registry.ts:266-283`；实际落盘形状 `{"msg":"agent down","agentKey":…,"reason":"quit"}`。
- 无 bye 路径有两个 reason 值：`down(r, "pid-dead")`（pid 已死，立即）与 `down(r, "reaped")`（stale 超 `reapMs`），均在 `registry.ts:713-718` —— README 表按实际值写，未凭空造 `reason:"reaped"之外` 的值。
- 实现过程中发现并修正一处自引入 bug：初版移位链漏了 `.1→.2` 的 rename，导致只有 `.1` 存在（tsx 调试脚本复现）；补上后 `.1/.2/.3` 链条正确（同脚本验证）。

## 自验（真实命令与输出，全文存 /tmp/l1-*.log）

1. `npx vitest run tests/web-hub/hub/idle.test.ts` →
   `Test Files 1 passed (1)` / `Tests 9 passed (9)` / `EXIT:0`（/tmp/l1-idle.log）
2. `npx vitest run tests/web-hub/hub tests/web-hub/boundary.test.ts` →
   `Test Files 240 passed (241)` / `Tests 5560 passed (5561)`，唯一失败 `tests/web-hub/hub/startup-cancel.test.ts`（real bound socket，与本包 diff 无交集）。单独重跑：`Test Files 1 passed (1)` / `Tests 7 passed (7)` / `EXIT:0` ⇒ 判定 flake（/tmp/l1-hub.log、/tmp/l1-flake.log）。
3. `npm run typecheck` → `EXIT:0`（/tmp/l1-typecheck.log）
4. `npx prettier --check src/web-hub/hub/log.ts tests/web-hub/hub/idle.test.ts docs/dev/web-hub/README.md` → 初查 README 有格式告警，`prettier --write` 后复检 `All matched files use Prettier code style!`
5. `git diff --quiet HEAD -- tests/fixtures/` → 通过（FIXTURES CLEAN）。

## 遗留 / 范围外

- startup-cancel 的 flake 已按流程单独重跑转绿，未改动任何代码；若 CI 再红按 Tier1 规则另查。
- explore.md §5.2 的跨 key successor 收敛、reload 结果回传（§5.3 可选项）未做（需用户另行拍板，见 explore.md §6.2/§6.4）。
