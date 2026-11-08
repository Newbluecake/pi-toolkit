import { describe, expect, it } from "vitest";
import {
  fabricWakeNotice,
  parseWakeNotice,
  translateWakeNotice,
} from "../../../src/web-hub/protocol/fabric-wake-notice.js";

describe("wake notice parsing", () => {
  it.each(["root_limit", "root_busy", "root_reserved", "level_limit"])(
    "recognizes both languages and translates %s without changing the body",
    (reason) => {
      for (const lang of ["zh", "en"] as const) {
        const text = `[@sender] · ${fabricWakeNotice(reason, lang)}\nbody (root_busy)`;
        expect(parseWakeNotice(text)?.reason).toBe(reason);
        expect(translateWakeNotice(text, "en")).toBe(`[@sender] · ${fabricWakeNotice(reason, "en")}\nbody (root_busy)`);
        expect(translateWakeNotice(text, "zh")).toBe(`[@sender] · ${fabricWakeNotice(reason, "zh")}\nbody (root_busy)`);
      }
    },
  );
  it("follows rewritten formatter wording without parser changes", () => {
    const rewritten: typeof fabricWakeNotice = (reason, lang) =>
      fabricWakeNotice(reason, lang).replace("已送达", "已投递").replace("Delivered", "Received");
    for (const lang of ["zh", "en"] as const) {
      const text = `[@sender] · ${rewritten("root_limit", lang)}\nbody`;
      expect(parseWakeNotice(text, rewritten)?.reason).toBe("root_limit");
    }
  });
  it("leaves unrelated and undowngraded messages byte-identical", () => {
    for (const text of ["[@sender]\nroot_busy", "[@sender] · unrelated root_busy\nbody", "plain text"]) {
      expect(parseWakeNotice(text)).toBeNull();
      expect(translateWakeNotice(text, "en")).toBe(text);
    }
  });
});
