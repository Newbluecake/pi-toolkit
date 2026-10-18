# consult 锚点 P0 实测结果（cache-thread-plan §2）

> 生成：`node scripts/exp/consult-anchor-probe.mjs`（报告模式 `--report`），原始记录在运行输出目录的 `<route>.json`（仅 token 数 / 长度 / 断点路径，无消息正文、无凭据）。
> 总花费（全部请求、全部路线）：**$3.57**，请求数 83，硬上限 $5。

## 路线 `cr-anthropic/claude-sonnet-5`

- 价格 $/M：输入 3 / 输出 15 / 读 0.3 / 写 3.75；本路线花费 $1.5885（矩阵请求；另有约 $0.26 失败探测请求计入总账 $1.853）；矩阵：full；run E1DA90
- 历史 H：2 段（每段用户文本 ≈ 9.2k tok 目标；校准 1.968 chars/token）；R-gen 末次请求总输入 |H| = **26301** tok（各 R-gen 请求总输入：15111, 26301）；末条 assistant 块 = [thinking,text]，thinking 签名长度 = [6484,4844]，末条输出 1866 tok。
- 锚点坐标（宿主可信坐标）：messages[3].content[1]（text，跳过 thinking）。
- M3 工具回合：12 对真实 tool_use/tool_result（25 条消息，锚点之后共 27 个内容块，其中 thinking 块 2 个）。

### 通过线判定

| 格                    | 结果 | 数值（含阈值计算）                                                                                                                                                                                                                                              |
| --------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1                    | PASS | HTTP 200; cacheRead+cacheWrite = 28177 vs 0.95\|H\| = 24986                                                                                                                                                                                                     |
| M2                    | PASS | R2 cacheRead = 28152 ≥ 24986: true; control R2c cacheRead = 6207 ≤ S+0.05\|H\| = 7522: true                                                                                                                                                                     |
| M5                    | PASS | H last assistant blocks = [thinking,text], signature lengths = [6484,4844]; R2 HTTP 200; M2 line met                                                                                                                                                            |
| M3 (window exists)    | PASS | R3 (28 content blocks after the anchor block) cacheRead = 6174 ≤ S+0.05\|H\| = 7489: true                                                                                                                                                                       |
| M3′ (replayed anchor) | PASS | R3′ cacheRead = 28118 ≥ 0.95\|H\| = 24986: true                                                                                                                                                                                                                 |
| M6                    | PASS | P1: cacheRead = 28153 ≥ 24986: true; cacheWrite = 0 ≤ 78 (tail≈14 tok + 64): true; P2: cacheRead = 28153 ≥ 24986: true; cacheWrite = 0 ≤ 78 (tail≈14 tok + 64): true; R6: cacheRead = 28153 ≥ 24986: true; control R6c cacheRead = 0 ≤ S+0.05\|H\| = 7502: true |
| M7                    | PASS | ttl:1h write: cacheWrite = 3535, ephemeral_1h = 3535, ephemeral_5m = 0 → 1h LANDED (landing check only, full shape NOT run on this route — inheritance not established)                                                                                         |
| M4 OAuth 4 断点       | N/A  | 本环境没有 OAuth 的 Anthropic 路线（auth.json 只有 api_key 型，上述路线均为内联 API key）⇒ OAuth 一律按 §3.4 显示 `degraded`                                                                                                                                    |

### 逐请求记录

| t(s)  | 格/请求                                         | HTTP | input | cacheRead | cacheWrite | output | $        | 块数 | 断点                                                                 |
| ----- | ----------------------------------------------- | ---- | ----- | --------- | ---------- | ------ | -------- | ---- | -------------------------------------------------------------------- |
| 0     | P0/calibrate                                    | 200  | 10173 | 0         | 0          | 1      | 0.030534 | 1    | none                                                                 |
| 2.3   | P0/rgen-0                                       | 200  | 8886  | 0         | 6222       | 12000  | 0.22999  | 1    | system[0], tools[0]                                                  |
| 97.1  | P0/rgen-0-retry1                                | 200  | 8889  | 6222      | 0          | 2350   | 0.063784 | 1    | system[0], tools[0]                                                  |
| 120.1 | P0/rgen-1                                       | 200  | 20079 | 6222      | 0          | 1866   | 0.090094 | 4    | system[0], tools[0]                                                  |
| 135.8 | P0/rgen-tool-1                                  | 200  | 2     | 6222      | 22020      | 88     | 0.085768 | 7    | system[0], tools[0], messages[4].content[0]                          |
| 139.7 | P0/rgen-tool-2                                  | 200  | 2     | 28242     | 107        | 57     | 0.009735 | 10   | system[0], tools[0], messages[6].content[0]                          |
| 145.5 | P0/rgen-tool-3                                  | 200  | 2     | 28349     | 78         | 45     | 0.009478 | 13   | system[0], tools[0], messages[8].content[0]                          |
| 152.7 | P0/rgen-tool-4                                  | 200  | 2     | 28427     | 63         | 45     | 0.009445 | 15   | system[0], tools[0], messages[10].content[0]                         |
| 155.9 | P0/rgen-tool-5                                  | 200  | 2     | 28490     | 65         | 45     | 0.009472 | 17   | system[0], tools[0], messages[12].content[0]                         |
| 158.8 | P0/rgen-tool-6                                  | 200  | 2     | 28555     | 65         | 45     | 0.009491 | 19   | system[0], tools[0], messages[14].content[0]                         |
| 161.6 | P0/rgen-tool-7                                  | 200  | 2     | 28620     | 67         | 45     | 0.009518 | 21   | system[0], tools[0], messages[16].content[0]                         |
| 164.3 | P0/rgen-tool-8                                  | 200  | 2     | 28687     | 64         | 45     | 0.009527 | 23   | system[0], tools[0], messages[18].content[0]                         |
| 166.9 | P0/rgen-tool-9                                  | 200  | 2     | 28751     | 65         | 45     | 0.00955  | 25   | system[0], tools[0], messages[20].content[0]                         |
| 169.4 | P0/rgen-tool-10                                 | 200  | 2     | 28816     | 65         | 45     | 0.00957  | 27   | system[0], tools[0], messages[22].content[0]                         |
| 172.2 | P0/rgen-tool-11                                 | 200  | 2     | 28881     | 69         | 45     | 0.009604 | 29   | system[0], tools[0], messages[24].content[0]                         |
| 174.7 | P0/rgen-tool-12                                 | 200  | 2     | 28950     | 65         | 45     | 0.00961  | 31   | system[0], tools[0], messages[26].content[0]                         |
| 177.3 | M6/R0-sys                                       | 200  | 76    | 0         | 6209       | 1      | 0.023527 | 1    | system[0], tools[0]                                                  |
| 177.3 | M1M2M5/R0-sys                                   | 200  | 76    | 0         | 6208       | 1      | 0.023523 | 1    | system[0], tools[0]                                                  |
| 179.7 | M6c/R0-sys                                      | 200  | 76    | 0         | 6187       | 1      | 0.023444 | 1    | system[0], tools[0]                                                  |
| 179.8 | M1M2M5/R1(anchor+last@Q1)                       | 200  | 2     | 0         | 28177      | 4      | 0.10573  | 7    | system[0], tools[0], messages[3].content[1], messages[4].content[0]  |
| 181.6 | M6c/R1c(anchor+last@Q1)                         | 200  | 2     | 0         | 28156      | 4      | 0.105651 | 7    | system[0], tools[0], messages[3].content[1], messages[4].content[0]  |
| 181.6 | M6/R1(anchor+last@Q1)                           | 200  | 2     | 0         | 28178      | 4      | 0.105733 | 7    | system[0], tools[0], messages[3].content[1], messages[4].content[0]  |
| 242.8 | M1M2M5/R2(default bp, Q2)                       | 200  | 2     | 28152     | 25         | 4      | 0.008605 | 7    | system[0], tools[0], messages[4].content[0]                          |
| 245.8 | M2ctl/R0-sys                                    | 200  | 76    | 0         | 6207       | 1      | 0.023519 | 1    | system[0], tools[0]                                                  |
| 248.6 | M2ctl/R1c(last@Q1 only)                         | 200  | 2     | 0         | 28176      | 4      | 0.105726 | 7    | system[0], tools[0], messages[4].content[0]                          |
| 312   | M2ctl/R2c(default bp, Q2)                       | 200  | 2     | 6207      | 21969      | 4      | 0.084312 | 7    | system[0], tools[0], messages[4].content[0]                          |
| 315.3 | M3/R0-sys                                       | 200  | 76    | 0         | 6174       | 1      | 0.023395 | 1    | system[0], tools[0]                                                  |
| 317.3 | M3/R1(anchor+last@Q1)                           | 200  | 2     | 0         | 28143      | 4      | 0.105602 | 7    | system[0], tools[0], messages[3].content[1], messages[4].content[0]  |
| 319.8 | M3/R3(default bp, >20 blocks)                   | 200  | 2     | 6174      | 22884      | 4      | 0.087733 | 34   | system[0], tools[0], messages[28].content[1]                         |
| 322.1 | M3/R3'(anchor replayed)                         | 200  | 2     | 28118     | 941        | 4      | 0.01203  | 34   | system[0], tools[0], messages[3].content[1], messages[28].content[1] |
| 325.3 | M7/landing(ttl 1h)                              | 200  | 2     | 0         | 3535       | 1      | 0.013277 | 1    | messages[0].content[0]@1h                                            |
| 424.8 | M6/P1(+240s, early-abort) ⚡abort@message_start | 200  | 20    | 28153     | 0          | 9      | 0.008641 | 7    | system[0], tools[0], messages[3].content[1]                          |
| 664.8 | M6/P2(+480s, early-abort) ⚡abort@message_start | 200  | 20    | 28153     | 0          | 9      | 0.008641 | 7    | system[0], tools[0], messages[3].content[1]                          |
| 784.9 | M6c/R6c(+600s, no pings)                        | 200  | 2     | 0         | 28156      | 4      | 0.105651 | 7    | system[0], tools[0], messages[4].content[0]                          |
| 784.9 | M6/R6(+600s, H+Q6)                              | 200  | 2     | 28153     | 25         | 4      | 0.008606 | 7    | system[0], tools[0], messages[4].content[0]                          |

## 路线 `cr-anthropic/claude-opus-5-5`

- 价格 $/M：输入 4 / 输出 20 / 读 0.2 / 写 5；本路线花费 $1.7165；矩阵：full；run AC2F02
- 历史 H：2 段（每段用户文本 ≈ 9.2k tok 目标；校准 1.868 chars/token）；R-gen 末次请求总输入 |H| = **24285** tok（各 R-gen 请求总输入：15048, 24285）；末条 assistant 块 = [thinking,text]，thinking 签名长度 = [1420,1228]，末条输出 347 tok。
- 锚点坐标（宿主可信坐标）：messages[3].content[1]（text，跳过 thinking）。
- M3 工具回合：12 对真实 tool_use/tool_result（25 条消息，锚点之后共 25 个内容块，其中 thinking 块 0 个）。

### 通过线判定

| 格                         | 结果 | 数值（含阈值计算）                                                                                                                                                                                                                                              |
| -------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1                         | PASS | HTTP 200; cacheRead+cacheWrite = 24635 vs 0.95\|H\| = 23071                                                                                                                                                                                                     |
| M2                         | PASS | R2 cacheRead = 24610 ≥ 23071: true; control R2c cacheRead = 6137 ≤ S+0.05\|H\| = 7351: true                                                                                                                                                                     |
| M5                         | PASS | H last assistant blocks = [thinking,text], signature lengths = [1420,1228]; R2 HTTP 200; M2 line met                                                                                                                                                            |
| M3 (window exists)         | PASS | R3 (26 content blocks after the anchor block) cacheRead = 6135 ≤ S+0.05\|H\| = 7349: true                                                                                                                                                                       |
| M3′ (replayed anchor)      | PASS | R3′ cacheRead = 24619 ≥ 0.95\|H\| = 23071: true                                                                                                                                                                                                                 |
| M6                         | PASS | P1: cacheRead = 24671 ≥ 23071: true; cacheWrite = 0 ≤ 78 (tail≈14 tok + 64): true; P2: cacheRead = 24671 ≥ 23071: true; cacheWrite = 0 ≤ 78 (tail≈14 tok + 64): true; R6: cacheRead = 24671 ≥ 23071: true; control R6c cacheRead = 0 ≤ S+0.05\|H\| = 7368: true |
| M7 (all-1h anchored shape) | PASS | R1 (all breakpoints ttl 1h): HTTP 200, cacheWrite = 24931, ephemeral_1h = 24931, ephemeral_5m = 0 (1h share ≥95%: true); R2 (all 1h, default shape) cacheRead = 24907 ≥ 0.95\|H\| = 23251: true. Survival beyond 5 min is NOT measured here.                    |
| M4 OAuth 4 断点            | N/A  | 本环境没有 OAuth 的 Anthropic 路线（auth.json 只有 api_key 型，上述路线均为内联 API key）⇒ OAuth 一律按 §3.4 显示 `degraded`                                                                                                                                    |

### 逐请求记录

| t(s)  | 格/请求                                         | HTTP | input | cacheRead | cacheWrite | output | $        | 块数 | 断点                                                                      |
| ----- | ----------------------------------------------- | ---- | ----- | --------- | ---------- | ------ | -------- | ---- | ------------------------------------------------------------------------- |
| 0     | P0/calibrate                                    | 200  | 10718 | 0         | 0          | 1      | 0.042892 | 1    | none                                                                      |
| 3.9   | P0/rgen-0                                       | 200  | 8902  | 0         | 6146       | 407    | 0.074478 | 1    | system[0], tools[0]                                                       |
| 10.6  | P0/rgen-1                                       | 200  | 18139 | 6146      | 0          | 347    | 0.080725 | 4    | system[0], tools[0]                                                       |
| 17.1  | P0/rgen-tool-1                                  | 200  | 4     | 6146      | 18560      | 45     | 0.094945 | 7    | system[0], tools[0], messages[4].content[0]                               |
| 20.3  | P0/rgen-tool-2                                  | 200  | 2     | 24706     | 68         | 45     | 0.006189 | 9    | system[0], tools[0], messages[6].content[0]                               |
| 23.3  | P0/rgen-tool-3                                  | 200  | 2     | 24774     | 65         | 45     | 0.006188 | 11   | system[0], tools[0], messages[8].content[0]                               |
| 26.2  | P0/rgen-tool-4                                  | 200  | 2     | 24839     | 66         | 45     | 0.006206 | 13   | system[0], tools[0], messages[10].content[0]                              |
| 29.3  | P0/rgen-tool-5                                  | 200  | 2     | 24905     | 67         | 45     | 0.006224 | 15   | system[0], tools[0], messages[12].content[0]                              |
| 32.2  | P0/rgen-tool-6                                  | 200  | 2     | 24972     | 65         | 45     | 0.006227 | 17   | system[0], tools[0], messages[14].content[0]                              |
| 37.4  | P0/rgen-tool-7                                  | 200  | 2     | 25037     | 65         | 45     | 0.00624  | 19   | system[0], tools[0], messages[16].content[0]                              |
| 41.8  | P0/rgen-tool-8                                  | 200  | 2     | 25102     | 64         | 45     | 0.006248 | 21   | system[0], tools[0], messages[18].content[0]                              |
| 44.9  | P0/rgen-tool-9                                  | 200  | 2     | 25166     | 64         | 45     | 0.006261 | 23   | system[0], tools[0], messages[20].content[0]                              |
| 47.8  | P0/rgen-tool-10                                 | 200  | 2     | 25230     | 64         | 45     | 0.006274 | 25   | system[0], tools[0], messages[22].content[0]                              |
| 50.6  | P0/rgen-tool-11                                 | 200  | 2     | 25294     | 67         | 45     | 0.006302 | 27   | system[0], tools[0], messages[24].content[0]                              |
| 53.6  | P0/rgen-tool-12                                 | 200  | 2     | 25361     | 64         | 45     | 0.0063   | 29   | system[0], tools[0], messages[26].content[0]                              |
| 56.4  | M6/R0-sys                                       | 200  | 78    | 0         | 6187       | 1      | 0.031267 | 1    | system[0], tools[0]                                                       |
| 56.4  | M1M2M5/R0-sys                                   | 200  | 78    | 0         | 6126       | 1      | 0.030962 | 1    | system[0], tools[0]                                                       |
| 60.7  | M1M2M5/R1(anchor+last@Q1)                       | 200  | 4     | 6126      | 18509      | 4      | 0.093866 | 7    | system[0], tools[0], messages[3].content[1], messages[4].content[0]       |
| 60.6  | M6c/R0-sys                                      | 200  | 78    | 0         | 6154       | 1      | 0.031102 | 1    | system[0], tools[0]                                                       |
| 64.2  | M6c/R1c(anchor+last@Q1)                         | 200  | 4     | 6154      | 18509      | 4      | 0.093872 | 7    | system[0], tools[0], messages[3].content[1], messages[4].content[0]       |
| 64.2  | M6/R1(anchor+last@Q1)                           | 200  | 4     | 6187      | 18509      | 4      | 0.093878 | 7    | system[0], tools[0], messages[3].content[1], messages[4].content[0]       |
| 124.3 | M1M2M5/R2(default bp, Q2)                       | 200  | 4     | 24610     | 25         | 4      | 0.005143 | 7    | system[0], tools[0], messages[4].content[0]                               |
| 128.3 | M2ctl/R0-sys                                    | 200  | 78    | 0         | 6137       | 1      | 0.031017 | 1    | system[0], tools[0]                                                       |
| 131.4 | M2ctl/R1c(last@Q1 only)                         | 200  | 4     | 6137      | 18509      | 4      | 0.093868 | 7    | system[0], tools[0], messages[4].content[0]                               |
| 199.6 | M2ctl/R2c(default bp, Q2)                       | 200  | 4     | 6137      | 18509      | 4      | 0.093868 | 7    | system[0], tools[0], messages[4].content[0]                               |
| 203.5 | M3/R0-sys                                       | 200  | 78    | 0         | 6135       | 1      | 0.031007 | 1    | system[0], tools[0]                                                       |
| 207.1 | M3/R1(anchor+last@Q1)                           | 200  | 4     | 6135      | 18509      | 4      | 0.093868 | 7    | system[0], tools[0], messages[3].content[1], messages[4].content[0]       |
| 212.4 | M3/R3(default bp, >20 blocks)                   | 200  | 4     | 6135      | 19370      | 32     | 0.098733 | 32   | system[0], tools[0], messages[28].content[1]                              |
| 217.2 | M3/R3'(anchor replayed)                         | 200  | 4     | 24619     | 887        | 32     | 0.010015 | 32   | system[0], tools[0], messages[3].content[1], messages[28].content[1]      |
| 221.8 | M7/landing(ttl 1h)                              | 200  | 4     | 0         | 3523       | 1      | 0.017651 | 1    | messages[0].content[0]@1h                                                 |
| 308.2 | M6/P1(+240s, early-abort) ⚡abort@message_start | 200  | 22    | 24671     | 0          | 2      | 0.005062 | 7    | system[0], tools[0], messages[3].content[1]                               |
| 548.1 | M6/P2(+480s, early-abort) ⚡abort@message_start | 200  | 22    | 24671     | 0          | 4      | 0.005102 | 7    | system[0], tools[0], messages[3].content[1]                               |
| 668.2 | M6c/R6c(+600s, no pings)                        | 200  | 4     | 0         | 24663      | 4      | 0.123411 | 7    | system[0], tools[0], messages[4].content[0]                               |
| 668.2 | M6/R6(+600s, H+Q6)                              | 200  | 4     | 24671     | 25         | 4      | 0.005155 | 7    | system[0], tools[0], messages[4].content[0]                               |
| 0     | P0/calibrate                                    | 200  | 10716 | 0         | 0          | 1      | 0.042884 | 1    | none                                                                      |
| 3.8   | P0/rgen-0                                       | 200  | 8894  | 0         | 6137       | 625    | 0.078761 | 1    | system[0], tools[0]                                                       |
| 12.4  | P0/rgen-1                                       | 200  | 18338 | 6137      | 0          | 442    | 0.083419 | 4    | system[0], tools[0]                                                       |
| 21.6  | M7b/R0-sys                                      | 200  | 78    | 0         | 6129       | 1      | 0.030977 | 1    | system[0], tools[0]                                                       |
| 26.7  | M7b/R1(all bp ttl 1h, anchor+last@Q1)           | 200  | 4     | 0         | 24931      | 4      | 0.124751 | 7    | system[0], tools[0], messages[3].content[1]@1h, messages[4].content[0]@1h |
| 90.5  | M7b/R2(all bp ttl 1h, default, Q2)              | 200  | 4     | 24907     | 24         | 4      | 0.005197 | 7    | system[0], tools[0], messages[4].content[0]@1h                            |

## 判决（§2 停止规则）

**VERDICT** (a) 锚点（M1/M2/M5）：cr-anthropic/claude-sonnet-5: PASS； cr-anthropic/claude-opus-5-5: PASS

- (a) 必测路线 opus-5-5：存活（M1/M2/M5 全过）
- R3′ 逐请求重放锚点（M3）：cr-anthropic/claude-sonnet-5: PASS； cr-anthropic/claude-opus-5-5: PASS
- (c) 保活（M6）：cr-anthropic/claude-sonnet-5: PASS； cr-anthropic/claude-opus-5-5: PASS
- M7 1h 继承：cr-anthropic/claude-sonnet-5: PASS； cr-anthropic/claude-opus-5-5: PASS（FAIL = 1h 未落地 ⇒ N/A，不允许继承 1h）
- M4：N/A（无 OAuth 路线）

总花费 **$3.57** / 上限 $5。

## 方法说明与披露

- **|H| 取 §2 字面定义**：最后一次 R-gen 请求的 `input + cacheRead + cacheWrite`（含 system+tools 的 S，不含末条 assistant 自己的输出 token）。被测请求实际总输入略大于 |H|（含末条 assistant + 问题），因此 `≥ 0.95|H|` 线偏宽松、`≤ S+0.05|H|` 线偏严格，数值见上表。S = 每格开头的 R0（只有 system+tools 断点、无 thinking）写入的 cacheWrite，即可缓存的 system+tools 前缀 token 数。
- **每格 R0 为脚本额外加的一个请求**（矩阵未列）：只为精确测 S。它不带 thinking；在 sonnet-5 上从 thinking 请求读不到它写的 system 条目（R1 的 cacheRead=0），在 opus-5-5 上读得到——不影响任何通过线（M1 看 read+write 之和，对照用 S 做上界），但说明 sonnet-5 的 system 条目按 thinking 开关分命名空间。
- **隔离**：每个格子/对照组用独立 nonce 打头 system（等长填充），R-gen 与 tool 回合在另一个 gen nonce 下生成，所以任何格子的消息前缀都没有任何既有条目；R-gen 的 user 段不带消息级断点。同一份历史 H（真实 thinking 签名）在各格子复用。
- **断点形状**：anchored R1 = {system, tools, 锚@H 末 text 块（跳过 thinking）, last@Q1}（共 4 个，非 OAuth）；R2/R3/R6 = pi 默认 {system, tools, last}；R3′ = 默认 + 锚；M6 的 P1/P2 = §6.4 的 ping 形状：H（保留锚断点）+ 固定短尾（无断点），system/tools/thinking 原样，**收到 message_start 即中止**（与生产保活同一路径），P1/P2 的 cacheWrite = 0。请求头：`x-api-key`、`anthropic-version`、tools 存在时的 `anthropic-beta: fine-grained-tool-streaming-2025-05-14`（pi 对该路线同样发送）。thinking = `{type:adaptive,display:summarized}` + `output_config.effort=medium`（pi 对 forceAdaptiveThinking 路线的形状）。
- **M3 的 20 块窗口**：R3 的 messages 在锚点之后有 26（opus）/ 28（sonnet）个内容块（12 对真实 tool_use/tool_result + 问句 + 末条追加问题），超过 20 块回看窗口；R3 只读到 S，证明窗口确实存在。
- **M4**：本环境没有 OAuth 的 Anthropic 路线 ⇒ N/A，OAuth 线路 relocated 在显示上按 §3.4 一律 `degraded`。
- **M7 说明**：opus-5-5 做了完整形状（所有断点 ttl 1h）+ 1h 读回，1h 写在 usage 拆分里真实落地（`ephemeral_1h_input_tokens` = 全部写入）。**这与记忆里「cr-anthropic ttl:1h 写出 0 条 1h 条目」的旧结论不一致**——线路行为可能已变，或此前的统计口径不同；本次**没有**测 5 min 之后的 1h 存活（记忆称约 20–25 min 就死），所以 M7 PASS 只证明「落地并可在 TTL 内读回」，是否值得默认继承 1h 仍需单独的存活实验。sonnet-5 只做了 3.5k tok 的落地检查（未做完整形状）。
- **sonnet-5 的填充文本**：这条线路对「音节/单词沙拉」填充会返回 `stop_reason: refusal`（0 输出），所以 sonnet-5 的历史用日志形状的填充（`--filler logs`），opus-5-5 用音节填充；这些失败的探测请求（约 $0.26）已计入总花费。sonnet-5 的 R-gen 第一次尝试把 12000 max_tokens 全花在 thinking 上（$0.23），重试后成功。
- 表中同一路线下第二组 `P0/calibrate…M7b/…` 行是 `--matrix m7` 的补充运行（M7 完整形状，独立 R-gen 与 nonce）。
- 脚本的 `--report` 模式从各路线 JSON（仅 token/长度/断点路径）生成本文件；凭据只在进程内存里，不打印、不落盘。

## 验收记录（r_C4VSFHPP，DeepSeek v4 pro，有条件通过）

逐格 PASS/FAIL 已由验收方从原始记录按 §2 阈值独立重算，全部吻合；`--report` 只读重生成一致；凭据零命中。跟进已处理：sonnet M7 行改为「仅落地检查，不构成继承依据」；sonnet 路线花费补注失败探测请求差额。M4（OAuth）脚本未实现，本环境 N/A。1h 存活（>5 min）未测，是否默认继承 1h 另做存活实验。
