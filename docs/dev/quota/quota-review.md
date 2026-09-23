# quota-plan.md 评审记录

- 评审人：glm-5.3（reviewer，与制定模型 opus-5 独立）
- 日期：2026-09-23
- 结论：**有条件通过**（0 Blocker / 3 Major / 9 Minor）
- 处置：3 条 Major 已由主会话修入 quota-plan.md（§5.1/§5.5 stale 处理、§10 D 行依赖修正、§3.8/§3.12 dispose 单一所有者）；Minor 1/2/3/5/6 在实现时顺手处理，4/7/8/9 记录不强制。

## Major（已修入方案）

**M1. stale 快照下注入文案承诺闸门不会执行的拦截**——`shouldAnnounce`/文案不消费 `stale`，端点挂 1h 后 L3 每 30min 复读含「会被拦下」的假承诺。
修法：stale verdict 不复读 tick（只进 HUD）；复读/播报文案在 stale 时降级为「数据陈旧 Nm，仅供参考」并删除执行承诺句式。

**M2. 拆包依赖标注错误：D 实际依赖 C**——`QuotaServiceDeps.credentials` 类型来自 C 包的 `credentials.ts`，`createQuotaStack` 运行时也构造 C 包的函数。
修法：`CredentialResolver` 类型移入 `types.ts`（Pack 0）；D 包对 `fetchJson`/adapters 用 DI 桩顶住直至 C 合并。§10 D 行依赖改为「Pack 0 + B + C(types 已在 0；运行时桩)」。

**M3. dispose 双轨缝隙**——HUD 清理挂在 `QuotaStack.dispose` 而 shutdown 只够得着 `QuotaService.dispose`；同模块 /new 路径双重 dispose 且未承诺幂等。
修法：全部清理（`setStatus(undefined)`、in-flight 防护、幂等标志）收进 `QuotaService.dispose()` 单一所有者；`QuotaStack.dispose()` 纯转发；service.test 补「双重 dispose 只清一次 status」「dispose 后在途 refresh 落地不写 status」。

## Minor（记录）

1. R9 闩锁不对称：send 失败时也回滚闩锁（与 minInterval 路径同哲学）
2. `latchBefore` 首次进入者回滚需 `delete` 而非 `set(p, undefined)`；hook.test 补该边界
3. `pickAlternatives` 对无 verdict provider 视作 level 0 / pct 0
4. 降位清除可存触发 scope、按 scope 重置即清（现规则偏保守，可接受）
5. `$VAR` 只查 `process.env`，不处理 `credential.env` map 与 `$$`/`$!` 转义——credentials.ts 注释写明语义收窄
6. 闸门文案不硬编码 `~/.pi/agent/pi-subagent.json`（可被 PI_* 重定向），写「settings 文件」
7. `FetchJson` 返回类型 `unknown | undefined` 坍缩——签名写实为 `Promise<unknown>`，语义靠文档
8. `gateLevel as LadderLevel` 裸 cast 换 narrowing helper
9. zai + zai-coding-cn 同池双拉两行近似数据（语义正确，观感问题）

## 抽查记录

15 处锚点核实，仅 2 处行号漂移（turn_end 注册实际 199-208、print guard 实际 stack.ts:531），无事实性错误。适配器规格与 requirements 实测样例一致；状态机推演无死锁；测试计划覆盖验收标准全部四项。详见会话记录。
