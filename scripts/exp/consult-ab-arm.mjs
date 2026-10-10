#!/usr/bin/env node
/**
 * consult A/B 确定性抽签（docs/dev/consult/ab-instrumentation-plan.md §5 P3 / §7 D2）。
 *
 *   node scripts/exp/consult-ab-arm.mjs <packageId> [--salt consult-ab-v1]
 *
 * 规则：sha256(salt + "\0" + packageId) 首字节的最低位，1 ⇒ experts，0 ⇒ control。
 * 同一个 (packageId, salt) 恒定同一臂，事后可复算；输出只有一行 `experts` 或 `control`。
 * packageId 必须能过工具层 parseDispatchMeta 的格式校验（否则永远入不了组，抽签无意义）。
 */
import { armFor, DEFAULT_SALT, DISPATCH_META_ID_RE } from "./consult-ab-lib.mjs";
import { writeSync } from "node:fs";

function usage(out) {
  out.write(
    `usage: node scripts/exp/consult-ab-arm.mjs <packageId> [--salt <salt>]\n` +
      `  deterministic per-package arm: lowest bit of the first byte of\n` +
      `  sha256(salt + "\\0" + packageId); 1 => experts, 0 => control\n` +
      `  --salt  hashing salt (default: ${DEFAULT_SALT})\n`,
  );
}

const args = process.argv.slice(2);
let packageId;
let salt = DEFAULT_SALT;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--salt") {
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      console.error("error: --salt requires a value");
      usage(process.stderr);
      process.exit(2);
    }
    salt = next;
    i++;
  } else if (arg === "--help" || arg === "-h") {
    usage(process.stdout);
    process.exit(0);
  } else if (packageId === undefined) {
    packageId = arg;
  } else {
    console.error(`error: unexpected argument ${arg}`);
    usage(process.stderr);
    process.exit(2);
  }
}

if (packageId === undefined) {
  usage(process.stderr);
  process.exit(2);
}
if (!DISPATCH_META_ID_RE.test(packageId)) {
  console.error(
    `error: packageId ${JSON.stringify(packageId)} fails the dispatch-meta id pattern ` +
      `${DISPATCH_META_ID_RE.source} — it could never be enrolled via Agent({ meta })`,
  );
  process.exit(2);
}

// stdout 单行输出，供主会话直接读取
writeSync(1, `${armFor(packageId, salt)}\n`);
