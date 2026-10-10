import { describe, expect, it } from "vitest";
import {
  parseMeminfo,
  parseMountinfo,
  parsePidStat,
  parsePressure,
  parseProcStat,
  parseLoadavg,
} from "../../src/sysload/procfs.js";

describe("sysload procfs parsers", () => {
  it("does not double count guest time and parses pressure", () => {
    const stat = parseProcStat("cpu 10 2 3 20 5 1 2 1 99 100\n")!;
    expect(stat.total).toBe(44);
    expect(stat.idleAll).toBe(25);
    expect(parsePressure("some avg10=42.5 avg60=1 avg300=0 total=1\n")).toEqual({ someAvg10: 42.5 });
  });

  it("rejects impossible memory and load values", () => {
    expect(parseMeminfo("MemTotal: 10 kB\nMemAvailable: 11 kB\n")).toBeUndefined();
    expect(parseLoadavg("1 2 nope")).toBeUndefined();
  });

  it("parses comm containing parentheses and mount escapes", () => {
    const rest = ["S", ...Array(19).fill("0")];
    rest[11] = "7";
    rest[12] = "8";
    rest[19] = "9";
    expect(parsePidStat(`42 (worker (x)) ${rest.join(" ")}`)).toMatchObject({
      pid: 42,
      comm: "worker (x)",
      utime: 7,
      stime: 8,
      starttime: 9,
    });
    const mounts = parseMountinfo("1 0 8:1 / /home\\040user rw,relatime - ext4 /dev/sda rw\n");
    expect(mounts[0]?.mountPoint).toBe("/home user");
  });
});
