// §7.3 step 6 unified diff rendering (UI-only — never enters the session
// context, §7.3) — todo #22 P4. Line-level LCS diff for small files; a
// file over the size/line bound degrades to a whole-file replace view
// (avoids O(n*m) LCS blowing up on a 16KB+ file).

const MAX_DIFF_BYTES = 16_384;
const MAX_DIFF_LINES = 400;

function lcsTable(a: readonly string[], b: readonly string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const rowI = table[i];
    const rowI1 = table[i + 1];
    if (!rowI || !rowI1) continue;
    for (let j = m - 1; j >= 0; j--) {
      rowI[j] = a[i] === b[j] ? (rowI1[j + 1] ?? 0) + 1 : Math.max(rowI1[j] ?? 0, rowI[j + 1] ?? 0);
    }
  }
  return table;
}

type DiffOp = { kind: "same" | "add" | "del"; line: string };

function lcsDiff(a: readonly string[], b: readonly string[]): DiffOp[] {
  const table = lcsTable(a, b);
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", line: a[i] ?? "" });
      i++;
      j++;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      ops.push({ kind: "del", line: a[i] ?? "" });
      i++;
    } else {
      ops.push({ kind: "add", line: b[j] ?? "" });
      j++;
    }
  }
  while (i < a.length) {
    ops.push({ kind: "del", line: a[i] ?? "" });
    i++;
  }
  while (j < b.length) {
    ops.push({ kind: "add", line: b[j] ?? "" });
    j++;
  }
  return ops;
}

function wholeFileReplace(before: string, after: string): string {
  const lines: string[] = ["--- before (whole-file replace view — too large for a line diff)", "+++ after"];
  for (const l of before.split("\n")) lines.push(`-${l}`);
  for (const l of after.split("\n")) lines.push(`+${l}`);
  return lines.join("\n");
}

/**
 * Render a unified-style diff between `before` and `after`. Files whose
 * combined size exceeds `MAX_DIFF_BYTES` or whose line count exceeds
 * `MAX_DIFF_LINES` degrade to a whole-file "every old line removed, every
 * new line added" view rather than paying for full LCS on a large input.
 */
export function renderTidyDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const combinedBytes = Buffer.byteLength(before, "utf8") + Buffer.byteLength(after, "utf8");
  if (combinedBytes > MAX_DIFF_BYTES || a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return wholeFileReplace(before, after);
  }
  const ops = lcsDiff(a, b);
  const out: string[] = [];
  for (const op of ops) {
    if (op.kind === "same") out.push(` ${op.line}`);
    else if (op.kind === "del") out.push(`-${op.line}`);
    else out.push(`+${op.line}`);
  }
  return out.join("\n");
}
