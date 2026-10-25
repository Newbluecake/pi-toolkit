# TypeScript 7 工具链升级报告

## 方案（微软官方并装模式）

```jsonc
"devDependencies": {
  "typescript":   "npm:@typescript/typescript6@^6.0.2", // 6.x 兼容包：提供 `import "typescript"` 编程 API + tsc6
  "typescript-7": "npm:typescript@^7.0.2"                // Go 原生 tsc
}
```

- 根目录两个 `tsc --noEmit` 与 `npm run build` 走 TS 7：脚本里用显式路径 `node node_modules/typescript-7/bin/tsc`。
- `vue-tsc`（3.3.x 不支持 TS 7）与两个直接 `import "typescript"` 的测试（`tests/boundary/pi-free.test.ts`、`tests/web-hub/hub/hub-startup-gate.test.ts`）通过别名拿到 6.0.x（`require("typescript").version` = 6.0.3）。
- **不能用裸 `tsc`/`npx tsc`**：`@typescript/typescript6` 依赖 `@typescript/old`（真 TS 6），其 bin `tsc` 抢占 `node_modules/.bin/tsc`（实测 `npx tsc -v` = 6.0.3），而 `typescript-7` 的 `tsc` 被覆盖。所以脚本一律写显式路径；`tsc6` 也可用。
- 为什么不选「`typescript`=7 + 兼容包」：TS 7 没有稳定编程 API，`typescript` 这个名字必须给 vue-tsc/测试提供 API；TS 7 放别名最少惊讶。
- 没有改 CI（`npm ci` 即得两套）、pi 运行时（jiti，不用 tsc）、git/npm 安装（TS 只在 devDependencies，`--omit=dev` 不装）。临时目录真实 `npm ci --ignore-scripts` 验证过：锁文件一致，TS7=7.0.2、tsc6=6.0.3。
- 唯一源码改动：`src/sysload/sampler.ts` `statMount` 里 `statfs` 变量补类型注解 `NonNullable<SamplerIo["statfs"]>`（TS 7 报 TS2322），运行时不变。
- tsconfig 无需改动（无被移除/改名的选项）。

## 实测（本机，冷缓存无差别）

| 项                       | TS 5.9.3 | TS 7.0.2 + vue-tsc(6.0)        |
| ------------------------ | -------- | ------------------------------ |
| `npm run typecheck`      | 52.1 s   | 17.3 s（剩余基本全是 vue-tsc） |
| `npm run build`          | 23.3 s   | 3.1 s                          |
| 单个 `tsc --noEmit` 配置 | ~19–21 s | ~3 s                           |

产物对比：用 5.9.3 重新编译到干净目录对比 `dist/`：**全部 `.js` 逐字节相同**；仅 14 个 `.d.ts` 有差异，均为 typebox 联合字面量/字段的输出顺序（语义等价）。`node -e "import('./dist/index.js')"` 载入 OK。

## 风险与回滚

- 风险：TS 7 declaration 输出顺序与 5.x 不同（`.d.ts` 噪声 diff，无语义变化）；TS 7.0 对 TS 6 弃用项直接移除，将来新增 tsconfig 选项需先在 7 下验证；`@typescript/typescript6` 当前最新 6.0.2/6.0.3 来自 `@typescript/old`，需跟随 vue-tsc 支持 TS 7 后再合并回单一 `typescript@7`。
- 缺陷信号：`npx tsc` 与 `typescript-7` 版本不同是已知现象，不是故障。
- 回滚：`package.json` 恢复 `"typescript": "^5.6.0"`、删 `typescript-7`，scripts 里的 `node node_modules/typescript-7/bin/tsc` 改回 `tsc`，`npm install` 刷新锁文件；`sampler.ts` 的类型注解在 5.x 下同样合法，可保留。
