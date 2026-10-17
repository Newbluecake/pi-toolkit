/*
 * QR Code generator library (TypeScript)
 *
 * Copyright (c) Project Nayuki. (MIT License)
 * https://www.nayuki.io/page/qr-code-generator-library
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 * - The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 * - The Software is provided "as is", without warranty of any kind, express or
 *   implied, including but not limited to the warranties of merchantability,
 *   fitness for a particular purpose and noninfringement. In no event shall the
 *   authors or copyright holders be liable for any claim, damages or other
 *   liability, whether in an action of contract, tort or otherwise, arising from,
 *   out of or in connection with the Software or the use or other dealings in the
 *   Software.
 */

// Adapted from Nayuki QR-Code-generator commit
// 3c6d0b3cefb4e049dc337e82237c9644399716a8, typescript-javascript/qrcodegen.ts.
// Reduced, adapted implementation: byte mode, ECC Low, fixed legal mask 0.
// No namespace, parameter properties, runtime imports, or terminal escape codes.
const ECC = [
  -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30,
  30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
];
const BLOCKS = [
  -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19,
  19, 20, 21, 22, 24, 25,
];
function rawBits(v: number): number {
  const a = Math.floor(v / 7) + 2;
  return (16 * v + 128) * v + 64 - (v < 2 ? 0 : (25 * a - 10) * a - 55) - (v < 7 ? 0 : 36);
}
function multiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function divisor(degree: number): number[] {
  const out = Array<number>(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) out[j] = multiply(out[j]!, root) ^ (out[j + 1] ?? 0);
    root = multiply(root, 2);
  }
  return out;
}
function remainder(data: number[], poly: number[]): number[] {
  const out = poly.map(() => 0);
  for (const b of data) {
    const f = b ^ out.shift()!;
    out.push(0);
    poly.forEach((p, i) => {
      out[i] = out[i]! ^ multiply(p, f);
    });
  }
  return out;
}
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let v = 1;
  for (; v <= 40; v++)
    if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= (Math.floor(rawBits(v) / 8) - ECC[v]! * BLOCKS[v]!) * 8) break;
  if (v > 40) throw new Error("qr-too-large");
  const capacity = Math.floor(rawBits(v) / 8) - ECC[v]! * BLOCKS[v]!;
  const bits: number[] = [];
  const put = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(4, 4);
  put(bytes.length, v < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((n, b) => n * 2 + b, 0));
  for (let pad = 0; data.length < capacity; pad++) data.push(pad % 2 ? 0x11 : 0xec);
  const n = BLOCKS[v]!,
    e = ECC[v]!,
    raw = Math.floor(rawBits(v) / 8);
  const shortCount = n - (raw % n),
    shortLen = Math.floor(raw / n),
    poly = divisor(e);
  const blocks: number[][] = [];
  for (let i = 0, offset = 0; i < n; i++) {
    const part = data.slice(offset, offset + shortLen - e + (i < shortCount ? 0 : 1));
    offset += part.length;
    const ecc = remainder(part, poly);
    if (i < shortCount) part.push(0);
    blocks.push(part.concat(ecc));
  }
  const words: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++)
    for (let j = 0; j < n; j++) if (i !== shortLen - e || j >= shortCount) words.push(blocks[j]![i]!);
  const size = v * 4 + 17;
  const matrix = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const fixed = matrix.map((row) => row.slice());
  const set = (x: number, y: number, dark: boolean) => {
    if (x >= 0 && y >= 0 && x < size && y < size) {
      matrix[y]![x] = dark;
      fixed[y]![x] = true;
    }
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ])
    for (let y = -4; y <= 4; y++)
      for (let x = -4; x <= 4; x++) {
        const d = Math.max(Math.abs(x), Math.abs(y));
        set(cx! + x, cy! + y, d !== 2 && d !== 4);
      }
  const align: number[] = [];
  if (v >= 2) {
    const count = Math.floor(v / 7) + 2;
    const step = v === 32 ? 26 : Math.floor((v * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
    align.push(6);
    for (let pos = size - 7; align.length < count; pos -= step) align.splice(1, 0, pos);
    for (let i = 0; i < count; i++)
      for (let j = 0; j < count; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === count - 1) || (i === count - 1 && j === 0)) continue;
        for (let y = -2; y <= 2; y++)
          for (let x = -2; x <= 2; x++) set(align[i]! + x, align[j]! + y, Math.max(Math.abs(x), Math.abs(y)) !== 1);
      }
  }
  // ECC Low format bits = 1, mask 0.
  let rem = 8;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const format = ((8 << 10) | rem) ^ 0x5412;
  const bit = (value: number, i: number) => ((value >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) set(8, i, bit(format, i));
  set(8, 7, bit(format, 6));
  set(8, 8, bit(format, 7));
  set(7, 8, bit(format, 8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(format, i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(format, i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(format, i));
  set(8, size - 8, true);
  if (v >= 7) {
    let r = v;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const value = (v << 12) | r;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3),
        b = Math.floor(i / 3);
      set(a, b, bit(value, i));
      set(b, a, bit(value, i));
    }
  }
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j,
          y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fixed[y]![x]) {
          const dark = index < words.length * 8 && bit(words[index >>> 3]!, 7 - (index & 7));
          matrix[y]![x] = dark !== ((x + y) % 2 === 0);
          index++;
        }
      }
  }
  return matrix;
}
export function renderQr(text: string): string {
  const matrix = qrMatrix(text),
    size = matrix.length;
  // Four-module quiet zone; inverted white background makes dark terminals scan reliably.
  const dark = (x: number, y: number) => matrix[y - 4]?.[x - 4] ?? false;
  const lines: string[] = [];
  for (let y = 0; y < size + 8; y += 2) {
    let line = "";
    for (let x = 0; x < size + 8; x++) line += ["█", "▀", "▄", " "][(dark(x, y) ? 2 : 0) | (dark(x, y + 1) ? 1 : 0)];
    lines.push(line);
  }
  return lines.join("\n");
}
