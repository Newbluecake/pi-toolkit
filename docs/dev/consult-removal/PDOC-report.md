# PDOC 实施报告

基线：`dev@b8f9a43e`；隔离 worktree：`/tmp/pi-subagent-worktrees/r_AW44FH5B`。实施口径为 r3 §1.5、§4.2 PDOC、§4.5 与附录 A，L1 写包；独立 verifier 由 root 调度。

- 中英文 README 同步删除功能表、默认设置、schedule 参数及流量说明中的旧入口；用户指南删除 Agent / workflow 专家参数、默认启用段落与相关设计链接。
- 删除 17 份专属实验脚本（含 Q6 的全部 `exp6-*`）、3 份专属测试、6 份专属 fixture、2 份 skill 参考；活动 skill 保留结构化交接及通过 `message_agent` 问父 agent 的做法。
- 删除 Web / TUI 的演示咨询 run；同步删除 TUI 对第四个快照的索引写入。仅修改 topic-judge-eval README 的历史先例句。
- 新建档案说明 `docs/dev/consult/REMOVED.md`，workflow 历史方案仅加头注。Q11 历史材料保留；AGENTS.md、开发者 README、src、截图图片及其余 fixtures 均未修改。

## 遗留与裁定

1. 活动链接原命令唯一命中 `scripts/dev/agents-split.mjs:115`。该文件不在 PDOC 域，内容是 P1 下沉脚本的历史块表；用户已明确同意保持不动，列为「已知域外残留（P1 切片脚本的块表，属历史）」，由 PS2 接收。原始命令输出保留，未通过过滤隐瞒。
2. 基线 `tests/exp` 只有本次要求删除的三份测试，删除后目录为空。指定命令真实返回 exit 1（No test files found）；显式空目录检查 `--passWithNoTests` 返回 exit 0，但代表 0 个测试，不宣称有剩余实验测试通过。未增加占位测试。类型检查、构建、格式及实际演示行为检查通过。
3. 本报告由后续独立文档提交纳入。尾部 git log 在报告提交前采集，包含实施提交；报告自身提交的 hash 由最终交付输出提供，避免在提交中自引用其 hash。

## 改动文件清单（绝对路径）

- `M` `/tmp/pi-subagent-worktrees/r_AW44FH5B/README.en.md`
- `M` `/tmp/pi-subagent-worktrees/r_AW44FH5B/README.md`
- `A` `/tmp/pi-subagent-worktrees/r_AW44FH5B/docs/dev/consult/REMOVED.md`
- `M` `/tmp/pi-subagent-worktrees/r_AW44FH5B/docs/dev/workflow-experts/plan.md`
- `M` `/tmp/pi-subagent-worktrees/r_AW44FH5B/docs/guide/quota-load.md`
- `M` `/tmp/pi-subagent-worktrees/r_AW44FH5B/docs/guide/subagents.md`
- `M` `/tmp/pi-subagent-worktrees/r_AW44FH5B/scripts/dev/readme-shots/README.md`
- `M` `/tmp/pi-subagent-worktrees/r_AW44FH5B/scripts/dev/readme-shots/make-fixture.mjs`
- `M` `/tmp/pi-subagent-worktrees/r_AW44FH5B/scripts/dev/readme-shots/tui/demo-ext.ts`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/scripts/exp/consult-ab-analyze.mjs`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/scripts/exp/consult-ab-arm.mjs`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/scripts/exp/consult-ab-lib.mjs`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/scripts/exp/consult-anchor-probe.mjs`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/scripts/exp/consult-cache-analyze.mjs`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/scripts/exp/consult-cache-lib.mjs`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/scripts/exp/consult-fork-probe.ts`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/scripts/exp/exp6-analyze.ts`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/scripts/exp/exp6-calib-check.ts`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/scripts/exp/exp6-dump.ts`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/scripts/exp/exp6-judge.ts`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/scripts/exp/exp6-lib.ts`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/scripts/exp/exp6-part-a.ts`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/scripts/exp/exp6-part-b-all.sh`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/scripts/exp/exp6-part-b-run.ts`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/scripts/exp/exp6-select-ecode.ts`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/scripts/exp/exp6-snapshot-verify.ts`
- `M` `/tmp/pi-subagent-worktrees/r_AW44FH5B/scripts/exp/topic-judge-eval/README.md`
- `M` `/tmp/pi-subagent-worktrees/r_AW44FH5B/skills/agent-handoff/SKILL.md`
- `M` `/tmp/pi-subagent-worktrees/r_AW44FH5B/skills/dev-flow/SKILL.md`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/skills/dev-flow/references/consult-ab.md`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/skills/dev-flow/references/consult.md`
- `M` `/tmp/pi-subagent-worktrees/r_AW44FH5B/skills/dev-flow/references/subagent-workflow.md`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/tests/exp/consult-ab-analyze.test.ts`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/tests/exp/consult-ab-arm.test.ts`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/tests/exp/consult-cache-analyze.test.ts`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/tests/fixtures/consult-ab/2026-09-20-old.jsonl`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/tests/fixtures/consult-ab/2026-10-01-main.jsonl`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/tests/fixtures/consult-ab/2026-10-03-more.jsonl`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/tests/fixtures/consult-cache/cache-result.jsonl`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/tests/fixtures/consult-cache/probes.jsonl`
- `D` `/tmp/pi-subagent-worktrees/r_AW44FH5B/tests/fixtures/consult-cache/retro.jsonl`
- `A` `/tmp/pi-subagent-worktrees/r_AW44FH5B/docs/dev/consult-removal/PDOC-report.md`

## 自验取证（尾部）

### §4.5 PDOC 三条扫描命令

```sh
rg -n -i "consult|\bexperts\b" README.md README.en.md docs/guide skills scripts/dev/readme-shots
```

```text
(no output)
exit 1 — rg 无命中，符合活动文档零残留。
```

```sh
rg -n -i "consult|\bexperts\b" README.md README.en.md docs/guide skills scripts/dev/readme-shots | rg -v "移除|removed|#40"
```

```text
(no output)
exit 1 — 无不满足标记要求的命中行；原始扫描为零行。
```

```sh
rg -n "scripts/exp/(consult|exp6)|references/consult(-ab)?\.md|consult-preserve|docs/dev/consult/README\.md" README.md README.en.md docs/guide skills scripts
```

```text
scripts/dev/agents-split.mjs:115:  { id: "D17", kind: "d", marker: "- `src/consult/` —", file: "docs/dev/consult/README.md", title: "src/consult/" },
exit 0 — 唯一已批准的域外历史残留；PDOC 域无残留。
```

历史文档精确允许列表（按方案不纳入活动扫描，不扩大范围）：`docs/dev/consult/**`（README.md 归 PS2）、`docs/dev/consult-removal/**`、`docs/dev/workflow-experts/**`、`docs/dev/fabric-v2/**`、`docs/dev/source-governance/{analysis,plan-lowrisk}.md`、`docs/research/**`、`CHANGELOG.md`、`docs/dev/**/{*plan*,*-report*,acceptance*,probe-results*,eval-*}.md`。这不是把所有 docs/dev 文档都豁免。

### 相对链接解析

执行下列脚本（本次存为 `/tmp/pdoc-links.mjs`，`node /tmp/pdoc-links.mjs`）；解析 README*、docs/guide、skills 中 Markdown 的相对文件路径，忽略 URL 与纯锚点，去掉 fragment/query 后验证文件存在。

```js
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const files = execFileSync("rg", ["--files", "-g", "README*", "-g", "docs/guide/**", "-g", "skills/**"], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter((f) => f.endsWith(".md"));
let checked = 0;
const missing = [];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  for (const match of text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const raw = match[1].replace(/^<|>$/g, "");
    if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(raw)) continue;
    const target = decodeURIComponent(raw.split(/[?#]/)[0]);
    if (!target) continue;
    checked++;
    if (!fs.existsSync(path.resolve(path.dirname(file), target))) {
      missing.push(`${file}:${text.slice(0, match.index).split("\n").length}: ${raw}`);
    }
  }
}
console.log(`Relative links: ${checked} checked in ${files.length} Markdown files; ${missing.length} missing`);
for (const item of missing) console.log(item);
process.exitCode = missing.length ? 1 : 0;
```

```text
Relative links: 163 checked in 47 Markdown files; 0 missing
exit 0
```

### 定向实验测试

```sh
npx vitest run tests/exp
```

```text
RUN  v2.1.9 /tmp/pi-subagent-worktrees/r_AW44FH5B
filter: tests/exp
No test files found, exiting with code 1
exit 1
```

```sh
git ls-tree -r --name-only b8f9a43e tests/exp
npx vitest run tests/exp --passWithNoTests
```

```text
tests/exp/consult-ab-analyze.test.ts
tests/exp/consult-ab-arm.test.ts
tests/exp/consult-cache-analyze.test.ts

RUN  v2.1.9 /tmp/pi-subagent-worktrees/r_AW44FH5B
filter: tests/exp
No test files found, exiting with code 0
exit 0 (0 tests)
```

### 类型、构建、格式与演示行为

环境：Node `v22.22.1`；依赖按授权临时链接至 `/home/bluecake/ai/pi-toolkit/node_modules`，结束前删除链接，不加入提交。

```sh
npm run typecheck
npm run build
npm run format:check
```

```text
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
exit 0
> tsc -p tsconfig.build.json
exit 0
> prettier --check .
Checking formatting...
All matched files use Prettier code style!
exit 0
```

改动文件定向格式检查（删除文件不传给 Prettier；包含本报告）：

```sh
node --input-type=module <<'JS'
import { execFileSync } from "node:child_process";
const paths = execFileSync("git", ["diff", "--name-only", "--diff-filter=AM", "b8f9a43e"], { encoding: "utf8" })
  .trim().split("\n").filter(Boolean);
if (!paths.includes("docs/dev/consult-removal/PDOC-report.md")) paths.push("docs/dev/consult-removal/PDOC-report.md");
execFileSync("npx", ["prettier", "--check", ...paths], { stdio: "inherit" });
JS
```

```text
Checking formatting...
All matched files use Prettier code style!
exit 0
```

实际演示行为检查：生成 fixture 到 `/tmp/pdoc-readme-shots`，对中英文输出断言 fleet 恰有 7 个 run，ID 为 `r-root,r-dev,r-ver,r-exp,r-wf,r-lint,r-ver0`，保留 workflow/verifier 且无被移除的类型、ID 或缓存标记。使用 `npx tsx /tmp/pdoc-tui-smoke.mts` 加载真实 `tui/demo-ext.ts`，提供 `session_start` UI 接口，断言实际 widget 渲染含三项当前任务且无被删行；未新增仓库测试。

```sh
README_SHOTS_DIR=/tmp/pdoc-readme-shots node scripts/dev/readme-shots/make-fixture.mjs
npx tsx /tmp/pdoc-tui-smoke.mts
```

```text
demo-zh: 7 fleet rows, workflow/verifier present, removed demo absent
demo-en: 7 fleet rows, workflow/verifier present, removed demo absent
TUI demo: order-tests/verify-checkout/docs-sweep rendered, removed row absent
exit 0
```

### fixture 范围、提交记录与清洁状态

```sh
git diff --stat b8f9a43e -- tests/fixtures
```

```text
 tests/fixtures/consult-ab/2026-09-20-old.jsonl  |  6 ----
 tests/fixtures/consult-ab/2026-10-01-main.jsonl | 41 -------------------------
 tests/fixtures/consult-ab/2026-10-03-more.jsonl |  3 --
 tests/fixtures/consult-cache/cache-result.jsonl | 11 -------
 tests/fixtures/consult-cache/probes.jsonl       |  5 ---
 tests/fixtures/consult-cache/retro.jsonl        |  9 ------
 6 files changed, 75 deletions(-)
```

仅 `consult-{ab,cache}/` 六个文件删除，其余 fixtures 字节未动。

```sh
git log --oneline b8f9a43e..HEAD
```

```text
a738bd3d docs: remove consult guides and experiment assets
```

上述为报告提交前的实施提交输出。报告提交后最终交付会再次运行该命令，并移除临时 `node_modules` 链接，确认 `git status --short` 无输出。
