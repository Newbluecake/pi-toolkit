/**
 * Darwin sysload parsers — pure text fixtures (sysload darwin-plan §4.1, S0).
 *
 * Tier 1 by construction: pure functions over in-memory strings, no process, no socket, no
 * clock. Real-command coverage (sysctl/mount/ps against a live macOS) is E-MAC and lives in
 * tests/integration/sysload-darwin.test.ts (S4); what these cases prove is that the parsers
 * are STRICT — garbage never becomes a guessed value.
 */
import { describe, expect, it } from "vitest";
import {
  DARWIN_LOCAL_FILESYSTEMS,
  parseDarwinMount,
  parseDarwinSysctl,
  parseHwNcpu,
  parseMemorystatusLevel,
  parsePsTop,
  parseVmLoadavg,
} from "../../../src/web-hub/protocol/sysload-darwin-parse.js";

/** mounts.ts findMount semantics, replicated locally: the S0 parse side only produces the records. */
function longestMountPoint(mounts: readonly { mountPoint: string }[], path: string): string | undefined {
  const hits = mounts.filter(
    (m) => m.mountPoint === "/" || path === m.mountPoint || path.startsWith(`${m.mountPoint}/`),
  );
  return [...hits].sort((a, b) => b.mountPoint.length - a.mountPoint.length)[0]?.mountPoint;
}

describe("parseVmLoadavg", () => {
  it("parses the real darwin form, with or without padding and trailing newline", () => {
    expect(parseVmLoadavg("{ 2.35 2.36 2.38 }")).toEqual([2.35, 2.36, 2.38]);
    expect(parseVmLoadavg("{ 2.35 2.36 2.38 }\n")).toEqual([2.35, 2.36, 2.38]);
    expect(parseVmLoadavg("{2.35 2.36 2.38}")).toEqual([2.35, 2.36, 2.38]);
    expect(parseVmLoadavg("{  2.35   2.36   2.38  }")).toEqual([2.35, 2.36, 2.38]);
    expect(parseVmLoadavg("{ 0 0 0 }")).toEqual([0, 0, 0]);
  });

  it("rejects everything else — braces are required and the count must be exactly three finite non-negative numbers", () => {
    for (const bad of [
      "2.35 2.36 2.38", // Linux form: no braces
      "{ 2.35 2.36 }", // two values
      "{ 2.35 2.36 2.38 2.40 }", // four values
      "{ -1 2 3 }", // negative
      "{ NaN 2 3 }",
      "{ Infinity 2 3 }",
      "{ 1e999 2 3 }",
      "",
      "{ }",
      "   ",
      "{ 2.35 2.36 2.38 } trailing",
      "{2.35} {2.36}",
    ]) {
      expect(parseVmLoadavg(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe("parseMemorystatusLevel", () => {
  it("parses 0..100 decimal integers", () => {
    expect(parseMemorystatusLevel("46\n")).toBe(46);
    expect(parseMemorystatusLevel("46")).toBe(46);
    expect(parseMemorystatusLevel("0")).toBe(0);
    expect(parseMemorystatusLevel("100")).toBe(100);
    expect(parseMemorystatusLevel(" 48 \r\n")).toBe(48);
  });

  it("rejects out-of-range and non-decimal forms", () => {
    for (const bad of ["101", "-1", "46.5", "46abc", "", "  ", "0x2e", "4 6", "1e2", "+46"]) {
      expect(parseMemorystatusLevel(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe("parseHwNcpu", () => {
  it("parses 1..4096 decimal integers", () => {
    expect(parseHwNcpu("12\n")).toBe(12);
    expect(parseHwNcpu("1")).toBe(1);
    expect(parseHwNcpu("4096")).toBe(4096);
  });

  it("rejects 0, negatives, floats and values above the ceiling", () => {
    for (const bad of ["0", "-4", "2.5", "4097", "", "  ", "12abc", "0xc"]) {
      expect(parseHwNcpu(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe("parseDarwinSysctl", () => {
  it("parses the real three-line output with all fields present (incl. CRLF)", () => {
    expect(parseDarwinSysctl("{ 1.65 2.14 2.28 }\n48\n12\n")).toEqual({
      loadavg: [1.65, 2.14, 2.28],
      memAvailPct: 48,
      cores: 12,
    });
    expect(parseDarwinSysctl("{ 1.65 2.14 2.28 }\r\n48\r\n12\r\n")).toEqual({
      loadavg: [1.65, 2.14, 2.28],
      memAvailPct: 48,
      cores: 12,
    });
  });

  it("a single bad line drops only its own field (fields are independent)", () => {
    expect(parseDarwinSysctl("garbage\n48\n12\n")).toEqual({ memAvailPct: 48, cores: 12 });
    expect(parseDarwinSysctl("{ 1 2 3 }\n101\n12\n")).toEqual({ loadavg: [1, 2, 3], cores: 12 });
    expect(parseDarwinSysctl("{ 1 2 3 }\n48\n0\n")).toEqual({ loadavg: [1, 2, 3], memAvailPct: 48 });
    expect(parseDarwinSysctl("x\ny\nz\n")).toEqual({});
  });

  it("any other non-empty line count voids the whole reading", () => {
    expect(parseDarwinSysctl("")).toEqual({});
    expect(parseDarwinSysctl("{ 1 2 3 }\n48\n")).toEqual({});
    expect(parseDarwinSysctl("{ 1 2 3 }\n48\n12\n13\n")).toEqual({});
    // a blank line among three non-empty ones keeps the count at three
    expect(parseDarwinSysctl("{ 1 2 3 }\n\n48\n12\n")).toEqual({ loadavg: [1, 2, 3], memAvailPct: 48, cores: 12 });
  });
});

describe("parseDarwinMount", () => {
  const REAL = [
    "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
    "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse, nosuid)",
    "/dev/disk6s1 on /Volumes/微信 WeChat (apfs, local, journaled)",
    "server.example:/export on /mnt/nfs (nfs)",
    "//user@host/share on /Volumes/share (smbfs, mounted by u)",
    "not a mount line at all",
    "",
  ].join("\n");

  it("parses the real darwin mount output shape (source/mountPoint/fstype/mountOptions)", () => {
    const mounts = parseDarwinMount(REAL);
    expect(mounts).toHaveLength(5);
    const root = mounts[0]!;
    expect(root).toEqual({
      mountId: 0,
      parentId: 0,
      majorMinor: "0:0",
      root: "/",
      mountPoint: "/",
      mountOptions: ["sealed", "local", "read-only", "journaled"],
      optionalFields: [],
      fstype: "apfs",
      source: "/dev/disk3s1s1",
      superOptions: [],
    });
    expect(mounts[1]!.mountPoint).toBe("/System/Volumes/Data/home");
    expect(mounts[1]!.fstype).toBe("autofs");
    expect(mounts[1]!.mountOptions).toEqual(["automounted", "nobrowse", "nosuid"]);
    expect(mounts[2]!.mountPoint).toBe("/Volumes/微信 WeChat");
    expect(mounts[3]).toMatchObject({ fstype: "nfs", source: "server.example:/export" });
    expect(mounts[4]).toMatchObject({ fstype: "smbfs", mountOptions: ["mounted by u"] });
  });

  it("mount options are the tail of the paren list; CRLF input parses identically", () => {
    const mounts = parseDarwinMount("/dev/disk1s1 on /Volumes/Data (apfs, local)\r\n");
    expect(mounts).toHaveLength(1);
    expect(mounts[0]!).toMatchObject({ fstype: "apfs", mountOptions: ["local"] });
    const bare = parseDarwinMount("/dev/disk1s1 on /d (hfs)");
    expect(bare[0]!.mountOptions).toEqual([]);
  });

  it("classifies local vs remote via DARWIN_LOCAL_FILESYSTEMS (nfs/smbfs/autofs are remote)", () => {
    const mounts = parseDarwinMount(REAL);
    const local = (fstype: string) => DARWIN_LOCAL_FILESYSTEMS.has(fstype);
    expect(mounts.map((m) => [m.fstype, local(m.fstype)])).toEqual([
      ["apfs", true],
      ["autofs", false],
      ["apfs", true],
      ["nfs", false],
      ["smbfs", false],
    ]);
    for (const fstype of ["hfs", "exfat", "msdos", "zfs"]) expect(local(fstype)).toBe(true);
    for (const fstype of ["afpfs", "webdav", "devfs", "ntfs", "ufs", "fusefs"]) expect(local(fstype)).toBe(false);
  });

  it("mountpoints may contain parentheses, spaces and 'on'; the greedy match anchors on the trailing option block", () => {
    const mounts = parseDarwinMount("/dev/disk9s1 on /Volumes/Foo (1) (apfs, local)");
    expect(mounts[0]!.mountPoint).toBe("/Volumes/Foo (1)");
    const withOn = parseDarwinMount("disk on key on /Volumes/On (hfs)");
    expect(withOn[0]).toMatchObject({ source: "disk on key", mountPoint: "/Volumes/On" });
    // mountpoint must be absolute — a relative one cannot parse
    expect(parseDarwinMount("src on relative (apfs)")).toHaveLength(0);
  });

  it("drops garbage and blank lines, and empties the whole table over 1 MiB or 10 000 lines", () => {
    expect(parseDarwinMount("")).toEqual([]);
    expect(parseDarwinMount("\n\n\n")).toEqual([]);
    expect(parseDarwinMount("garbage\n(x)\n on (y)\n")).toEqual([]);
    expect(parseDarwinMount(`${"x".repeat(1024 * 1024 + 1)}`)).toEqual([]);
    const many = Array.from({ length: 10_001 }, (_, i) => `/dev/d${i} on /m${i} (apfs)`).join("\n");
    expect(parseDarwinMount(many)).toEqual([]);
    const atLimit = Array.from({ length: 10_000 }, (_, i) => `/dev/d${i} on /m${i} (apfs)`).join("\n");
    expect(parseDarwinMount(atLimit)).toHaveLength(10_000);
  });

  it("parsed records support longest-prefix resolution (HOME⇒/, /Volumes/X/foo⇒/Volumes/X, /Volumes/XY does NOT match /Volumes/X)", () => {
    const mounts = parseDarwinMount(REAL);
    expect(longestMountPoint(mounts, "/Users/bluecake")).toBe("/");
    expect(longestMountPoint(mounts, "/Volumes/微信 WeChat/db")).toBe("/Volumes/微信 WeChat");
    expect(longestMountPoint(mounts, "/Volumes/share/file")).toBe("/Volumes/share");
    expect(longestMountPoint(mounts, "/mnt/nfs/sub")).toBe("/mnt/nfs");
    // no /Volumes/X mount exists in this fixture — /Volumes/XY falls back to "/"
    expect(longestMountPoint(mounts, "/Volumes/XY")).toBe("/");
    const withX = parseDarwinMount(`${REAL}\n/dev/disk7s1 on /Volumes/X (apfs, local)`);
    expect(longestMountPoint(withX, "/Volumes/X/foo")).toBe("/Volumes/X");
    expect(longestMountPoint(withX, "/Volumes/XY")).toBe("/");
  });
});

describe("parsePsTop", () => {
  it("parses the real ps form: three numeric columns then the whole path as comm (spaces and parens intact)", () => {
    const out = parsePsTop("    1   0.0  20224 /sbin/launchd", 100);
    expect(out).toEqual({ procs: [{ pid: 1, comm: "launchd", cpuPct: 0, rssBytes: 20224 * 1024 }], truncated: false });
    const helper =
      "   42  12.3  123456 /System/Library/CoreServices/Foo Helper (Xyz).app/Contents/MacOS/Foo Helper (Xyz)";
    expect(parsePsTop(helper, 100).procs[0]).toEqual({
      pid: 42,
      comm: "Foo Helper (Xyz)",
      cpuPct: 12.3,
      rssBytes: 123456 * 1024,
    });
  });

  it("cpuPct is the single-core percent (may exceed 100) and rssBytes is KiB×1024", () => {
    const procs = parsePsTop("   7  412.5  8 /usr/sbin/syslogd", 100).procs;
    expect(procs[0]!.cpuPct).toBe(412.5);
    expect(procs[0]!.rssBytes).toBe(8192);
  });

  it("sanitizes comm: control characters become '?' and length caps at 128", () => {
    const control = parsePsTop("   9   0.1  16 /bin/we\u0007ird\u001fname", 100).procs[0]!;
    expect(control.comm).toBe("we?ird?name");
    const long = `/opt/bin/${"a".repeat(300)}`;
    const capped = parsePsTop(`   9   0.1  16 ${long}`, 100).procs[0]!;
    expect(capped.comm).toHaveLength(128);
    expect(capped.comm).toBe("a".repeat(128));
  });

  it("drops malformed rows (missing columns, non-numeric, non-positive pid) and empty output yields nothing", () => {
    const bad = [
      "",
      "   1   0.0",
      "  x  0.0  1 /bin/ps",
      "   0   0.0  1 /sbin/launchd",
      "  -3  0.0  1 /bin/x",
      "   5  abc  1 /bin/x",
      "   5  0.0  x /bin/x",
    ].join("\n");
    expect(parsePsTop(bad, 100)).toEqual({ procs: [], truncated: false });
  });

  it("caps at maxPids with truncated:true, keeping exactly maxPids rows", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `  ${100 + i}   0.1  ${16 * (i + 1)} /bin/p${i}`);
    const text = lines.join("\n");
    expect(parsePsTop(text, 3)).toEqual({
      procs: lines.slice(0, 3).map((line, i) => ({
        pid: 100 + i,
        comm: `p${i}`,
        cpuPct: 0.1,
        rssBytes: 16 * (i + 1) * 1024,
      })),
      truncated: true,
    });
    expect(parsePsTop(text, 10)).toMatchObject({ truncated: false });
    expect(parsePsTop(text, 10).procs).toHaveLength(10);
    // an invalid maxPids yields an empty, truncated result rather than an unbounded scan
    expect(parsePsTop(text, 0)).toEqual({ procs: [], truncated: true });
    expect(parsePsTop(text, -5)).toEqual({ procs: [], truncated: true });
  });
});
