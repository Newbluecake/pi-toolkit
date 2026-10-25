# merged-plan P1（git 层）报告

基线 `74f6c916`（B40 + 开工记录）；git 2.53.0；strace 可用（E12 未 skip）。文件域：`src/git/graph.ts`、`tests/git/graph.test.ts`（追加）、`tests/integration/git-graph-cherry.test.ts`（新）。未碰 hub / protocol，未做任何 git 写操作。

## 实现（`src/git/graph.ts`）

- `wtGraphArgs.cherry(head, tip, format, drivers)`：冻结 argv =
  `GB + attrSourceArgs(format) + neutralizeArgs(drivers) + -c diff.external= -c core.bigFileThreshold=512m + rev-list --cherry-mark --right-only <H>...<B> --`。
- `wtGraphArgs.driverScan()`：委托 `wtDiffArgs.driverScan()`（逐字节相等，且每次返回新数组）。
- `parseCherryMark(stdout, capped, format)` → `{eq, plus} | {bad:true}`。
- 文件头注释改为四条命令（Gr / Gl / Gm / Cc）；import 仍只有 `./diff.js`（boundary 测试通过）。`WTDIFF_DRIVER_NAME_RE` 与 Cc 正则未改动。

## 方案未规定、我自行取的默认做法（P2 需知）

1. `cherry()` 对非法 `head`/`tip`（非 format 长度的小写 hex）**和**不符合 `WTDIFF_DRIVER_NAME_RE` 的驱动名都抛异常。`neutralizeArgs` 本身是静默跳过的，我选择更严（fail-closed）；P2 须先校验并集再调用。
2. `parseCherryMark(capped=true)` 一律返回 `{bad:true}`（末行被截断、计数不可知）；调用方仍应先判 capped ⇒ `unk:"too-many"`。
3. 多出的空行、CRLF、末尾多个换行、`-`/`<` 前缀都算坏行，整体 `bad`（全或无）。

## 测试

- `tests/git/graph.test.ts` +27：argv 逐字节（sha1/sha256 空树、0/1/16 驱动、tail 项、`<H>...<B> --`）、非法输入抛异常、`driverScan` 相等、`parseCherryMark` 16 种坏流 + capped + sha256、禁用选项白名单。
- `tests/integration/git-graph-cherry.test.ts`（54 个，sha1 与 sha256 各一套判定夹具）：
  - §9 判定夹具：普通 / `-x` ⇒ `=`；解冲突 / amend ⇒ `+`；仅空白 ⇒ `=`；info/attributes `-diff` ⇒ `+`；`rebase -i` squash 与 `merge --squash` ⇒ 两个原提交都 `+`；HEAD 合回候选 ⇒ `+`；分支内 merge ⇒ `+`；未合入 ⇒ `+`；祖先 ⇒ 空输出。
  - E1/E2 配对（对照 marker>0，硬化 marker 不增、exit 128、`missing-object`、`.git` 无写入）与 E3。
  - E4 36 格（6 驱动 × 3 属性来源 × 2 路径；每格先过正对照 marker≥1，再各跑硬化与未硬化，均 marker=0 且 hdr=`+`/full=`=`；末尾断言恰为 36 格）。
  - E5（threshold=1 翻转未硬化、bogus ⇒ 128、diff UI 配置 bogus 不影响）、E11（work tree `-diff` 对照、info 残留、`binary=true` 不消费）、E12 strace（硬化后 0 次 work tree / index 访问；未硬化对照会打开 `.gitattributes`；`skipIf(!hasStrace)`）+ `chmod 000` 兜底、replace 配对、gpg 配对、`.git` 全量写入证明（成功与缺对象）、性能冒烟（2000 提交 + 24×3，24 次 Gm 远小于 14 s）。
- 变异验证：去掉 L1 / `--no-replace-objects` / `--no-lazy-fetch` / threshold，集成测试与单测均变红；去掉 `diff.external=` 只有单测能抓（2.53 下该项不可观测，E4 已说明）。

## 自验

- `npx vitest run tests/git tests/integration/git-graph.test.ts tests/integration/git-graph-cherry.test.ts tests/web-hub/boundary.test.ts` → 8 files, 239 tests passed。
- `npm run typecheck` 通过（无错误；P0 协议文件当前能编译）。
- `npx prettier --check`（三个改动文件）通过；`git diff --quiet adebe2d6 -- tests/fixtures/` ⇒ fixtures-ok。

## 遗留

- 未提交（按约定由主会话按精确路径提交）。工作区里 P0 的 `protocol/{version,worktree-graph}.ts` 与其测试是对方的改动，我未触碰。
