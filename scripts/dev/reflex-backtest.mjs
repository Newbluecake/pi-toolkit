#!/usr/bin/env node
/** B3 Tier 3 offline CLI. No network, pi imports, settings edits or automatic promotion. */
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createInterface as questions } from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

function parse(args) {
  const o = {
    days: 30,
    json: false,
    report: false,
    noCache: false,
    emit: false,
    assign: new Map(),
    minGroup: 3,
    command: "scan",
  };
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (["--json", "--report", "--no-cache", "--emit"].includes(a))
      o[{ "--json": "json", "--report": "report", "--no-cache": "noCache", "--emit": "emit" }[a]] = true;
    else if (
      [
        "--days",
        "--cwd",
        "--drafts",
        "--only",
        "--assign",
        "--min-group",
        "--lineage",
        "--promote",
        "--batch",
      ].includes(a)
    ) {
      const v = args[++i];
      if (!v || v.startsWith("--")) throw new Error(`${a} requires a value`);
      if (a === "--assign") {
        const m = /^([^=]+)=(jobs.list|fleet.status|quota.summary|git.status)$/.exec(v);
        if (!m) throw new Error("bad assign");
        o.assign.set(m[1], m[2]);
      } else if (a === "--days" || a === "--min-group") o[a === "--days" ? "days" : "minGroup"] = Number(v);
      else o[a.slice(2)] = v;
    } else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else words.push(a);
  }
  if (words[0] === "batch" && words[1] === "freeze" && words.length === 2) o.command = "freeze";
  else if (words[0] === "generate" && words.length === 1) o.command = "generate";
  else if (["review", "show"].includes(words[0]) && words.length === 2) {
    o.command = words[0];
    o.target = words[1];
  } else if (words.length)
    throw new Error(
      "usage: [generate | batch freeze --lineage L | review portId | show digest | --promote id --batch batchId]",
    );
  if (o.promote) {
    if (o.command !== "scan") throw new Error("conflicting commands");
    o.command = "promote";
  }
  if (
    !Number.isFinite(o.days) ||
    o.days <= 0 ||
    !Number.isFinite(o.days * 86400000) ||
    !Number.isInteger(o.minGroup) ||
    o.minGroup < 1
  )
    throw new Error("invalid days or min-group");
  if (o.cwd && !isAbsolute(o.cwd)) throw new Error("--cwd requires an absolute path");
  if (o.command === "show" && (o.report || o.json))
    throw new Error("show is local only; --report and --json are forbidden");
  if (o.command === "review" && (o.report || o.json)) throw new Error("review is interactive, not an export");
  if (o.command === "freeze" && !o.lineage) throw new Error("freeze requires --lineage");
  return o;
}
async function privateDir(dir) {
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const s = await lstat(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || s.mode & 0o077 || s.uid !== process.getuid())
    throw new Error("untrusted reflex directory");
}
async function privateRead(file, missing = true) {
  let fd;
  try {
    fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const s = await fd.stat();
    if (!s.isFile() || s.mode & 0o077 || s.uid !== process.getuid()) throw new Error("untrusted reflex file");
    return await fd.readFile("utf8");
  } catch (e) {
    if (missing && e.code === "ENOENT") return undefined;
    throw e;
  } finally {
    await fd?.close();
  }
}
/** Exclusive reservation + tmp rename: existing immutable files are NEVER overwritten. */
async function atomic(file, text, immutable = false) {
  const tmp = join(dirname(file), `.tmp-${randomUUID()}`);
  let reservation;
  try {
    const fd = await open(tmp, "wx", 0o600);
    try {
      await fd.writeFile(text);
      await fd.sync();
    } finally {
      await fd.close();
    }
    if (immutable) {
      reservation = await open(file, "wx", 0o600);
      await reservation.close();
      reservation = undefined;
    } else {
      await privateRead(file);
    }
    await rename(tmp, file);
  } finally {
    await reservation?.close();
    await unlink(tmp).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}
async function append(file, text) {
  const fd = await open(
    file,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  try {
    const s = await fd.stat();
    if (!s.isFile() || s.mode & 0o077 || s.uid !== process.getuid()) throw new Error("untrusted journal");
    await fd.writeFile(text);
    await fd.sync();
  } finally {
    await fd.close();
  }
}
async function* readLines(file, headerOnly = false) {
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const s = await fd.stat();
  if (!s.isFile()) {
    await fd.close();
    throw new Error("non-regular session");
  }
  const stream = fd.createReadStream({ encoding: "utf8", autoClose: false });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let failure;
  stream.on("error", (e) => {
    failure = e;
    lines.close();
  });
  try {
    for await (const l of lines) {
      yield l;
      if (headerOnly) break;
    }
    if (failure) throw failure;
  } finally {
    lines.close();
    stream.destroy();
    await fd.close();
  }
}
async function listFiles(dir, missing = true) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (missing && e.code === "ENOENT") return [];
    throw e;
  }
  const out = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(file, false)));
    else if (e.isFile() && e.name.endsWith(".jsonl")) {
      const s = await lstat(file);
      out.push({ file, size: s.size, mtimeMs: s.mtimeMs, dev: s.dev, ino: s.ino });
    }
  }
  return out;
}
async function main() {
  // D8 MUST be checked before argument parsing, dist imports or any I/O.
  if (process.env.PI_SECURE_SESSION || process.env.PI_SECURE_VAULT || process.env.PI_SECURE_NS) {
    console.error("reflex backtest disabled in secure environment");
    process.exitCode = 3;
    return;
  }
  const o = parse(process.argv.slice(2));
  let O, C, L, R, catalog, loadDrafts, systemClock, createPortRegistry, resolveAgentDir, turnKeyOf;
  try {
    [O, C, L, R] = await Promise.all(
      ["orchestrate", "cache-format", "ledger-format", "report"].map(
        (n) => import(`../../dist/reflex/core/backtest/${n}.js`),
      ),
    );
    ({ BUILTIN_SCRIPTS: catalog } = await import("../../dist/reflex/core/catalog.js"));
    ({ turnKeyOf } = await import("../../dist/reflex/core/backtest/evidence.js"));
    ({ loadDrafts } = await import("../../dist/reflex/drafts/load.js"));
    ({ systemClock } = await import("../../dist/core/clock.js"));
    ({ createPortRegistry } = await import("../../dist/reflex/ports/index.js"));
    ({ resolveAgentDir } = await import("../../dist/core/agent-dir.js"));
  } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND") {
      console.error("缺少 dist：先 npm run build");
      process.exitCode = 2;
      return;
    }
    throw e;
  }
  const agentDir = resolveAgentDir(process.env, homedir()).dir;
  const root = join(agentDir, "reflex");
  // Creating an absent custom agentDir is convenient; never change existing parent permissions.
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await privateDir(root);
  for (const n of ["cache", "manifests", "batches", "reviews", "drafts", "drafts-out", "reports"])
    await privateDir(join(root, n));
  const ledger = {
    async read() {
      const state = L.emptyLedger();
      for (const [kind, dir, key] of [
        ["manifest", "manifests", "manifests"],
        ["batch", "batches", "batches"],
        ["review", "reviews", "reviews"],
      ]) {
        for (const name of (await readdir(join(root, dir))).sort()) {
          if (!/^[a-z0-9.-]+\.json$/.test(name)) throw new Error("bad ledger filename");
          const value = L.decodeLedger(kind, await privateRead(join(root, dir, name), false));
          if (!value) throw new Error(`invalid ${kind} ledger`);
          state[key].push(value);
        }
      }
      for (const [kind, name, key] of [
        ["exposure", "exposure.jsonl", "exposures"],
        ["revision", "revisions.jsonl", "revisions"],
      ]) {
        const text = await privateRead(join(root, name));
        for (const line of (text ?? "").split("\n").filter(Boolean)) {
          const value = L.decodeLedger(kind, line);
          if (!value) throw new Error(`invalid ${kind} ledger`);
          state[key].push(value);
        }
      }
      return state;
    },
    async create(kind, value) {
      const name = kind === "manifest" ? value.manifestHash : value.batchId;
      if (!/^[a-f0-9]{64}$/.test(name)) throw new Error("bad ledger key");
      await atomic(
        join(root, kind === "manifest" ? "manifests" : "batches", `${name}.json`),
        L.encodeLedger(value),
        true,
      );
    },
    async append(kind, value) {
      await append(join(root, kind === "exposure" ? "exposure.jsonl" : "revisions.jsonl"), L.encodeLedger(value));
    },
  };
  const deps = {
    listFiles: () => listFiles(join(agentDir, "sessions")),
    readLines,
    cache: {
      read: () => privateRead(join(root, "cache", "corpus-v2.jsonl")),
      write: (t) => atomic(join(root, "cache", "corpus-v2.jsonl"), t),
    },
    ledger,
    clock: { now: () => Date.now() },
  };
  const loaded = await loadDrafts(
    o.drafts ? resolve(o.drafts) : join(root, "drafts"),
    new Set(catalog.map((s) => s.id)),
    systemClock,
    new AbortController().signal,
  );
  if (loaded.failure) throw new Error(`drafts ${loaded.failure.code}`);
  if (loaded.rejected.length) console.error(`drafts rejected=${loaded.rejected.length}`);
  const registry = createPortRegistry({
    bashJobs: () => undefined,
    fleet: () => undefined,
    quota: () => undefined,
    git: async () => {
      throw new Error("offline report never runs ports");
    },
  });
  let gitCommitAt;
  try {
    gitCommitAt =
      Number(
        execFileSync("git", ["log", "-1", "--format=%ct", "--", "src/reflex/core/catalog.ts"], {
          cwd: resolve(import.meta.dirname, "../.."),
          encoding: "utf8",
          timeout: 2000,
        }),
      ) * 1000;
    if (!Number.isFinite(gitCommitAt)) gitCommitAt = undefined;
  } catch {
    /* firstSeenAt still conservatively bounds revisions */
  }
  const opts = {
    builtin: catalog,
    drafts: loaded.loaded.map((d) => d.script),
    caps: new Set(["bashJobs", "fleet", "quota", "git", "sessionDir"]),
    portVersions: new Map(
      ["jobs.list", "fleet.status", "quota.summary", "git.status"].map((k) => [k, registry.get(k)?.version ?? 0]),
    ),
    ...(gitCommitAt === undefined ? {} : { gitCommitAt }),
  };
  await O.registerRevisions(deps, opts);
  const until = Date.now(),
    filter = { since: Math.max(0, until - o.days * 86400000), until, ...(o.cwd ? { cwd: resolve(o.cwd) } : {}) };
  const scan = await O.scanCorpus(deps, filter, o.noCache);
  const allRows = O.applyReviews(O.replayScan(scan, opts), await ledger.read(), opts);
  const rows = o.only ? allRows.filter((r) => r.cls.k === "high" && r.cls.scriptId === o.only) : allRows;
  let state = await ledger.read(),
    generated,
    verdicts = [],
    details = [];
  const emitExposure = async (prepared) => {
    for (const e of prepared.exposures) await ledger.append("exposure", e);
  };
  const batched = (r) => state.batches.some((b) => b.turnKeys.includes(OKey(r)));
  const OKey = (r) => turnKeyOf(r.turn);
  if (o.command === "freeze") {
    const result = await O.freezeBatch(deps, scan, opts, o.lineage, filter);
    if (!result.ok) {
      console.error(`batch refused: ${result.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `batch=${result.batch.batchId} manifestHash=${result.batch.manifestHash} turns=${result.batch.turnKeys.length}`,
    );
    return;
  }
  if (o.command === "generate") {
    if (!scan.scanComplete) throw new Error("generate requires complete scan");
    generated = O.generate(scan, opts, o.assign, o.minGroup);
    if (
      o.emit &&
      new Set([
        ...(await readdir(join(root, "drafts"))).filter((n) => n.endsWith(".json")),
        ...generated.drafts.map((d) => `${d.id}.json`),
      ]).size > 16
    )
      throw new Error("--emit exceeds runtime cap 16; select drafts-out manually");
    for (const draft of generated.drafts) {
      await atomic(join(root, "drafts-out", `${draft.id}.json`), JSON.stringify(draft, null, 2) + "\n");
      if (o.emit) await atomic(join(root, "drafts", `${draft.id}.json`), JSON.stringify(draft, null, 2) + "\n");
      const identity = { ...opts, drafts: [draft], draftSource: "drafts-out" };
      await O.registerRevisions(deps, identity);
    }
  } else if (o.command === "show") {
    const selected = allRows.filter((r) => r.turn.digest === o.target);
    if (!selected.length) throw new Error("digest not found");
    if (selected.some((r) => r.turn.split === "holdout" && r.suspect && !batched(r)))
      throw new Error("freeze holdout failures before showing details");
    const prepared = O.prepareDetails(selected, state, opts, "show", Date.now());
    await emitExposure(prepared);
    for (const r of selected) console.log(R.renderShow(r));
    return;
  } else if (o.command === "review") {
    if (!["jobs.list", "fleet.status", "quota.summary", "git.status"].includes(o.target))
      throw new Error("unknown port");
    const prepared = O.prepareDetails(
      rows,
      state,
      opts,
      "review",
      Date.now(),
      (r) =>
        r.suspect !== undefined &&
        r.turn.split === "holdout" &&
        r.cls.k === "high" &&
        [...catalog, ...opts.drafts].find((s) => s.id === r.cls.scriptId)?.port.id === o.target &&
        batched(r),
    );
    await emitExposure(prepared);
    const entries = state.reviews.flatMap((r) => r.entries).filter((e) => e.portId === o.target);
    const q = questions({ input: process.stdin, output: process.stdout });
    try {
      for (const row of prepared.rows) {
        console.log(`${row.turn.digest} ${R.safeText(row.turn.text)} ${row.suspect} · unverified`);
        const answer = (await q.question("ok / misfire / skip: ")).trim();
        if (!["ok", "misfire", "skip"].includes(answer)) throw new Error("invalid review verdict");
        if (answer !== "skip") {
          const i = entries.findIndex((e) => e.digest === row.turn.digest);
          if (i >= 0) entries.splice(i, 1);
          entries.push({ digest: row.turn.digest, portId: o.target, verdict: answer, at: Date.now() });
        }
      }
    } finally {
      q.close();
    }
    await atomic(join(root, "reviews", `${o.target}.json`), L.encodeLedger({ v: 1, entries, unverified: true }));
    return;
  } else if (o.command === "promote") verdicts = [await O.promote(deps, scan, opts, o.promote, o.batch)];
  else
    for (const script of [...catalog, ...opts.drafts].filter((s) => !o.only || s.id === o.only))
      verdicts.push(await O.promote(deps, scan, opts, script.id, o.batch));
  // Only frozen holdout failures are exportable details. Aggregates alone never expose.
  if (o.report) {
    state = await ledger.read();
    const prepared = O.prepareDetails(
      rows,
      state,
      opts,
      "report",
      Date.now(),
      (r) => r.turn.split === "holdout" && r.suspect !== undefined && batched(r),
    );
    await emitExposure(prepared);
    details = prepared.rows;
  }
  const report = R.buildReport(scan, rows, opts, verdicts, details, generated);
  if (o.report)
    await atomic(join(root, "reports", `${new Date().toISOString().replace(/[:.]/g, "-")}.md`), R.renderReport(report));
  console.log(o.json ? JSON.stringify(report, null, 2) : R.renderReport(report));
  if (!scan.scanComplete) process.exitCode = 1;
}
main().catch((e) => {
  console.error(`reflex backtest failed: ${e.message}`);
  process.exitCode = 1;
});
