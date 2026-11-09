import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SCOPED_ERROR_MESSAGES, scopedFailure, withScopedMessage } from "../../../src/memory/scopes/error-messages.js";

it("covers every declared error code with actionable nonempty guidance", () => {
  const types = readFileSync(new URL("../../../src/memory/scopes/types.ts", import.meta.url), "utf8");
  const union = types.match(/export type ScopedMemoryErrorCode =([\s\S]*?);/)?.[1];
  expect(union).toBeDefined();
  const codes = [...union!.matchAll(/"(E_[A-Z_]+)"/g)].map((m) => m[1]!);
  expect(codes.length).toBeGreaterThan(0);
  expect(Object.keys(SCOPED_ERROR_MESSAGES).sort()).toEqual([...codes].sort());
  for (const code of codes)
    expect(SCOPED_ERROR_MESSAGES[code as keyof typeof SCOPED_ERROR_MESSAGES].trim()).not.toBe("");
});

it("rate guidance covers the turn limit and pending approval with distinct recovery actions", () => {
  expect(SCOPED_ERROR_MESSAGES.E_HUB_RATE).toContain("若本回合批准请求次数已达上限，请等待用户的新消息后再按需重试");
  expect(SCOPED_ERROR_MESSAGES.E_HUB_RATE).toContain(
    "若上一个批准请求仍在进行中，请等它结算（批准 / 拒绝 / 超时）后再重试",
  );
});

it("gives specific guidance and preserves an existing detailed message", () => {
  expect(SCOPED_ERROR_MESSAGES.E_META_INVALID).toMatch(/hub.*user.*真人批准/);
  expect(SCOPED_ERROR_MESSAGES.E_META_INVALID).toMatch(/id.*rev.*空字符串/);
  expect(SCOPED_ERROR_MESSAGES.E_HUB_NEEDS_HUMAN_TURN).toContain("后台通知会作废真人回合，请在自己的消息里立即重试");
  expect(SCOPED_ERROR_MESSAGES.E_CONFLICT).toMatch(/view.*rev/);
  expect(SCOPED_ERROR_MESSAGES.E_PERSIST_UNKNOWN).toContain("不要盲目重试");
  expect(withScopedMessage({ ok: false, code: "E_CONFLICT", message: "specific", extra: 1 })).toEqual({
    ok: false,
    code: "E_CONFLICT",
    message: "specific",
    extra: 1,
  });
  expect(scopedFailure("E_NOT_FOUND")).toMatchObject({ ok: false, code: "E_NOT_FOUND", message: expect.any(String) });
});
