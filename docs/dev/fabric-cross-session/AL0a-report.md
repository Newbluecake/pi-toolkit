# AL0a 报告：别名规则包（纯规则）

## 改动文件

- `src/web-hub/protocol/xs-alias.ts`（新，零 import，无 Node API）
- `tests/fixtures/xs-alias-corpus.json`（新，135 条 normalize 用例〔41 合法 / 94 拒绝〕+ 16 对骨架相等 + 8 对骨架不等 + 保留词正反例 + token 正反例）
- `tests/web-hub/protocol/xs-alias.test.ts`（新，144 个测试）

## 导出符号

```ts
XS_ALIAS_SKELETON_VERSION = 1; XS_ALIAS_MIN_GRAPHEMES = 1; XS_ALIAS_MAX_GRAPHEMES = 16; XS_ALIAS_MAX_BYTES = 48
type XsAliasRejectReason = "invalid" | "too_long" | "id_like" | "reserved"
type XsAliasNormalizeResult = {ok:true; alias; skeleton} | {ok:false; reason}
normalizeAlias(input: unknown, opts?: {stripAt?: boolean /*默认 true*/}): XsAliasNormalizeResult
aliasSkeleton(canonical: string): string
aliasGraphemeCount(s: string): number
isReservedAlias(canonical: string): boolean
XS_RESERVED_ALIASES: readonly string[]; XS_RESERVED_ALIAS_PREFIXES = ["pi-","r_","wf_"]
XS_ALIAS_TAKE_TOKEN_RE = /^k[0-9a-f]{16}$/
XS_ALIAS_TAKE_CONFIRM_RE   // 单行：确认抢占请执行：/fabric alias <alias> --take=<token>（5 分钟内有效）
formatTakeConfirmLine(alias, token): string
parseTakeConfirm(output: string): {alias, token} | undefined   // 仅取最后一个非空行，别名须为规范形
```

## 实现要点

- 顺序严格按 §2.1：剥一个 `@` → NFKC（+幂等断言）→ 逐码点拒绝（Default_Ignorable/C/M/White_Space、Jamo 各块与填充符、VS、Bidi）→ 白名单 → ASCII 小写 → 字形簇 1–16（`Intl.Segmenter`，缺失时退化为码点数）且 ≤48 字节 → 含 `\p{L}`、首字符非 `_ - ー` → id_like → reserved。
- 因此纯数字（如 `12345678`）报 `invalid`（第 7 步先于第 8 步），`q`+18 位十六进制报 `too_long`。
- 骨架：0→o、1→l、_→-、〇/口/ロ→o、ー/一/－/—→-、丨→l；不收 CJK↔CJK。
- 保留词为频道保留名 ∪ 方案列出词；测试里与 `XS_RESERVED_CHANNELS`（src/fabric）对拍，确保超集（protocol 不得 import 它，故拷贝 + 测试钉住）。
- `parseTakeConfirm` 只认最后一行，防止输出中前置伪造行注入 token。

## 偏离 / 注意

1. 骨架额外加了 `i→l`（任务说明提到 1/l/i；方案 §2.2 只写 1→l）。更保守（多拒），如要严格按方案删一行即可，需同步语料。
2. Han/假名白名单在 `\p{Script=…}` 之上再限制为 `\p{L}`（Han 另含 `\p{Nl}` 以放行 〇），拒绝 CJK 部首补充区等符号类字符；比方案更严。
3. NFKC 会把「か+U+3099」组合成「が」、把 Jamo 序列组合成音节，这些结果合法被接受（Jamo 单独/填充符仍拒）。
4. 纯 `a`×16 等全十六进制字符会被判 `id_like`；边界用例用 `g`。
5. `normalizeAlias` 默认剥 `@`；`message_session.to` 路径（A4 要求仍拒 `@`）调用时应传 `{stripAt:false}`——AL5a 注意。

## 自验

- `npx vitest run tests/web-hub/protocol tests/web-hub/boundary.test.ts tests/web-hub/protocol/xs-alias.test.ts --maxWorkers=3` → 44 files passed，1627 passed | 3 skipped（含 boundary）
- `npm run typecheck` → 通过（tsc ×2 + vue-tsc 无输出错误）
- `npx prettier --check` 三个新文件 → All matched files use Prettier code style
