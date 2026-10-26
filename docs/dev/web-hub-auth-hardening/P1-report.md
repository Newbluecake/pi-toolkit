# #66 P1 实施报告 — 读侧、池、补偿（HARDENING_PHASE=1）

方案：`docs/dev/web-hub-auth-hardening/plan.md` r3 §4.0/§4.1/§5/§9 P1。零 git 写操作；未碰 `tests/fixtures/`、P4 文件域（`protocol/password-policy*`、`common-passwords*`、`hub/admin.ts`、`agent/passwd-prompt.ts`）及其它包。

## 改动文件（均在 /home/bluecake/ai/pi-toolkit）

src

- `src/web-hub/hub/hardening.ts`（新，零 import）：`HARDENING_PHASE=1`、`READER_MARKER_KEY/VERSION`、`WRITER_SOAK_MS`、`writerActive`、`parseReaderMarker`、`nextReaderMarker`。
- `src/web-hub/hub/kdf.ts`：`KdfShape`/`KDF_LEGACY`/`KDF_PHASE2`、`effectiveWriteTarget`、`kdfCost`、`newKdfParams`（`defaultKdfParams` 保留为别名）、`dummyParams`、`padParamsFor`、`computeVerifyTarget`、`needsRehash`；`validateKdfParams` 放宽到 N∈[2^14,2^17]、128·N·r≤128 MiB；池改按物理完成释放；新增 `runPadded`；`createKdf` 可注入 `scrypt`（测试用）。
- `src/web-hub/hub/lan-auth.ts`：`LanLoginDeps.kdfPolicy?`；`kdfMatches` 以 `verifyTarget` 作 dummy，较便宜的有效记录走一次 `runPadded`（无 runPadded 时退回两次 `run`）；删除模块内 `DUMMY_PARAMS`。
- `src/web-hub/hub/hub.ts`：`countInFlight` 同时包装 `kdf.run` 与 `kdf.runPadded`；privacy `verifyPassword` 传入 `lanDeps.kdfPolicy`。
- `src/web-hub/hub/db-child.ts`（维护段）：`buildMaintScript({hardeningPhase?, now?})`；`open-check-migrate` 在已有事务内写/升级读侧标记，唯一判定 `writerActive`，reply 新增 `hardening{readerSince,writerActive,maxKdf}`；repair/checkpoint 不带该字段。初始密码仍 2^15 `scryptSync`。
- `src/web-hub/hub/lan-store.ts`：`maintHardening` 测试缝；`CreateLanStoreResult.hardening`（`LanHardening`：readerSince/writerActive/verifyTarget/totpKey/totpMigrated/truncateFailed）；`runMaint` 不再丢弃 `warning`（log.warn + `truncateFailed`）。
- `src/web-hub/hub/lan-assembly.ts`：把 `result.hardening.verifyTarget` 作为 `kdfPolicy` 交给 `LanFrontendDeps`。
- `src/web-hub/hub/http.ts`：把 `lan.kdfPolicy` 传给 `createLanLoginCore`。
- `src/web-hub/hub/ports.ts`（P1 文件域表未列，但契约要求）：`KdfPort.runPadded?`、`KdfPolicy`、`LanFrontendDeps.kdfPolicy?`、`LanLoginCoreDeps.kdfPolicy?`（全部可选）。

tests / docs

- `tests/web-hub/hub/hardening.test.ts`（新）、`kdf.test.ts`、`lan-auth.test.ts`、`db-child.test.ts`、`lan-store.test.ts`、`hub-lan.test.ts`（kdfInflight 用例放这里，`supersede.test.ts` 只是控制器单测，无需改）、`lan-login.test.ts`（注入 policy，因其 fixture 为 N=2^14 r=1）、`tests/web-hub/http/lan-helpers.ts`（`TEST_KDF_POLICY`）、`tests/web-hub/contract/fakes.ts`（`fakeKdf.runPadded`）。
- `docs/dev/web-hub/README.md`：LAN security 段补 #66 P1 读侧说明。
- 本报告。

## 与方案逐条对照

| 方案项                                                                                                      | 结果                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| §4.0 `hardening.ts` 常量与 `writerActive`（since 未来⇒假）                                                  | ✓ `hardening.test.ts` 真值表 + db-child 测试里让**维护脚本**与 TS `writerActive` 在 2 phase×7 since×3 v+缺失 的网格上逐一比对                     |
| 读侧标记：缺失写入、更低版本只升 v 保留 since、不移动 since                                                 | ✓ db-child.test（含乱码标记重盖章）                                                                                                               |
| 唯一判定点：维护子进程判定，reply `hardening.writerActive`；查询子进程不判                                  | ✓ 查询脚本不含 `WRITER_SOAK`/`hardening_reader`（断言）。`childEnv`/`PI_WEBHUB_TOTP_WRITE` 属 P6，未做                                            |
| §4.1 读侧放宽 N≤2^17、128·N·r≤128 MiB、p≤2                                                                  | ✓ 接受 2^17；拒绝 2^18、N=2^17 r=16、p=3                                                                                                          |
| 池按物理完成释放；abort 立即 reject、槽位物理回调才还；I1                                                   | ✓ 受控 scrypt 用例 + 真实 scrypt abort 洪泛（物理并发 ≤2，排空后池可用）；排队中 abort / scrypt 报错 / 同步抛错均释放                             |
| `runPadded`：一次 acquire、两次物理计算完成才返回真实结果、abort 只释放一次                                 | ✓ 含 abort 于首轮（跳过补偿）/补偿轮（槽位持有到物理回调）/首轮报错                                                                               |
| `countInFlight` 同时包装 run 与 runPadded（含同步抛错减计数）                                               | ✓ `hub-lan.test.ts` 经真实 `startHub` + 超版本 agent hello 验证：挂起期间不发 `superseded`，完成后发；**变异验证**：去掉 runPadded 包装该用例失败 |
| `verifyTarget=max(写目标, maxStored)`；未知/损坏只跑一次 dummy                                              | ✓ `computeVerifyTarget` 忽略越界损坏行；lan-store 用 maint reply 的 `maxKdf`                                                                      |
| 补偿：有效且更便宜记录一次 `runPadded`，p≤64（实测 ≤8）                                                     | ✓ `padParamsFor` 全参数网格测试：总功 ≥ 目标且超出 < 一个 p 步长                                                                                  |
| 计时防枚举（spy 不量墙钟）：未知、对/错、2^15、2^14、N=2^16 p=2、r=1、损坏，acquire 均 1 次，Σcost ≥ target | ✓ `lan-auth.test.ts`（8 类×对/错）                                                                                                                |
| 生产记录不变：不注入 policy 时 2^15 记录与未知用户都是一次 v0.10 参数的 `run`；2^14 种子多一次补偿          | ✓ 两条断言                                                                                                                                        |
| privacy verify 与登录同 policy                                                                              | ✓ `verifyPassword` 测试 + hub.ts 传 policy                                                                                                        |
| 维护 reply 的 `warning` 不再被 lan-store 丢弃                                                               | ✓ log.warn + `truncateFailed`（见遗留）                                                                                                           |
| 不改 schema / wire / fixtures / 新 env；timer 全 unref                                                      | ✓（本包未新增定时器）                                                                                                                             |

## 自验

- `npm run typecheck`：通过（TS7 ×2 + vue-tsc）。
- `npx vitest run tests/web-hub --maxWorkers=4`：`Test Files 700 passed (700) · Tests 15587 passed | 3 skipped (15590)`。
- `npx vitest run tests/integration/web-hub-lan.test.ts tests/integration/web-hub-control.test.ts`：2 files / 28 tests passed。
- `npx prettier --check`（本包全部改动文件）：通过。
- `git diff --quiet HEAD -- tests/fixtures/`：干净。

## 遗留 / 说明

1. `ports.ts` 不在方案 §8 的 P1 文件域表里，但 §5 契约把 `runPadded?` 放在 `ports.ts`，故做了最小可选成员改动（P2 同样要动该文件，串行无冲突）。
2. `truncateFailed` 的“真触发”路径（open-check 的 TRUNCATE 抛错）未做自动化用例：`wal_checkpoint(TRUNCATE)` 忙时返回 busy 而非抛错，难以在不 mock 子进程的情况下稳定复现；解析/透传代码已就位，P5/P6 做 TRUNCATE 告警时再补。
3. `hardening.totpKey/totpMigrated` 为 P6 预留占位（恒 `"none"`/0）。
4. 工作区里 P4 / 其它包的未提交改动（admin.ts、passwd-prompt.ts、src/tools 等）不属于本包，提交时请按精确路径 add。
5. A2（补偿后墙钟 10–30% 残差）与 A1（2^17 RSS）属真机验收，未做。

## 建议 commit message

```
feat(web-hub): lan kdf read-side hardening — accept scrypt 2^17, physical-completion pool, padded timing

- hub/hardening.ts: phase gate (HARDENING_PHASE=1), reader marker meta.hardening_reader,
  writerActive decided once by the maintenance open check and returned in reply.hardening
- kdf: validateKdfParams accepts N≤2^17 / 128 MiB; pool slots are released when scrypt
  physically completes (aborted callers still reject at once); runPadded runs real+compensation
  in one slot; target/dummy/pad helpers
- lan-auth: every verification costs cost(verifyTarget) (dummy for unknown/corrupt, one padded
  run for cheaper records); verifyTarget = max(write target, strongest stored record)
- hub: kdfInflight now counts runPadded as well as run; lan-store keeps the open check's warning
- writes are unchanged this release (2^15)
```
