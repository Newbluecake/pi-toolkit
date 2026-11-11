import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { LEGACY_BACKUP_RUNBOOK } from "../../src/memory/trash.js";

const root = join(import.meta.dirname, "../..");
test.each(["README.md", "README.en.md"])(
  "%s describes current memory features and restore forms, not retired tidy",
  (file) => {
    const lines = readFileSync(join(root, file), "utf8").split("\n");
    const feature = lines.find((line) => /^\| (?:项目记忆|Project memory)\s*\|/.test(line));
    const command = lines.find((line) => /^\| `\/mem`\s*\|/.test(line));
    expect(feature).toBeDefined();
    expect(command).toBeDefined();
    expect(feature).toContain("blocks");
    expect(feature).not.toMatch(/\btidy\b/);
    expect(command).toContain("restore --trash");
    expect(command).toContain("restore --block");
    expect(command).not.toMatch(/\btidy\b|--legacy/);
  },
);
test("the refusal links to an existing safe-recovery anchor and Web documentation declares an error, not a read success", () => {
  const guide = readFileSync(join(root, "docs/guide/memory.md"), "utf8");
  const url = new URL(LEGACY_BACKUP_RUNBOOK);
  expect(url.pathname).toBe("/Newbluecake/pi-toolkit/blob/dev/docs/guide/memory.md");
  expect(guide).toContain(`<a id="${url.hash.slice(1)}"></a>`);
  for (const step of [
    "1. **停写**",
    "2. **定位真实目录**",
    "3. **完整备份**",
    "4. **只读检查**",
    "5. **独立目录核对**",
    "6. **人工选择性恢复**",
  ])
    expect(guide).toContain(step);
  expect(guide).toContain("不覆盖现有 live 文件");
  expect(guide).toContain("不修改或清理原 journal/manifest/archive");
  const dev = readFileSync(join(root, "docs/dev/memory/README.md"), "utf8");
  expect(dev).toContain("`E_MEM_WEB_UNSUPPORTED`");
  expect(dev).toContain("not successful");
  expect(dev).not.toContain("A bare restore read explains the refusal");
  expect(dev).not.toContain("`restore`/`restore --legacy`/`restore --trash` 列表");
  expect(dev).toContain("不是成功列表");
});
