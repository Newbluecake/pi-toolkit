#!/usr/bin/env node
/**
 * vendor-vue — 校验/刷新 src/traffic/vendor/vue.global.prod.js（traffic-merge T1，替代原仓库的
 * scripts/vendor-check.mjs：Vue 不再是任何 package.json 依赖，锁定凭据是 VENDOR.json 的版本+sha256）。
 *
 *   node scripts/traffic/vendor-vue.mjs                # 校验：文件头版本注释 + sha256 与 VENDOR.json 一致
 *   node scripts/traffic/vendor-vue.mjs --refresh <file> # 从本地 vue.global.prod.js 刷新 vendor 文件并更新 VENDOR.json
 *
 * 刷新来源示例（版本 X.Y.Z 必须与文件头一致）：
 *   npm ci 不动依赖树，直接用临时目录取精确版本：
 *     npm pack vue@3.5.42 --pack-destination /tmp && tar -xzf /tmp/vue-3.5.42.tgz -C /tmp
 *     node scripts/traffic/vendor-vue.mjs --refresh /tmp/package/dist/vue.global.prod.js
 */
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

const vendorDir = new URL("../../src/traffic/vendor/", import.meta.url);
const vuePath = new URL("vue.global.prod.js", vendorDir);
const metaPath = new URL("VENDOR.json", vendorDir);

const meta = JSON.parse(readFileSync(metaPath, "utf8"));
const fail = (msg) => {
  console.error(`vendor-vue 失败：${msg}`);
  process.exit(1);
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const refreshFrom = process.argv[2];
if (refreshFrom === "--refresh") {
  const src = process.argv[3];
  if (!src) fail("--refresh 需要一个 vue.global.prod.js 路径");
  const buf = readFileSync(src);
  const head = buf.subarray(0, 4000).toString("utf8");
  const m = head.match(/vue v(\d+\.\d+\.\d+)/);
  if (!m) fail("源文件头未找到版本注释（期望形如 `* vue v3.x.y`）——不是 vue global build？");
  meta.version = m[1];
  meta.sha256 = sha256(buf);
  copyFileSync(src, vuePath);
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`vendor-vue 刷新完成 — vue@${meta.version}，sha256=${meta.sha256}`);
  process.exit(0);
}
if (refreshFrom !== undefined) fail(`未知参数 "${refreshFrom}"（仅支持 --refresh <file>）`);

const buf = readFileSync(vuePath);
const head = buf.subarray(0, 4000).toString("utf8");
const m = head.match(/vue v(\d+\.\d+\.\d+)/);
if (!m) fail("vendor 文件头未找到版本注释");
if (m[1] !== meta.version) {
  fail(`版本不一致 — VENDOR.json=${meta.version}，vendor 文件头=${m[1]}。`);
}
const actual = sha256(buf);
if (actual !== meta.sha256) {
  fail(`sha256 不一致 — VENDOR.json=${meta.sha256}，实际=${actual}（文件被改动过？用 --refresh 重新锁定）`);
}
console.log(`vendor-vue OK — vue@${meta.version} sha256=${actual} 与 VENDOR.json 一致`);
