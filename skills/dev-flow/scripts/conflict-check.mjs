#!/usr/bin/env node
/**
 * conflict-check.mjs — dev-flow 并行包文件域交集预检（零依赖，Node >= 16）
 *
 * 用法：
 *   node conflict-check.mjs spec.json          # 从文件读 spec
 *   echo '<json>' | node conflict-check.mjs -  # 从 stdin 读 spec
 *   node conflict-check.mjs spec.json --cwd /path/to/repo   # 指定仓库根（默认 process.cwd()）
 *   node conflict-check.mjs spec.json --all    # 不忽略 node_modules/.git/dist 等目录
 *
 * spec 格式（JSON 数组，一个元素对应一个并行包）：
 *   [
 *     { "id": "dev:auth", "globs": ["src/auth/**", "src/shared/types.ts"] },
 *     { "id": "dev:pay",  "globs": ["src/pay/**"] }
 *   ]
 *
 * glob 语法：`**` 跨任意层级（含零层）、`*` 单段内任意字符、`?` 单字符；
 * 其余按字面匹配；尾部无通配符的目录路径等价于 `<dir>/**`。
 *
 * 输出：
 *   - 每个包匹配到的文件数
 *   - 两两交集：已存在文件的交集（冲突，exit 1）
 *   - 潜在交集：某包 glob 的字面前缀落在另一包 glob 内（新文件可能撞车，警告）
 * 退出码：0 = 无交集；1 = 存在已存在文件交集；2 = 用法/输入错误。
 */

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const DEFAULT_IGNORES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "coverage",
  ".turbo",
  ".cache",
  "out",
]);

function die(msg) {
  console.error(`conflict-check: ${msg}`);
  process.exit(2);
}

function parseArgs(argv) {
  let specPath = null;
  let cwd = process.cwd();
  let includeAll = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd") cwd = argv[++i];
    else if (a === "--all") includeAll = true;
    else if (a.startsWith("--cwd=")) cwd = a.slice(6);
    else if (a === "-h" || a === "--help") {
      console.log("usage: conflict-check.mjs <spec.json|-> [--cwd DIR] [--all]");
      process.exit(0);
    } else if (!specPath) specPath = a;
    else die(`unknown argument: ${a}`);
  }
  if (!specPath) die("missing spec file (or '-' for stdin)");
  return { specPath, cwd: resolve(cwd), includeAll };
}

function readSpec(specPath) {
  const raw = specPath === "-" ? readFileSync(0, "utf8") : readFileSync(specPath, "utf8");
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (e) {
    die(`invalid JSON: ${e.message}`);
  }
  if (!Array.isArray(spec) || spec.length < 2) die("spec must be an array of >= 2 packages");
  for (const p of spec) {
    if (!p || typeof p.id !== "string" || !Array.isArray(p.globs) || !p.globs.length)
      die('each package needs { "id": string, "globs": [string, ...] }');
  }
  return spec;
}

/** 归一化：正斜杠、去 ./ 前缀与尾部 / */
function normPath(p) {
  return p.split(sep).join("/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** glob → RegExp。返回 { re, literalPrefix } */
function compileGlob(rawGlob) {
  let g = normPath(rawGlob);
  if (!g) die(`empty glob`);
  // 无通配符且指向目录时，展开为 dir/**
  const hasWildcard = /[*?]/.test(g);
  // 字面前缀：第一个通配符之前的部分
  const firstWild = g.search(/[*?]/);
  const literalPrefix = firstWild === -1 ? g : g.slice(0, firstWild).replace(/\/+$/, "");

  let re = "^";
  let i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        // ** 跨层级；`**/` 允许零层
        if (g[i + 2] === "/") {
          re += "(?:[^/]+/)*";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  re += "$";
  return { re: new RegExp(re), literalPrefix, hasWildcard };
}

/** 递归收集文件（相对路径，正斜杠） */
function walk(root, includeAll) {
  const out = [];
  const stack = [""];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!includeAll && DEFAULT_IGNORES.has(e.name)) continue;
        stack.push(rel);
      } else if (e.isFile() || e.isSymbolicLink()) {
        out.push(rel);
      }
    }
  }
  return out;
}

/** glob 是否匹配某路径；无通配符时按「文件本身或目录前缀」处理 */
function matches(compiled, rawGlob, path) {
  if (compiled.re.test(path)) return true;
  if (!compiled.hasWildcard) {
    const g = normPath(rawGlob);
    if (path === g || path.startsWith(g + "/")) return true;
  }
  return false;
}

function main() {
  const { specPath, cwd, includeAll } = parseArgs(process.argv.slice(2));
  if (!existsSync(cwd)) die(`cwd not found: ${cwd}`);
  const spec = readSpec(specPath);
  const files = walk(cwd, includeAll);

  const pkgs = spec.map((p) => ({
    id: p.id,
    globs: p.globs,
    compiled: p.globs.map(compileGlob),
    matched: new Set(),
  }));

  for (const pkg of pkgs) {
    for (const f of files) {
      for (let gi = 0; gi < pkg.compiled.length; gi++) {
        if (matches(pkg.compiled[gi], pkg.globs[gi], f)) {
          pkg.matched.add(f);
          break;
        }
      }
    }
  }

  console.log(`cwd: ${cwd}`);
  for (const pkg of pkgs) {
    console.log(`  ${pkg.id}: ${pkg.matched.size} file(s) matched`);
    if (pkg.matched.size === 0) console.log(`    ⚠ 未匹配到任何已存在文件——若是纯新建包，请确认 glob 前缀正确`);
  }

  let hasConflict = false;
  const warnings = [];

  for (let i = 0; i < pkgs.length; i++) {
    for (let j = i + 1; j < pkgs.length; j++) {
      const A = pkgs[i];
      const B = pkgs[j];

      // 1) 已存在文件交集
      const inter = [...A.matched].filter((f) => B.matched.has(f)).sort();
      if (inter.length) {
        hasConflict = true;
        console.log(`\n✗ 冲突 ${A.id} ∩ ${B.id}（${inter.length} 个文件）:`);
        const shown = inter.slice(0, 50);
        for (const f of shown) console.log(`    ${f}`);
        if (inter.length > shown.length) console.log(`    ... 另有 ${inter.length - shown.length} 个`);
      }

      // 2) 潜在交集：A 某 glob 的字面前缀落在 B 的任一 glob 内（反向亦然）
      //    → A 未来在该前缀下新建的文件会被 B 的 glob 覆盖（或反之）
      const checkPotential = (X, Y) => {
        for (let gi = 0; gi < X.compiled.length; gi++) {
          const prefix = X.compiled[gi].literalPrefix;
          if (!prefix) continue;
          for (let gj = 0; gj < Y.compiled.length; gj++) {
            // 前缀作为「文件」或「目录下的任意文件」去匹配 Y 的 glob
            if (matches(Y.compiled[gj], Y.globs[gj], prefix) || Y.compiled[gj].re.test(prefix + "/__placeholder__")) {
              if (existsSync(join(cwd, prefix))) {
                if (statSync(join(cwd, prefix)).isDirectory()) {
                  warnings.push(
                    `${X.id} 的 glob "${X.globs[gi]}" 前缀 "${prefix}/" 落在 ${Y.id} 的 glob "${Y.globs[gj]}" 内：在该目录新建文件会撞车`,
                  );
                }
                // 前缀是已存在文件：若真撞车，已存在文件交集已报过，不重复警告
              } else {
                warnings.push(
                  `${X.id} 的 glob "${X.globs[gi]}"（"${prefix}" 尚不存在）落在 ${Y.id} 的 glob "${Y.globs[gj]}" 内：${X.id} 创建该路径即撞车`,
                );
              }
            }
          }
        }
      };
      checkPotential(A, B);
      checkPotential(B, A);
    }
  }

  const uniqWarnings = [...new Set(warnings)];
  if (uniqWarnings.length) {
    console.log(`\n⚠ 潜在交集（新建文件可能撞车）:`);
    for (const w of uniqWarnings) console.log(`    - ${w}`);
  }

  console.log("");
  if (hasConflict) {
    console.log(
      `结论: 存在文件交集，禁止同树并行。处置选项：重切文件域 / 改 worktree 隔离 / 热点文件收归主会话 / 串行派发。`,
    );
    process.exit(1);
  }
  if (uniqWarnings.length) {
    console.log(
      `结论: 无已存在文件交集，但有潜在交集。可在各包 prompt 中限定"仅在自己文件域内新建文件"后同树并行，或改用 worktree 隔离。`,
    );
  } else {
    console.log(`结论: 无交集，可同树并行。`);
  }
  process.exit(0);
}

main();
