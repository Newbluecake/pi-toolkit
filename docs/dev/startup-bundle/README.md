# Startup bundle · 开发者要点

设计历史见 [plan.md](./plan.md)。本节覆盖历史文档中关于动态 import / reload 的旧推断。

## 原生加载边界（#48，方案 A）

- pi 1.5 用 jiti 加载根 `index.ts`。TS 内的 `import(bundleUrl)` 会被 jiti 重写，file URL 的 query 在路径解析时丢失；仅把 import 移到另一个 TS 文件无效。
- 根 dispatcher 在原有宿主身份钩子安装之后，用 `node:module` 的 `createRequire(import.meta.url)` 加载根 `bundle-bridge.cjs`。bridge 是 **Node CJS**，内部的 `import(url)` 才是真正的原生 ESM import；不能改成 jiti import / TS 包装。
- `bundleUrl()` 每次 activation 读取 bundle，计算 SHA-256 内容标识作为 `?v=`。不依赖 mtime 粒度、size 或包版本；保留时间戳的等长编辑也产生新 URL。没有模块级可变 cache。成本是一次约 6 MB 的同步读取/hash，不扫描源码。
- 相同字节复用同一 URL / Node ESM namespace；不同字节才重新求值。不在每次 activate 生成随机 generation（未选择 A+），不在 session_start 生成 generation。
- **同构建（未重建，或重建后字节相同）`/reload` 仍复用模块**。设置可重新装配，但不保证新 MODULE_INSTANCE/epoch 或 `status.reload=completed`；tracker 的跨 epoch 防伪门槛不变。这不是「任意 reload 都升级」的方案。
- 无 bundle 或 `PI_TOOLKIT_ENTRY=src` 仍走源码；Node 缺 registerHooks 保持既有显式源码降级。有 bundle 但 bridge 丢失、bridge 加载失败、bundle 读/hash/import 失败均抛错，不静默 fallback。
- `bundle-bridge.cjs` 同时列入 npm `files` 与 release zip 白名单。bridge 不进单文件 bundle；根入口无业务图静态值边，只有 default 导出。宿主 identity、off/secure/child 注册顺序、wire/caps/fixtures 均不改变。

## 升级与验证

重建不会自动更新正在运行的父 pi；需要 `/agent reload` 或重启。hub 是独立进程，`/webhub restart` 不更新父 pi。已实测 pi 1.5.0 / Node 22.22.1：先用 `477701ab` 的 dispatcher + bundle-entry 启动旧 bundle，再在同一安装路径换入修复后的 dispatcher/bridge/helper 并重建，真 Web `/agent reload` 即加载新行为、同 pid/key 换 epoch、版本到位且 completed 关联成功；该环境无需先重启一次 agent。实际部署仍需将 bridge 与 dispatcher 一起安装并完成 build；不对其他 pi/Node 版本作未验证保证，不曾操作现场会话。

回归入口：`tests/integration/startup-bundle-reload.test.ts`（真 hub、真 pi RPC、私有 HOME/socket、跨 rebuild 与同构建预期、旧路径反例、修复前进程升级），最小 jiti/native probe 在 `tests/startup-bundle/`。布局/错误测试在 `dispatcher.test.ts`，内容标识测试在 `tests/core/bundle-entry.test.ts`。构建后执行 `tests/governance/bundle-parity.test.ts` 验证 identity 与 frozen activation/off/secure/child parity；不得重生 fixtures。

## 独立 hub 仍走 source loader（T51）

bundle hooks 和父 pi 的 jiti aliases 只属于父进程；独立 hub 不因父 bundle 已成功加载就拥有宿主映射。
agent launcher 现在沿同一 realpath/pi package 链解析 TypeBox 根/value/compile，给 stock jiti-cli
封闭六键 `JITI_ALIAS` 并禁用 tsconfig paths；hub main 随即 scrub 这两个私有环境键，避免传给
后续 managed 子程序。细节与正反例见 [web-hub README](../web-hub/README.md#独立-hub-loader-的宿主映射t51)。
不新增 hub bundle/bootstrap，不变三项内核 argv / proc identity / launcher fingerprint。

修改 launcher 后 npm/ZIP 必须正常重建父 bundle（`npm pack` 的 prepack 或 `package.sh`），
仅更换 hub 源码而继续用旧父 bundle 不会补上启动 aliases。git 无 dist 分发仍由 pi 加载 TS，
不要求 consumer 安装 TypeBox/jiti/build 工具。缺宿主或目标时明确 launcher error，不回落 consumer。
内部 `LauncherPlan` 不从根入口重导出、不是 package exports 的公共扩展合同。
