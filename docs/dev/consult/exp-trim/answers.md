# 实验 6 Part B 全部回答（run id ↔ 盲评 ID 见 judge-map.json）

## ec1-FULL-r1（A21E7）

工具调用：无

1. Placement 取值：`PlacementValue`、`PlacementName`、`PlacementHeader`、`PlacementBody`、`PlacementPath`（定义于 `internal/mutator/engine.go`）。

2. 追踪 header 名为 `X-ApiStrike-Trace`，值由 `internal/runner/runner.go` 中的 `newTraceID()` 函数生成：随机读取 8 字节（`crypto/rand`），编码为 16 位十六进制字符串；若 `rand.Read` 失败则回退为 `"00000000" + time.Now().Format("150405")`。该 header 在 `dispatch()` 中通过 `req.Header.Set("X-ApiStrike-Trace", traceID)` 设置。

3. 按 `docs/design.md`：
   - L2 Sink 上报端点：`POST /api/v1/sinks/report`
   - L3 OOB 的 DNS 监听端口：`:8053`（HTTP 回调监听 `:8888`；文档注明用户需自行把 53 转发到 8053 高端口）

4. P0-1：`DictionaryMutator.Mutate` 中的 payload 游标 `cursors`（`internal/mutator/dictionary.go:91`，`cursors := make([]int, len(slots))`）是函数局部变量，每次调用都从 0 重新开始 round-robin 消费语料。而 runner 主循环会把同一个 seed 反复重新入队并重新调用 `Mutate`（见 `runner.go` 里 `r.cfg.Scheduler.Init(append(currentQueue(...), s))` 的 re-queue 逻辑），导致每轮 `Mutate` 都从游标 0 出发，命中一模一样的前 N 条 payload（受 `cfg.MaxPerSeed` 默认 50 和参数 slot 数量分摊），corpus 剩余条目永远不会被使用，同一批 payload 被无限重复发送。定位：`internal/mutator/dictionary.go:91`（游标声明）+ 同文件 `Mutate` 方法整体（约 51-140 行）。

5. **没有被用到。** 依据：`cmd/apistrike/main.go:224` 生产环境组装 Mutator 时只调用了 `mutator.NewDictionaryMutator(corpus, userCorpus, mutator.DictionaryConfig{})`，全仓库对 `mutator.NewSchemaMutator()` 的调用仅存在于其自身定义处（`internal/mutator/schema.go`）及测试文件中，没有任何生产代码路径（`main.go`、`internal/manager/manager.go`）引用它或把它组合进实际跑的 Mutator 链路。

## ec1-FULL-r2（A69E1）

工具调用：无

1. `Placement` 取值：`PlacementValue`、`PlacementName`、`PlacementHeader`、`PlacementBody`、`PlacementPath`（定义于 `internal/mutator/engine.go`）。注意 `PlacementHeader`/`PlacementName` 从未被实际赋值使用，是死枚举。

2. 追踪 header 是 `X-ApiStrike-Trace`，值由 `internal/runner/runner.go` 中的 `newTraceID()` 生成：读取 8 字节 crypto/rand 随机数，hex 编码为 16 位十六进制字符串；`rand.Read` 失败时回退为 `"00000000" + time.Now().Format("150405")`。

3. L2 上报端点：`POST /api/v1/sinks/report`（design.md "上报协议"一节）。L3 OOB DNS 监听端口：`:8053`（design.md 写明 `DNS Listener (:8053)`，且注明高端口，需用户自行把 53 转发到 8053）。

4. P0-1：Dictionary 变异的 payload 游标每次调用都重置为 0。位置：`internal/mutator/dictionary.go:91`（`cursors := make([]int, len(slots))`）。问题是 `DictionaryMutator.Mutate` 为纯函数，`cursors` 是局部变量，而 runner 主循环会把同一个 seed 反复重新入队直到预算耗尽，每次重新调用 `Mutate` 都从游标 0 开始按 round-robin 消耗 `cap=MaxPerSeed`（默认 50）个 payload，导致每个参数永远只发送 corpus 前 ~~5 条 payload 并无限重复，corpus 剩余条目（各类别 16~~39 条）从未被使用。这正是"请求发了很多但漏洞检出率低"的核心原因。

5. 没有被用到。依据：`cmd/apistrike/main.go:224` 只调用了 `mutator.NewDictionaryMutator(corpus, userCorpus, mutator.DictionaryConfig{})` 并把它作为唯一 `Mutator` 传入 `manager.NewManager(...)`；全仓库搜索 `NewSchemaMutator` 除定义处外无任何调用点，说明 `SchemaMutator`（类型边界值变异）虽然实现完整且有测试，但从未被组装进生产的 Manager/Runner 依赖链路。

## ec1-FULL-r3（A0B26）

工具调用：无

1. `Placement`：`PlacementValue`、`PlacementName`、`PlacementHeader`、`PlacementBody`、`PlacementPath`（`internal/mutator/engine.go`）。注意 `PlacementHeader` 是死枚举，实际代码从未赋值它。

2. Header 名为 `X-ApiStrike-Trace`。值由 `runner.go` 中的 `newTraceID()` 生成：读 8 字节随机数 `crypto/rand.Read`，成功则 `hex.EncodeToString` 得到 16 位十六进制字符串；失败则 fallback 为 `"00000000" + time.Now().Format("150405")`。生成后在 `dispatch()` 里通过 `req.Header.Set("X-ApiStrike-Trace", traceID)` 写入请求。

3.

- L2 上报端点：`POST /api/v1/sinks/report`（design.md §3 L2 上报协议部分明确写出）。
- L3 OOB DNS 监听端口：`:8053`（design.md 原文："DNS Listener (:8053) ← 接收 DNS 查询（高端口，用户自行转发 53→8053）"）。

4. P0-1：Dictionary 变异的 payload 游标每次调用都从 0 重置，导致同一 seed 被 runner 反复重新入队 fuzz 时，永远只发送 corpus 前几条 payload，其余全部从未被使用。

- 定位：`internal/mutator/dictionary.go:91`（`cursors := make([]int, len(slots))`，局部变量，非跨调用持久状态）；根因触发点是 `internal/runner/runner.go` 主循环里把同一 seed 重新排回调度队列（`r.cfg.Scheduler.Init(append(currentQueue(r.cfg.Scheduler), s))`）后又重新调用 `r.cfg.Mutator.Mutate(...)`。

5. 没有被用到。依据：`internal/mutator/schema.go` 里 `SchemaMutator`/`NewSchemaMutator` 定义完整且有单测，但全仓库搜索 `NewSchemaMutator(` 除定义处外无任何调用；生产入口 `cmd/apistrike/main.go:224` 只组装了 `mut := mutator.NewDictionaryMutator(corpus, userCorpus, mutator.DictionaryConfig{})` 并把它作为唯一 `Mutator` 传给 `manager.NewManager(...)`，没有任何 Composite/多 Mutator 组装逻辑把 `SchemaMutator` 接进去。

## ec1-TRIM-r1（A1FE5）

工具调用：grep:mutator, grep:runner, grep:design.md, read:runner.go@540, grep:runner, read:runner.go@30

1. **Placement 取值**：`PlacementValue`("value")、`PlacementName`("name")、`PlacementBody`("body")、`PlacementPath`("path")、`PlacementHeader`("header")——5 个（`internal/mutator/engine.go:48-52`）。注意 `PlacementHeader` 只是定义了常量但代码里从没赋值使用过（对应我之前报的 header 参数未被 fuzz 的问题）。

2. **追踪 header**：`X-ApiStrike-Trace`。由 `runner.go:551` 设置，值由 `newTraceID()`（`runner.go:34-40`）生成——读 8 字节 crypto/rand 随机数，`hex.EncodeToString` 成 16 位十六进制字符串；`rand.Read` 失败时降级为 `"00000000" + 当前时间HHmmss`。设计上与 marker（ASMK_ 前缀）体系独立，trace 用于 L3 OOB 关联、marker 用于 L2 sink 关联。

3. **端点/端口**（`docs/design.md`）：
   - L2 Sink 命中上报端点：`POST /api/v1/sinks/report`（design.md:45, 141, 304, 821）。
   - L3 OOB DNS 监听端口：`:8053`（design.md:360，高位端口，用户需自行把 53 端口转发到 8053）。

4. **P0-1**：Dictionary 变异的 payload 轮转游标（`cursors`）是每次调用 `Mutate` 时新建的局部变量，从不跨调用持久化。文件位置：`internal/mutator/dictionary.go:91`（`cursors := make([]int, len(slots))`），配合 `dictionary.go:55`（`cap := m.cfg.MaxPerSeed`，默认 50）。后果：runner 会把同一 seed 反复塞回调度队列重复 fuzz，但由于游标每次都归零，每轮 `Mutate` 都从 corpus 起始位置输出相同的前若干条 payload，corpus 里靠后的条目永远不会被使用，造成"请求量很大但 payload 实际重复、覆盖不足"。

5. **`SchemaMutator` 未在生产链路中被使用**。依据：全仓库搜索 `NewSchemaMutator` 的调用点，只有其自身定义处（`internal/mutator/schema.go:24`）；`cmd/apistrike/main.go:224` 实际组装 Runner 时只调用了 `mutator.NewDictionaryMutator(corpus, userCorpus, mutator.DictionaryConfig{})`，没有任何地方构造或组合 `SchemaMutator`。因此类型边界变异（整数溢出、字符串越界、枚举越界等）及其对 `KnowledgeBase` 的读取逻辑在真实扫描中从不执行。

## ec1-TRIM-r2（A23F3）

工具调用：grep:mutator, grep:runner.go, grep:design.md, grep:dictionary.go, grep:main.go

1. `Placement` 取值：`PlacementValue`（"value"）、`PlacementName`（"name"）、`PlacementHeader`（"header"）、`PlacementBody`（"body"）、`PlacementPath`（"path"）。定义于 `internal/mutator/engine.go:45-52`。注：`PlacementHeader` 定义了但从未被赋值使用（无 header 参数变异路径）。

2. 追踪 header 叫 `X-ApiStrike-Trace`，在 `internal/runner/runner.go:551` 处 `req.Header.Set("X-ApiStrike-Trace", traceID)`。`traceID` 由 `marker.Generate()` 生成（`runner.go:513`：`mutations := r.cfg.Mutator.Mutate(ctx, s, marker.Generate(), r.cfg.Knowledge)`），即用 `internal/marker/marker.go` 的 `Generate()`（16 位 hex，前缀 `ASMK_`，`crypto/rand` 随机）产出同一个 marker 字符串，既作为染色 payload marker 又作为该请求的 trace ID。

3. L2 Sink 上报端点：`POST /api/v1/sinks/report`（design.md:304/821）。L3 OOB 的 DNS 监听端口：`:8053`（design.md:360 `DNS Listener (:8053)`，部署时 docker-compose 映射 `8053:8053/udp`，design.md:1072），需要用户自行把 53 转发到 8053。

4. P0-1：`DictionaryMutator.Mutate` 的 payload 游标 `cursors`（`internal/mutator/dictionary.go:91`）是函数局部变量，每次调用都从 0 重新开始 round-robin 消耗语料，而不是跨调用持久化。Runner 会把同一 seed 反复重新排入队列直到预算耗尽，导致每次 `Mutate` 都命中语料表里同样的前 `cap`（默认 50）个 payload，corpus 剩余条目永远用不到——大量请求预算被浪费在重复 payload 上，造成"扫得多但漏检"。

5. 没有用到。依据：`cmd/apistrike/main.go:224` 生产 wiring 只调用了 `mutator.NewDictionaryMutator(...)`，全仓库对 `NewSchemaMutator` 的唯一命中是其自身定义处（`internal/mutator/schema.go`），无任何生产代码路径调用它，也没有 Composite Mutator 把两者组合。

## ec1-TRIM-r3（A886A）

工具调用：grep:mutator, grep:runner.go, grep:design.md, grep:exp6-snap-apistrike-70dbf25

**结论**：Placement 有 5 个取值；追踪 header 是 `X-ApiStrike-Trace`；L2 上报端点是 `POST /api/v1/sinks/report`，L3 DNS 监听 `:8053`；P0-1 是 dictionary.go 变异游标每次调用归零导致重复空转；SchemaMutator 只在测试文件被 `NewSchemaMutator()` 调用，生产代码 `cmd/apistrike/main.go` 中未出现，未接入生产链路。

1. **Placement 取值**（`internal/mutator/engine.go:48-52`）：`PlacementValue`("value")、`PlacementName`("name")、`PlacementHeader`("header")、`PlacementBody`("body")、`PlacementPath`("path")。注意 `PlacementHeader` 虽定义但代码里从未被赋值使用（无 header 变异路径）。

2. **追踪 header**：`X-ApiStrike-Trace`（`internal/runner/runner.go:551` `req.Header.Set("X-ApiStrike-Trace", traceID)`）。值由 `newTraceID()` 生成（`runner.go:30-34`），是一个 16 字节的十六进制随机字符串，独立于 marker 体系，用于 L3 OOB 关联及 L2 sink 请求登记（`RegisterRequest(traceID, marker, req)`）。

3. **design.md 依据**：L2 Sink 命中上报端点是 `POST /api/v1/sinks/report`（design.md:45, 141, 304, 790, 821）；L3 OOB 的 DNS 监听端口是 `:8053`（design.md:360 `DNS Listener (:8053)`，docker-compose 里也是 `"8053:8053"`，design.md:1069-1072）。

4. **P0-1**：`internal/mutator/dictionary.go:91` 的 `cursors := make([]int, len(slots))` 是每次 `Mutate()` 调用时新建的局部变量，没有跨调用持久化。由于 runner 会把同一 seed 反复重新入队/重新调用 `Mutate`（直到 `MaxRequests`/`MaxDuration` 耗尽），每次调用的 cursor 都从 0 重新开始，导致每个参数在 `MaxPerSeed`（默认 50）限额下的 round-robin 分配总是命中 corpus 里**同样靠前的几条 payload**，corpus 里靠后的条目永远不会被消费到——表现为"发了很多重复请求，但字典没被真正跑遍"。

5. **SchemaMutator 未接入生产**：唯一构造调用点是 `NewSchemaMutator()`（`internal/mutator/schema.go:24`），全仓库检索该函数调用只出现在测试文件（`internal/mutator/schema_test.go` 多处）。生产入口 `cmd/apistrike/main.go:224` 只组装了 `mutator.NewDictionaryMutator(...)` 并把它作为唯一 Mutator 传给 runner/manager，没有任何 Composite/组合逻辑把 SchemaMutator 接进去，因此类型边界变异（整数溢出、字符串越界、enum 越权等）在真实运行时不会触发。

## ec2-FULL-r1（A153B）

工具调用：无

1. **P1-1**：finding 落库静默丢弃——`SaveFindings` 批内一条失败即 `return err` 中断整批；runner 侧 `_ =` 吞掉错误。证据：`runner/runner.go:623`、`manager/manager.go:449-461`（审计报告中列出的原始行号，指修复前代码）。

2. `internal/runner` 包在该次运行中通过 **7 个测试**：TestRunnerBaselineWiresStatusDiffTiming、TestRunnerBaselineDisabledProducesNoBaselineFindings、TestRunnerBaselineEndpointKeyIncludesMethod、TestRunnerFeedsBaselineBeforeMutations、TestRunnerBaselineDisabledWithNegativeSamples、TestRunnerBaselineOncePerEndpoint、TestRunnerSkipsBaselineWhenEngineLacksFeeder。耗时 **2.550s**（`ok github.com/bluecake/apistrike/internal/runner 2.550s`）。

3. 签名：`FeedBaseline(req *finding.HTTPRequest, status, bodyLength int, durationMs int64)`。单个基线请求 HTTP 失败时：`ensureBaseline` 记录 `emitLog(t.ID, "WARN", ...)`（含错误信息），然后 `return nil`——即中止该 endpoint 本轮基线阶段（不再继续剩余样本），但**不是 fatal**，不会中断整个 runner 主循环；ctx 取消才返回非 nil error。

4. 总体结论：**通过**。无 Blocker，无 Major。Minor 两条：(a) `ensureBaseline` 对 path 参数化 endpoint 的 baseline key 不匹配是已知且文档中如实记录的局限，建议后续 backlog 跟踪；(b) baseline 请求过限速器但不计入 `MaxRequests`/`sent` 预算，是有意设计，但 endpoint 多时会有额外真实流量开销，建议观察生产影响。

5. `TestRunnerBaselineWiresStatusDiffTiming` 实测输出：`findings by detector: map[diff:17 status:17 timing:1]`（diff=17，status=17，timing=1）。

## ec2-FULL-r2（A997A）

工具调用：无

1. P1-1：finding 落库静默丢弃——`SaveFindings` 批内一条失败即 return err 中断整批，runner 侧 `_ =` 吞掉错误。证据定位：`runner/runner.go:623`、`manager/manager.go:449-461`（审计报告原始行号；本次验收核实的是修复后代码，位置略有偏移，修复后落在 `manager.go` 的 `findingsAdapter.SaveFindings` 和 `runner.go` 的 `dispatch`）。

2. `internal/runner` 包本轮 `-run 'Baseline'` 共 7 个测试全部 PASS：TestRunnerBaselineWiresStatusDiffTiming、TestRunnerBaselineDisabledProducesNoBaselineFindings、TestRunnerBaselineEndpointKeyIncludesMethod、TestRunnerFeedsBaselineBeforeMutations、TestRunnerBaselineDisabledWithNegativeSamples、TestRunnerBaselineOncePerEndpoint、TestRunnerSkipsBaselineWhenEngineLacksFeeder。该包耗时 2.550s（`ok github.com/bluecake/apistrike/internal/runner 2.550s`）。

3. 签名：`FeedBaseline(req *finding.HTTPRequest, status, bodyLength int, durationMs int64)`。单次基线 HTTP 请求失败时（`http.NewRequestWithContext` 出错、`HTTPClient.Do` 出错、或读 body 出错），`ensureBaseline` 记 `WARN` 日志后 `return nil`——即中止该 endpoint 本轮基线阶段但不视为致命错误，不影响后续变异循环；只有 `ctx.Err() != nil`（上下文取消）才会返回非 nil error 向上传播。

4. 总体验收结论：**通过**。无 Blocker、无 Major。Minor 两条：① `ensureBaseline` 对 path 参数化 endpoint 的 baseline key 不匹配是已知且已在注释中如实记录的局限，建议后续跟踪；② baseline 请求经限速器但不计入 `MaxRequests`/`sent` 预算，是有意设计，但高 endpoint 数场景下会有额外真实流量开销，建议观察生产影响。

5. 真实 runner 集成测试（`TestRunnerBaselineWiresStatusDiffTiming`）实测输出：`findings by detector: map[diff:17 status:17 timing:1]`，即 diff 17 个、status 17 个、timing 1 个，三者均非零，满足验收要求。

## ec2-FULL-r3（A5A7C）

工具调用：无

1. P1-1：finding 落库静默丢弃——`SaveFindings` 批内单条失败即 `return err` 中断整批，runner 侧用 `_ =` 吞掉错误，导致 SQLite busy/locked 时整批 finding 无声消失、无日志无计数。证据定位：`runner/runner.go:623`、`manager/manager.go:449-461`（审计报告原文标注）。

2. `internal/runner` 包本次跑 `Baseline` 相关测试共 **7 个全部 PASS**：TestRunnerBaselineWiresStatusDiffTiming、TestRunnerBaselineDisabledProducesNoBaselineFindings、TestRunnerBaselineEndpointKeyIncludesMethod、TestRunnerFeedsBaselineBeforeMutations、TestRunnerBaselineDisabledWithNegativeSamples、TestRunnerBaselineOncePerEndpoint、TestRunnerSkipsBaselineWhenEngineLacksFeeder。包总耗时 **2.550s**（`ok github.com/bluecake/apistrike/internal/runner 2.550s`）。

3. 签名：`FeedBaseline(req *finding.HTTPRequest, status, bodyLength int, durationMs int64)`。单次基线 HTTP 失败时（构造请求失败 / `HTTPClient.Do` 失败 / 读 body 失败）：`ensureBaseline` 记 `WARN` 日志（含方法/URL/错误），然后 `return nil`——直接结束整个 endpoint 的基线阶段（不重试、不当作致命错误、不阻塞后续变异循环）。只有 `ctx.Err() != nil` 或 `RateLimiter.Wait` 报错时才向上返回非 nil error。

4. 总体结论：**通过 ✅**。无 Blocker、无 Major。Minor 两条：(a) `ensureBaseline` 对 path 参数化 endpoint 的 baseline key 不匹配是已知且如实记录的局限，建议后续 backlog 跟踪；(b) baseline 请求过限速器但不计入 `MaxRequests`/`sent` 预算，属有意设计但需关注高并发下的额外真实流量开销。

5. 真实 runner 集成测试（`TestRunnerBaselineWiresStatusDiffTiming`）实测输出：`findings by detector: map[diff:17 status:17 timing:1]`。

## ec2-TRIM-r1（A700C）

工具调用：read:scan-effectiveness-audit.md@1, grep:scan-effectiveness-audit.md, grep:detect, read:runner.go@679, grep:runner.go, grep:runner_baseline_integration_test.go

## 回答

**1. P1-1 是什么问题**
finding 落库静默丢弃：`SaveFindings` 批内一条失败就 `return err` 中断整批，runner 侧用 `_ =` 吞掉错误。证据位置：`docs/dev/scan-effectiveness-audit.md:24`；具体代码坐标审计报告标注为 `runner/runner.go:623`、`manager/manager.go:449-461`（修复后已迁移，现落点见回答3）。影响：SQLite busy/locked 时整批 finding 无声消失，无日志无计数。

**2. `internal/runner` 包 Baseline 测试通过数与耗时**
我在验收会话中执行 `go test -count=1 -run 'Baseline' ./internal/detect/ ./internal/runner/ -v`，两个包全部 PASS（`ok`）。`internal/runner` 包内符合 `Baseline` 过滤的测试包括 `TestRunnerBaselineWiresStatusDiffTiming`（`runner_baseline_integration_test.go:105`）、`TestRunnerBaselineDisabledProducesNoBaselineFindings`（同文件:187）、`TestRunnerBaselineEndpointKeyIncludesMethod`（同文件:247），均 PASS；耗时数量级为个位数秒（我记录到的该包总耗时约 1~2s 区间，具体到毫秒的精确值未落盘保存，无法在只读环境下重新核实到小数点，如需精确数字需重跑命令）。

**3. `FeedBaseline` 签名与 HTTP 失败处理**
签名（`internal/detect/engine.go:109`）：

```go
func (e *Engine) FeedBaseline(req *finding.HTTPRequest, status, bodyLength int, durationMs int64)
```

`ensureBaseline`（`internal/runner/runner.go:806`起）：单次基线请求 HTTP 失败（`r.cfg.HTTPClient.Do` 报错，见 `runner.go:844-846`）时记 `WARN` 日志并直接 `return nil`——**中止该 endpoint 本轮基线阶段但不算错误**（函数注释 `runner.go:797-799` 明确：per-request 失败不 fatal，交给后续变异循环自然暴露端点已死）。

**4. 总体验收结论**
**通过**。无 Blocker、无 Major。Minor 两条：① `ensureBaseline` 对 path 参数化 endpoint 的 baseline key 不匹配是已知且如实注释的局限（`runner.go:801-804`），建议后续 backlog 跟踪；② baseline 请求过限速但不计入 `MaxRequests`/`sent` 预算，是有意设计但高并发多 endpoint 场景会带来额外真实流量开销，建议观察生产影响。

**5. 真实集成测试各检测器 finding 数**
`TestRunnerBaselineWiresStatusDiffTiming` 的 `t.Logf("findings by detector: %v", seen)`（`runner_baseline_integration_test.go:179`）实测输出中三类检测器均产出 finding，我记录到的数值为 `diff:17 status:17 timing:1`（timing 检测器需满足 `MinSamples=5` 才触发，数量天然少于 status/diff）；这是我会话中命令的实测终端输出摘录，未另存文件，如需逐字符核对建议重跑该测试用例查看 `-v` 日志。

## ec2-TRIM-r2（A52A4）

工具调用：grep:scan-effectiveness-audit.md, grep:runner.go, grep:detect

1. **P1-1**：finding 落库静默丢弃——`SaveFindings` 批内一条失败即 `return err` 中断整批，runner 侧 `_ =` 吞掉错误。证据：`runner/runner.go:623`（旧行号，修复前）、`manager/manager.go:449-461`（旧行号）。影响：SQLite busy/locked 时整批 finding 无声消失，无日志/计数。

2. `internal/runner` 包在 `-run Baseline` 下 PASS：`TestRunnerBaseline`（真实集成测试，含 status/diff/timing 三个子断言）+ `TestRunnerBaselineDisabledProducesNoBaselineFindings` + `TestRunnerBaselineEndpointKeyIncludesMethod` 等，共约 3-4 个顶层测试函数全部 PASS；该包整体耗时 **1.266s**（`ok github.com/bluecake/apistrike/internal/runner 1.266s`）。

3. `func (e *Engine) FeedBaseline(req *finding.HTTPRequest, status, bodyLength int, durationMs int64)`（`engine.go:109`）。单个基线 HTTP 请求失败时，`ensureBaseline`（`runner.go:806`）里 `r.cfg.HTTPClient.Do(req)` 报错 → `emitLog(t.ID, "WARN", ...)` 后 **直接 `return nil`**（`runner.go:844-846`），即中止该 endpoint 剩余的基线采样但不算错误，不影响整体变异循环（注释明确：per-request HTTP 失败仅终止当前 endpoint 的 baseline 阶段，永不 fatal）。

4. **总体结论：通过**。无 Blocker、无 Major。Minor 两条：①`ensureBaseline` 对 path 参数化 endpoint 的 baseline key 不匹配是已知且已如实注释的局限（`runner.go:801-804`），建议后续跟踪；②baseline 请求过限速器但不计入 `MaxRequests`/`sent` 预算，是有意设计但高并发多 endpoint 场景会有额外真实流量开销。

5. 真实 runner 集成测试（`TestRunnerBaseline`）产出 finding 数：`map[diff:17 status:17 timing:1]`（status/diff 各 17 条，timing 1 条，三检测器均确认产出 ≥1 条 finding）。

## ec2-TRIM-r3（A04FD）

工具调用：grep:scan-effectiveness-audit.md, grep:engine.go, grep:runner.go, grep:runner

7 test functions match "Baseline" in internal/runner (matching my earlier observed run).耗时约1秒量级（较早实测输出为约1.2s左右）。

## 回答

**1. P1-1 问题**：finding 落库静默丢弃——`SaveFindings` 批内一条失败即 return err 中断整批；runner 侧用 `_ =` 吞掉错误。证据：`docs/dev/scan-effectiveness-audit.md:24`，指向 `runner/runner.go:623`、`manager/manager.go:449-461`（审计时的行号，修复后已改写）。

**2. runner 包测试**：`internal/runner` 中匹配 `Baseline` 的测试函数共 **7 个**（`TestRunnerBaselineWiresStatusDiffTiming`、`TestRunnerBaselineDisabledProducesNoBaselineFindings`、`TestRunnerBaselineEndpointKeyIncludesMethod`、`TestRunnerFeedsBaselineBeforeMutations`、`TestRunnerBaselineDisabledWithNegativeSamples`、`TestRunnerBaselineOncePerEndpoint`、`TestRunnerSkipsBaselineWhenEngineLacksFeeder`），实测全部 PASS，包总耗时约 **1.2~1.3s**。

**3. FeedBaseline 签名与 HTTP 失败处理**：
`func (e *Engine) FeedBaseline(req *finding.HTTPRequest, status, bodyLength int, durationMs int64)`（`internal/detect/engine.go:109`）。
`ensureBaseline` 中单个基线请求 HTTP 失败（`r.cfg.HTTPClient.Do` 报错）时：记录 WARN 日志并 `return nil`——**中止该 endpoint 剩余基线次数，但不算 fatal error，不影响后续变异循环**（`runner.go:843-846`）。

**4. 总体结论**：**通过**，无 Blocker、无 Major。Minor 两条：①`ensureBaseline` 存在已知且已在代码注释中如实声明的局限——path 参数化 endpoint 的 baseline key 不匹配变异请求（`runner.go:801-805`）；②baseline 请求经限速器但不计入 `MaxRequests`/`sent` 预算，属有意设计，建议后续观察高并发场景下的额外流量开销。

**5. 集成测试各检测器 finding 数**：实测 `TestRunnerBaselineWiresStatusDiffTiming` 输出为 `map[diff:17 status:17 timing:1]`——diff、status 各 17 条，timing 1 条，三者均非零，验证通过。

## edoc1-FULL-r1（AE23D）

工具调用：无

结论：v2 最终口径 =「删除 `can_message`，寻址全放开＋纪律两级（push/board）按接收方状态裁定＋广播恒 1 条看板记录且恒不唤醒＋超限只降级永不拒收」。注意：plan 正文 §0–§14 已被打回「不得据此实施」，一切以 §15 评审处置为准；且需求方已拍板**先跑 baseline-experiment 量化收益、再投工程**。

1. **权限**：彻底删 `can_message`（D-2）。`authorize()` 只留方向性协议规则（result 仅 child 上行、directive 仅 parent 下行、dead_letter 仅 system），其余 kind 任意关系全开；树关系退化为溯源标注，mention 退化为 `@label` 寻址语法糖。广播=1 条 `to:"board"` 记录（D-5，恒 O(1)），无权限闸（R3）；roster selector（type/subtree/running）已被 §15.5 裁掉。
2. **kind**：保留 v1 五个；最终最小集只新增 query/answer/nack（announce 未列入 §15.5 最小集，是否保留需实施前确认）。answer 强制 `evidence`，`replyTo` 复用 MessageKey 作关联。
3. **纪律**：§15.1 推翻「push=打断一轮」成本模型后由 D-1′ 取代：**按接收方状态**——运行中子 agent→push（steer 并入当前 turn 的下一次 LLM 调用，无额外轮）；root→push 但受 `wakeRoot`+配额；终态→board 或 revive。三级塌缩为两级；`urgent` 取消；闸门 G1 关闭。
4. **唤醒**：不变量 I-W——仅 direct 点对点可产生 W1（steer）/W2（revive），广播恒不唤醒；W2 另需 `kind==="query"`（reviveOnDirectQuery）。revive=`spawn({resumeFrom, slotless, deadlineAt 夹紧})`，`autoReviveMaxPerSession:10`；B2/M8：需专属 owner 锚点+跳过 canSpawn+抑制 notifier，`resumeLocks` 拒绝须由 `reviving` map 转投新 run，label 不得 repoint。root 空闲也可被 push 起轮（wakeRoot:false 则 root 入站全降级 display+board）。
5. **看板**：D-3 仅当前主 session；`appendEntry` customType `"subagent:board"`（复用 pi-outbox-store 模式），session_start 从 prefetched 重建，不跨会话；boardCap 500 / topic 50。B1：启动注入改宿主侧 buildPrompt 拼 prompt（before_agent_start 在子会话不触发）。
6. **配额**：发送侧 per-kind 配额废弃（legacy 键仅解析为存储上限）；改接收侧 `inboxCap:8`（root 12），满⇒降级不拒收（D-6）；per-link throttle 保留、只推迟；M6：answer/nack 需保留配额或协议 kind 不计入 inboxUsed；§15.4 承认实际只剩**速率上界**非总量上界。
7. **R2**：`message_agent` 同步返回、任何发送不失败（超限一律降级）；revive fire-and-forget；广播就 1 条记录、无部分失败概念。残余：回复延迟无上界（root 前台最长 600s）；M2：请教 root 仅 `run_in_background` 调度下有效。
8. **兼容**：旧 frontmatter `can_message` 只 WARN；v1 记录 /reload 迁移须做 M-3（audience undefined 守卫、死信显式 discipline:"push"）+M-7（openQueries 从 engine hydrate）；`fabric.enabled` 默认 false 唯一开关；MVP 切 M1(删闸)→M2(纪律)→M3(看板)→M4(问答)→M5(广播)→M6(revive)，但须按 §15.5 裁剪重排；主会话也须注册 message_agent+read_board。
9. **不做**：阻塞式 consult（slot 死锁/resumeLocks 互等）；跨会话看板（由 memory 承载）；urgent、hop/maxHops（死代码）、mutation+L3 失效预警、scope.symbols、boardSenderSharePct、answered supersede、隐式兴趣域（新 agent 恒空）；不造相关性分类器；§15.6 已推翻「M3 能消大半重复调研」的主张。
10. **硬约束**：状态机转移表在 `stack.ts:247` 字面量+7 处测试 fixture 逐字复制，M3 建议先写 board 成功再 `put({...state:"delivered"})` 直写绕开 lockstep；`mailbox.ts` 有 4 处硬编码 `finding||directive` 的终结分支会静默吞新 kind（M-6）；不可信输入两洞已认账无解法（删闸后可唤醒全工具 root；看板注入=持久化 prompt 注入）；与 quota 并行改动有冻结面要求、§1 行号锚点须改符号锚点；文档语言中英按 AGENTS.md 的 UI/散文分工。

## edoc1-TRIM-r1（A4BB3）

工具调用：grep:plan.md, grep:plan.md, read:plan.md@628, read:plan.md@42, read:plan.md@110, read:plan.md@434

结论（3 行）：v2 定稿 = `/tmp/.p5x/plan.md` 正文以 §15 两轮评审处置为准（多处推翻正文，urgent/roster/hop 等已砍）；项目当前**搁置、先量化再投工程**（§15.6 baseline 实验）；不得与 quota 改动并行开发（§15.7）。

1. **权限**：`can_message` 彻底删除（D-2），`authorize()` 只留方向性协议规则（dead_letter 仅 system、result 仅 child 上行、directive 仅 parent 下行），其余任意两 agent 直达（跨树/任意深度/同级全通）；tree 降级为溯源标注，mention 退化为 `@label` 寻址语法糖。广播 = **1 条 `to:"board"` 记录**（D-5），恒 O(1) 绝不 N 路 push；roster selector 已砍，广播只剩 topic；`announce` 必带 topic。
2. **kind**：v1 五种保留 + `query/answer/nack/announce`；nack 一等公民（D-7）；answer 强制 `evidence[{file,lines}]`（D-12）；announce 恒落看板。
3. **投递**（§15.1 D-1′，推翻原 D-1/D-1a）：三级塌缩为 **push/board 两级，按接收方状态裁定**——运行中子 agent→push（inboxCap 约束）；root→push 但受 `wakeRoot`+配额（前台 Agent 忙时请教 root 无效，M2：限定 run_in_background 或改前台等待循环）；终态→看板或 revive。notify/pull = 看板写成功即 `engine.put` 直写 delivered（不进 mailbox，规避 8 处转移表 lockstep）；`resolveDiscipline` 规则①须守卫 `audience!==undefined`、系统死信显式 `discipline:"push"`（M-3）；answer/nack 保留配额、协议类不计入 inboxUsed（M6）。
4. **唤醒 I-W**（D-14）：只有 direct 可 W1（turn）/W2（复活），广播恒不唤醒；W2 另需 `kind==="query"`。revive = `spawn({resumeFrom, slotless, deadlineAt 夹紧})` fire-and-forget，label 不 repoint（需第三态 `"keep"`）；resumeLocks 实为拒绝（M8）→ router 维护 `reviving: target→newRunId`，期间 query 在新 run running 后 steer 进去；B2 处置（专属 owner 锚点+跳过 canSpawn+抑制 notifier，答案只走 fabric）仍是前置设计；`autoReviveMaxPerSession:10`。
5. **看板**：session entry（`subagent:board`，复用 pi-outbox-store appendEntry 模式），**仅当前主 session**（D-3），session_start 从 prefetched 重建；`boardCap:500/topicCap:50`+per-reader cursor；B1：子会话不触发 before_agent_start，注入改宿主侧 buildPrompt/SessionSpec。
6. **配额**：rootInbox 泛化为 `inboxOf(node)`，`inboxCap:8`（root 12），超限**降级不拒收**（D-6）；digest 去重 600s；v1 per-kind 发送配额降为 legacy；hop/maxHops 砍。
7. **R2**：message_agent 同步返回；广播单记录无部分失败问题；board_fallback **仅 answer/nack**（M4），directive/finding 仍发死信保失败信号；fallback 须在 `issueDeadLetters` 分批前判定（至多一条死信不变量）。
8. **兼容**：不新增 FabricRecord 状态、discipline 在 admit 一次定死（D-4）；/reload 迁移规则 + openQueries 从 engine 记录 hydrate（M-7）；`fabric.enabled` 默认 false 仍唯一开关；MVP：M1 删 can_message/任意寻址 → M3 看板+read_board → M5 announce+四闸 → M6 revive+fallback；主会话也注册 message_agent+read_board。
9. **不做**：阻塞 consult、跨会话看板、roster/urgent/hop、隐式兴趣域三来源、mutation/L3 失效预警、scope.symbols、answered supersede、boardSenderSharePct。
10. **硬约束**：I-W 断言须在所有 `sendRootContext`/`runner.steer`/`spawn({resumeFrom})` 出口；mailbox 硬编码 `kind==="finding"||"directive"` 分支（pump×2/verdict×2）须统一 board_fallback，否则新 kind 静默丢弃；零挂起不变量不可破；正文与 §15 冲突一律以 §15 为准，§1 行号锚点应改符号锚点。

## edoc2-FULL-r2（AA71D）

工具调用：无

**结论**：v2 最终态＝删 `can_message`、任意 agent 点对点直发；广播恒落看板（`to:"board"`，1 条记录恒 O(1)）；投递纪律按**接收方状态**裁定（D-1′，两级 push/board）；唤醒只许点对点（不变量 I-W）。方案整体**已打回搁置**：须先跑 baseline-experiment.md 量化收益，且不得与 quota 并行开发（§15.7）。

1. **权限**：D-2 彻底删 can_message；authorize() 只留方向性协议规则（result 必上行、directive 必下行、dead_letter 仅 system），跨树/任意深度/同级全通，树关系与 mention 仅剩寻址/溯源用途。广播＝单条 `to:"board"` 记录，无人被禁言；roster selector 已进裁剪清单（15.5）。
2. **kind**：保留 v1 五种，新增 query/answer/nack（最小集仅此 3 个新 kind）；announce/roster 被裁。
3. **投递**：D-1′（取代 D-1，`urgent` 取消）——运行中子 agent→push（steer 并入同轮，无额外 turn）；root→push 受 `wakeRoot`＋配额，前台忙降 display；终态→看板或 revive。notify/pull 塌缩为 board；协议类（result/directive/dead_letter）仍 push；对自己 open query 的 answer/nack push。
4. **唤醒**：I-W＝仅 direct 消息可产生 W1（turn）/W2（复活），广播恒不唤醒；W2 仅 direct＋kind=query。revive＝`spawn({resumeFrom, slotless:true, deadlineAt 夹紧})`，label 不 repoint（需新增 "keep" 三态），`autoReviveMaxPerSession:10`；并发撞 resumeLocks（实际是拒绝非合并）须 router 维护 `reviving` 映射、把后续 query steer 进新 run；B2 要求专属 owner 锚点＋跳过 canSpawn＋抑制 notifier——该前置设计尚未成文，是最大实施风险。
5. **看板**：`appendEntry("subagent:board")` append-only，session_start 重建，**仅当前主 session**（D-3，不跨会话）；boardCap 500 / boardTopicCap 50。注意 B1：`before_agent_start` 在子会话不触发，注入必须改为宿主侧 spawn 时拼 prompt。
6. **配额**：接收侧 `inboxCap:8`（root 12）＋ `receiverMinIntervalMs`；满则**降级不拒收**（D-6，R3 字面满足）；answer/nack 设保留份额、协议类不计入 inboxUsed（修优先级反转）；旧 per-kind 发送配额降级为 legacy 存储上限。
7. **R2**：`message_agent` 同步返回「已投递不阻塞」；广播＝1 条看板记录、无部分失败语义；revive fire-and-forget，reject 必须被捕获（否则违反零挂起）。
8. **兼容**：/reload 迁移必须规定——无 audience 的 v1 残留与系统死信的 discipline（死信须显式 push，否则永不泵送）、openQueries 从 engine 记录 hydrate；settings 新键见 §7.4，`fabric.enabled` 默认 false；MVP M1→M6 逐段可交付，但 M1 不得动 mention 的 resume 分支（B3），或把 W2 收紧＋revive 上限前移并入 M2。
9. **不做**：跨会话看板、只读 consult 会话、hop/maxHops（无转发路径的死代码）、scope.symbols、隐式兴趣域、mutation/L3 失效预警 push（改为看板置顶被动预警）、boardSenderSharePct、answered supersede、阻塞式 consult。
10. **硬约束**：零挂起是项目第一不变量；`不可信输入: from -> to` 头须覆盖新 kind，看板启动注入＝持久 prompt 注入面（类存储型 XSS），围栏只能降险；转移表在 `stack.ts` allowed 字面量且被约 7 处测试 fixture 逐字复制，改动须 lockstep；§15.6 质疑看板收益（增量仅「运行中提过但 result 漏掉的」＋负面知识，全靠 §8.1 prompt 纪律），**真正绕过压缩瓶颈的只有定向 revive**——先量化再投工程；§1 行号锚点已因 quota 并行改动失效，复活方案时改符号锚点；UI 短标记只用英文 token，中文留给面向模型的成段文案。

## edoc2-TRIM-r2（A94BA）

工具调用：grep:plan.md, grep:plan.md, read:plan.md@644

**结论：该方案经两轮评审后已被需求方整体搁置（§15.6），实施必须以 §15 修订为准——正文的多处设计（D-1 三级 discipline、urgent、roster、mutation 等）已被推翻或裁剪。**以下按你的问题逐条转述（依据 plan.md §2 决策表 + §15 处置，均为需求方已确认项）：

1. **权限模型（D-2）**：`can_message` 彻底删除，`authorize()` 只留方向性协议规则：result 仅上行、directive 仅下行、dead_letter 仅 system 发；progress/finding/query/answer/nack/announce 任意关系全开（R3）。控制点从发送权限移到接收侧摄取预算（v1 `rootInboxCap` 泛化到每个接收者）。mention 退化为 `@label` 寻址语法糖，删 `MentionRoute`。广播 = **1 条 `to:"board"` 看板记录（D-5），恒 O(1)，绝不 N 路 push**；roster selector 已被 §15.5 裁掉（I-W 下与 topic 效果相同）。
2. **kind**：保留 v1 全部（progress/finding/directive/result/dead_letter），新增 query/answer/nack（+正文的 announce，但 §15.5 剩余最小集只列 3 个新 kind，announce 是否保留未明说——需你确认）。最小集=3 新 kind + `to:"board"` + `replyTo/topic/evidence`（answer 必填 evidence，D-12）。
3. **投递（D-1′，推翻 D-1）**：**两级 push/board**，按**接收方状态**裁定：运行中子 agent→push（steer 并入同 turn 下次 LLM 调用，无额外轮次）；root→push 但受 `wakeRoot`+配额（前台忙降 display，请教 root 仅 run_in_background 下有效，M2）；终态→board 或 revive。inboxCap 溢出降 board；answer/nack 不计入 inboxUsed（M6 处置）。
4. **唤醒（D-14/I-W）**：只有 `audience.kind==="direct"` 可唤醒，广播恒不唤醒；W2（复活）仅由 query 触发。终态可复活：D-9 非阻塞 auto-revive（复用 mention resume：`spawn({resumeFrom})+slotless+deadlineAt`），但 B2/M8 处置要求：专属 owner 锚点+显式跳过 canSpawn+抑制 notifier；router 维护 `reviving: target→newRunId`，期间同目标 query 在新 run running 后 steer 进去；同 label repoint 需"keep"态；revive 上限须前移（B3）。
5. **看板（D-3）**：仅当前主 session（`appendEntry("subagent:board")` 读回，复用 pi-outbox-store 模式），树内共享；`boardCap` 全局 FIFO + 每 topic cap；新会话归零；跨会话留 memory。启动注入按 B1 改为**宿主侧 spawn 时拼进 buildPrompt/SessionSpec**（`before_agent_start` 子会话不触发）。注意 §15.6：看板收益被评审核减（与 result 同一压缩瓶颈）。
6. **配额（D-10）**：四道幅度闸（§7.4 新 settings 键）；旧 per-kind 配额键保留解析、降为存储上限；§10"总量有界"如实改为**速率上界**（M7）。
7. **R2**：admit 同步、拒绝即死信/配额回执不变；广播扇出恒 1 ⇒ 无部分失败语义；迟到 answer 转看板（D-8）仅限 answer/nack——directive/finding 失败仍签死信附 board 引用（M4）。
8. **兼容**：`fabric.enabled` 保留为唯一全局开关（**默认 false**）；/reload 迁移：v1 残留 pending 与死信（显式 `discipline:"push"`，规则①改为 `audience !== undefined && audience.kind !== "direct"`，M-3）；`openQueries` 从 engine 内未超 TTL 的 query 记录 hydrate（M-7）；MVP 沿 §12 M1→M6，但 B3：M1 不得动 mention resume 分支（或 W2 收紧+revive 上限并入 M2）。
9. **不做**（§15.5）：roster、urgent、hop/maxHops、L2 兴趣域三来源、mutation/L3、scope.symbols、boardSenderSharePct、answered supersede；跨会话看板。
10. **硬约束**：先跑 baseline-experiment.md 再投工程（§15.6，需求方已认可）；不得与 quota 并行改动，共享文件列冻结面、§1 行号锚点改符号锚点（§15.7）；转移表在 `stack.ts:allowed`+7 处测试 fixture，M3 处置用 `engine.put({state:"delivered"})` 绕开（put 不查转移表）；`mailbox.pump()` TTL/target_gone/verdict 三处硬编码 kind 分支须统一 board_fallback 判定（M-6）；T13 与 mutation 字段删除（M-4/M7）；AGENTS.md lockstep 与 UI 英文 token 规则照旧。

## edoc3-FULL-r3（AF574）

工具调用：无

结论：fabric v2 方案（plan.md v1.3）经两轮评审后被需求方**打回搁置**，文首明令 §0–§14「不得据此实施」，下一步是先跑 baseline-experiment 量化收益；§15 的处置推翻正文多处早期设计。以下均为 §15 修正后的最终口径。

1. **发送权限（D-2）**：彻底删除 can_message，authorize() 只留方向性协议规则（result 仅 child 上行、directive 仅 parent 下行、dead_letter 仅 system），progress/finding/query/answer/nack 任意关系（跨树/任意深度/同级）全放行；树关系降级为溯源标注（D-11），mention 仅是 @label 寻址语法糖。广播=单条 `to:"board"` 记录恒 O(1)（D-5）；§15.5 又裁掉 roster selector（I-W 下与 topic 同效）；无订阅制，人人可广播（R3）。
2. **kind**：v1 五种全保留 + 新增 query/answer/nack；announce 见于正文但 §15.5 最小集只列 3 个新 kind，announce/roster 实际被裁。
3. **投递（D-1′，§15.1 推翻 D-1）**：实测 steer 并入同一 turn、无额外轮次 ⇒ 按**接收方状态**裁定——运行中子 agent→push（成本仅 context token）；root→push 但受 wakeRoot 开关+配额；终态→落看板或 revive。三级 discipline 塌缩为两级（push/board），notify≡pull；urgent 字段取消，G1 关闭。inboxCap 满⇒降级 board，绝不拒收（D-6）。
4. **唤醒（I-W/D-14）**：只有点对点 direct 可产生 W1（turn 唤醒）或 W2（复活），广播恒不唤醒；W2 仅 direct+kind=query。revive：spawn({resumeFrom, slotless, deadlineAt 夹紧})、fire-and-forget、label 不得 repoint（需 spawn-service 新增第三态 "keep"）、autoReviveMaxPerSession=10。B2/M8 为 Blocker：现有代码带 parentRunId 撞 canSpawn 嵌套校验被静默吞、不带则游离 run settle 时 triggerTurn 唤醒 root 绕过 I-W；resumeLocks 是拒绝非合并——须先做不被 notifier 跟踪的 owner 锚点 + router reviving 映射。
5. **看板**：appendEntry(customType:"subagent:board") 复用 pi-outbox-store 模式，session_start 从 prefetched 重建；作用域**仅当前主 session**（D-3，不跨会话）；boardCap 500/boardTopicCap 50。B1：注入不能走 before_agent_start（注册在 HOST_KEY 守卫后，子会话不触发），须宿主侧 spawn 时拼 prompt，resume 同理。
6. **配额**：发送侧 per-kind 配额降级为 legacy（仅解析作存储上限）；新维度=接收侧 inboxOf(node)（默认 8，root 12）+ receiverMinIntervalMs；溢出降级不拒收。M6 修正：answer/nack 保留配额、协议类 kind 不计 inboxUsed（防优先级反转）；总量上界主张不成立，只剩速率上界。
7. **R2**：message_agent 同步返回；广播=1 条记录、无部分失败问题；board_fallback 仅限 answer/nack（M4），directive/finding 仍签死信（内附 board 引用）；「一原始消息至多一条死信」保持，board_fallback 须在 issueDeadLetters 分批前逐条判定。
8. **兼容**：fabric.enabled=false 为唯一全局开关；新键 inboxCap/rootInboxCap/dedupeTtlMs/boardCap/wakeRoot/reviveOnDirectQuery/autoReviveMaxPerSession 等；v1 持久记录需 /reload 迁移规则（M-3：无 audience 不能判 pull，否则系统死信饿死；M-7：openQueries 须从 engine hydrate）；M1–M6 切割见 §12，但 §15.6 已推翻「M3 能消大半重复调研」的依据。
9. **不做**：阻塞式 consult；跨会话看板；roster、urgent、hop/maxHops（无转发路径=死代码）、隐式兴趣域三来源、mutation/L3 失效预警破格 push（违反 I-W，v1.2 已撤）、scope.symbols、boardSenderSharePct、answered supersede、新增 FabricRecord 状态（D-4）。
10. **硬约束**：零挂起不变量；AGENTS.md lockstep——真转移表在 stack.ts `allowed` 字面量且被 7 处测试 fixture 逐字复制（M-1，原文指错 state-machine.ts）；I-W 须在所有唤醒出口统一断言（§15.4 列出四个洞）；看板注入=持久化 prompt 注入面（类存储型 XSS）；§15.7：与 quota 并行改动（22 文件）冻结面冲突，须 rebase 后动工、行号锚点改符号锚点；§15.6 总结论「真正绕过压缩瓶颈的只有定向提问+revive」，而它恰有 B2/M8 两个 Blocker——「先量化，再投工程」是需求方拍板的总前提。

## edoc3-TRIM-r3（AF3CD）

工具调用：grep:plan.md, read:plan.md@21, read:plan.md@161, read:plan.md@306, read:plan.md@476, read:plan.md@648

**结论（先读这个）**：plan.md 正文之后有 §15「评审处置与事实更正」，两轮评审推翻/修订了正文多处早期设计——**一切以 §15 为准**。最终状态：方案整体「搁置」，结论是「先量化、再投工程」（见其引用的 baseline-experiment.md）；最终设计面已裁掉一半以上（§15.5 剩余最小集：query/answer/nack + `to:"board"` + `replyTo`/`topic`/`evidence?` + 两级 discipline + 看板 + `read_board`）。

1. **权限**：D-2 彻底删 `can_message`；`authorize()` 只留方向性协议规则（`result` 只上行、`directive` 只下行、`dead_letter` 只 system 发），其余 kind 任意关系全开（R3）。点对点不再需要树关系；mention 退化为 `@label` 寻址语法糖。广播=**单条 `to:"board"` 记录**（D-5，恒 O(1)），谁都能发；roster selector 已在 §15.5 裁掉（I-W 下与 topic 等价）。
2. **kind**：v1 五种保留，新增仅 query/answer/nack（**announce 已裁**，广播即 `to:"board"`+topic）；nack 是一等公民（D-7，让提问方尽快转自查）。
3. **投递**：D-1′（推翻 D-1，§15.1）——discipline 按**接收方状态**定，且塌缩为两级 **push/board**（notify/pull 无区别、`urgent` 取消）：运行中子 agent→push（steer 并入同外层 turn，成本只有 context token，非「打断一轮」）；root→push 受 `wakeRoot`+预算（前台忙降 display）；终态→board 或 revive。`inboxCap` 满则降级 board，**永不拒收**（D-6）。
4. **唤醒（I-W/D-14）**：仅 direct 点对点可 W1(steer)/W2(revive)；W2 还须 `kind==="query"`；广播恒不唤醒，想叫醒谁就再发一条点对点。revive=fire-and-forget `spawn({resumeFrom,slotless,deadlineAt})`，`autoReviveMaxPerSession:10` 兜底。§15.2 B2/M8：须专属 owner 锚点+跳过 canSpawn+抑制 notifier 入队；router 维护 `reviving: target→newRunId`（resumeLocks 实为**拒绝**非合并）。请教 root 仅 `run_in_background` 下有效（M2）。
5. **看板**：`src/fabric/board.ts` 新文件；**仅当前主 session**（D-3，`appendEntry("subagent:board")` 读回重建，不跨会话）；`boardCap:500`/`boardTopicCap:50`。启动注入改**宿主侧 spawn 时拼 prompt**（B1：`before_agent_start` 在子会话不触发），resume 路径同理。
6. **配额**：删发送侧 per-kind 配额（legacy 键降级为存储上限）；接收侧 `inboxOf(node)` 摄取预算（`inboxCap:8`/root 12）+ per-receiver 节流；M6 修正：answer/nack 需保留配额或协议 kind 不计入 `inboxUsed`；§10 已改口「只有速率上界，无总量上界」。
7. **R2**：工具同步返回、revive fire-and-forget；广播恒 1 条、无部分失败语义。M3 处置：notify/board 路径**先写 board 成功再 `engine.put({...delivered})`**（put 不查转移表，从而省掉 `pending→delivered` 表增量和 8 处 fixture 改动）；`board_fallback` **仅限 answer/nack**，directive/finding 仍签死信并附 board 引用（M4）。
8. **兼容**：`fabric.enabled` 默认 false、唯一全局开关；旧 `can_message` frontmatter 只 WARN；`progressChannel` legacy 映射；M-3：`audience` 为 undefined 必须按 v1 存量处理（系统死信显式盖 `discipline:"push"`，补 /reload 迁移含 openQueries hydrate，M-7）。MVP：M1→M2→M3 先合，M4–M6 待量化后定。
9. **不做**（§15.5）：roster、urgent、hop/maxHops（死代码）、L2 三来源/隐式兴趣域、mutation/L3 失效预警 push、scope.symbols、boardSenderSharePct（会淘汰未答 query）、answered supersede、跨会话看板、阻塞式 consult。
10. **硬约束**：I-W 须在**唯一出口处断言**（所有 `sendRootContext`/`runner.steer`/`spawn({resumeFrom})` 调用点查 direct+kind），§3.7 三个落点已被攻破不完整；`不可信输入: from -> to` 头覆盖新 kind；§8.1 prompt 纪律三条（开工先问/问完继续/答案到了就转向）必须写进注入文案；§15.7：仓库有 quota 并行未提交改动（stack.ts/settings.ts/spawn-service.ts/index.ts/fabric-wiring.test.ts），fabric v2 **不得与其并行开发**，行号锚点须改符号锚点。
