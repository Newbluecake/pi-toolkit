import * as fs from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { wireFixture } from "./revision-wire-helpers.js";

it("parsed positive budget → actual wireMemory/wireJev scheduler → sole SDK client → D/C/review", async () => {
  const h = await wireFixture();
  await h.writePair();
  expect(h.suggestions()).toEqual([]);
  await h.natural();
  const suggestions = h.suggestions();
  expect(suggestions).toHaveLength(1);
  const p = suggestions[0]!.revision!;
  expect(p.action).toBe("merge-survivor");
  expect(p.generatedBody).toBe("Keep the budget and directory lock. Preserve both valid rules.");
  expect(p.autoEligible).toBe(false);
  expect(h.observed).toHaveLength(1);
  expect(h.generate).toHaveBeenCalledTimes(1);
  expect(h.coverage).toHaveBeenCalledTimes(1);
  const asks = h.ask!.mock.calls.map(([req]) => req).filter((r) => r.jobId);
  expect(asks).toHaveLength(2);
  for (const req of [...asks, ...h.generate!.mock.calls.map(([r]) => r), ...h.coverage!.mock.calls.map(([r]) => r)]) {
    expect(req.registry).toBe(h.registry);
    expect(req.jobId).toBe(p.batchId);
    expect(req.jobCostCapUsd).toBe(0.1);
  }
  const actionDir = join(h.blocks, ".jev/revisions", p.batchId, p.actionId);
  expect(JSON.parse(fs.readFileSync(join(actionDir, "audit.json"), "utf8"))).toMatchObject({
    state: "prepared",
    proposalDigest: p.proposalDigest,
  });
  expect(fs.readFileSync(join(actionDir, "before.md"))).toEqual(fs.readFileSync(join(h.blocks, `${p.targetId}.md`)));
  expect(h.client!.usage().budget).toMatchObject({
    outstanding: 0,
    reservedCalls: 0,
    disposed: false,
    costSource: "usage",
  });
  expect(h.client!.usage().calls).toBe(h.calls.length);
  expect(h.client!.usage().costUsd).toBeGreaterThan(0);
  expect(h.calls.some((c) => Object.hasOwn(c.payload.questions ?? {}, "revisionRelation"))).toBe(true);
});

it.each([{ cap: 0 }, { noBinding: true }, { off: true }])(
  "unsupported/zero/off keeps old Jev operational: %j",
  async (options) => {
    const h = await wireFixture(options);
    await h.writePair();
    await h.natural();
    expect(h.suggestions()).toEqual([]);
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.calls.length).toBeGreaterThan(0);
    expect(h.calls.every((c) => c.kind === "relation" && c.payload.max_output_tokens === undefined)).toBe(true);
    expect(fs.existsSync(join(h.blocks, ".jev/revisions"))).toBe(false);
    const warnings = h.warning.mock.calls.map((c) => String(c[0])).filter((s) => s.startsWith("p50:"));
    if (options.off) expect(warnings).toEqual([]);
    else expect(warnings).toHaveLength(1);
  },
);

it.each(["abort", "tree", "shutdown", "reload"] as const)(
  "actual %s lifecycle revokes a pending natural batch",
  async (reason) => {
    const h = await wireFixture();
    await h.writePair();
    if (reason === "abort") await h.emit("turn_end", { message: { stopReason: "aborted" } });
    else if (reason === "tree") await h.emit("session_tree");
    else await h.emit("session_shutdown", { reason });
    await h.natural();
    expect(h.suggestions()).toEqual([]);
    expect(h.generate).not.toHaveBeenCalled();
    if (reason === "shutdown" || reason === "reload") expect(h.client!.usage().budget?.disposed).toBe(true);
  },
);

it("positive parsed auto/cap wire discovers a real committed source, fresh R/C and E retire without a second client or G", async () => {
  const { seedWireSource } = await import("./revision-wire-source.js");
  const h = await wireFixture({ auto: true });
  await h.writePair();
  const source = await seedWireSource(h);
  h.state.relation = "supersedes";
  const before = h.client!.usage().calls;
  h.generate!.mockClear();
  h.coverage!.mockClear();
  h.ask!.mockClear();
  // Real external writes produce a NEW natural opportunity/corpus without
  // touching either source-bound old/survivor revision.
  await h.create("An external durable lock convention.");
  await h.create("Another external durable budget convention.");
  await h.natural();
  expect(h.observed).toHaveLength(1);
  expect(h.generate).not.toHaveBeenCalled();
  expect(h.coverage).toHaveBeenCalledTimes(1);
  expect(h.client!.usage().calls).toBeGreaterThan(before);
  const retired = fs.readFileSync(join(h.blocks, "rules.002.md"), "utf8");
  expect(retired).toContain("status: superseded");
  expect(retired).toContain("supersededBy: rules.001");
  expect(fs.readFileSync(join(h.blocks, "rules.001.md"))).toEqual(source.successorAfter);
  const r = h.suggestions().find((s) => s.revision?.action === "retire")!.revision!;
  const audit = JSON.parse(
    fs.readFileSync(join(h.blocks, ".jev/revisions", r.batchId, r.actionId, "audit.json"), "utf8"),
  );
  expect(audit).toMatchObject({ state: "committed", commitOrigin: "p50-auto" });
  const requests = [
    ...h.ask!.mock.calls.map(([q]) => q).filter((q) => q.jobId),
    ...h.coverage!.mock.calls.map(([q]) => q),
  ];
  expect(requests.length).toBeGreaterThan(1);
  for (const q of requests) {
    expect(q.jobId).toBe(r.batchId);
    expect(q.jobCostCapUsd).toBe(0.1);
  }
  const callsAtEffect = h.calls.length;
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.calls).toHaveLength(callsAtEffect); // internal write invalidates cache/lease, never self-requeues
});

it("missing exact quote leaves ordinary tagging on legacy but never sends named P50 jobs unbounded", async () => {
  const h = await wireFixture({ noQuote: true });
  await h.writePair();
  await h.natural();
  expect(h.calls.length).toBeGreaterThan(0);
  expect(h.calls.every((c) => c.payload.max_output_tokens === undefined)).toBe(true);
  expect(h.ask!.mock.calls.some(([r]) => r.jobId !== undefined)).toBe(true);
  expect(h.generate).not.toHaveBeenCalled();
  expect(h.suggestions()).toEqual([]);
  const warnings = h.warning.mock.calls.map((c) => String(c[0]));
  expect(warnings.filter((s) => s.includes("classify-quote-or-bounds-unavailable"))).toHaveLength(1);
});

it.each([{ domain: "secure" as const }, { domain: "locked" as const }, { child: true }, { scopesOff: true }])(
  "real wire fail-closed domain/owner matrix %j",
  async (options) => {
    const h = await wireFixture(options);
    await h.writePair();
    await h.natural();
    expect(h.suggestions()).toEqual([]);
    expect(fs.existsSync(join(h.blocks, ".jev/revisions"))).toBe(false);
    expect(h.calls.every((c) => c.payload.max_output_tokens === undefined)).toBe(true);
    if (h.generate) expect(h.generate).not.toHaveBeenCalled();
  },
);

it.each(["registry", "manager", "tree", "abort", "shutdown", "reload"] as const)(
  "%s revokes late SDK generation, leaves sole A accounting, zero late suggestion or C/E write",
  async (reason) => {
    const h = await wireFixture();
    let release!: () => void;
    h.state.heldKind = "generation";
    h.state.hold = new Promise<void>((r) => {
      release = r;
    });
    await h.writePair();
    await h.natural();
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.client!.usage().budget?.outstanding).toBe(1);
    if (reason === "registry") {
      // A REAL different registry reference over the same SDK runtime is not the
      // certified binding's owning registry and must revoke even before result.
      const { ModelRegistry } = await import("@earendil-works/pi-coding-agent");
      (h.ctx as unknown as { modelRegistry: object }).modelRegistry = new ModelRegistry(h.runtime);
      await h.emit("session_compact", { compactionEntry: { id: "registry-change" } });
    } else if (reason === "manager") {
      const { SessionManager } = await import("@earendil-works/pi-coding-agent");
      (h.ctx as unknown as { sessionManager: object }).sessionManager = SessionManager.inMemory(h.cwd);
      await h.emit("session_compact", { compactionEntry: { id: "manager-change" } });
    } else if (reason === "tree") await h.emit("session_tree");
    else if (reason === "abort") await h.emit("turn_end", { message: { stopReason: "aborted" } });
    else await h.emit("session_shutdown", { reason });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.client!.usage().budget?.zombies).toBe(1);
    expect(h.suggestions()).toEqual([]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.observed).toHaveLength(1);
    expect(h.client!.usage().budget?.outstanding).toBe(0);
    expect(h.client!.usage().budget?.zombies).toBe(0);
    expect(h.suggestions()).toEqual([]);
    expect(h.coverage).not.toHaveBeenCalled();
    expect(fs.existsSync(join(h.blocks, ".jev/revisions"))).toBe(false);
    expect(h.client!.usage().costUsd).toBeGreaterThan(0); // unknown late usage retains reserve, never fake zero
  },
);

it("quiet-clock expiry is not an SDK completion barrier: delayed discovery still reaches generation before reload", async () => {
  const h = await wireFixture();
  await h.writePair();
  let releaseRelation!: () => void;
  h.state.heldKind = "relation";
  h.state.hold = new Promise<void>((resolve) => {
    releaseRelation = resolve;
  });
  const relationStarted = h.whenHTTP("relation");
  // Replay an async SDK/auth/transport continuation that the fake scheduler
  // clock cannot drain. This was the old natural()'s entire implementation.
  await vi.advanceTimersByTimeAsync(1000);
  await relationStarted;
  expect(h.ask!.mock.calls.filter(([r]) => r.jobId)).toHaveLength(1);
  expect(h.generate).not.toHaveBeenCalled();
  expect(h.host!.inspect().jobs).toMatchObject([{ state: "running", generateClaims: 0 }]);

  let releaseGeneration!: () => void;
  h.state.heldKind = "generation";
  h.state.hold = new Promise<void>((resolve) => {
    releaseGeneration = resolve;
  });
  const generationStarted = h.whenHTTP("generation");
  releaseRelation();
  await generationStarted;
  expect(h.generate).toHaveBeenCalledTimes(1);
  expect(h.client!.usage().budget?.outstanding).toBe(1);
  expect(h.host!.inspect().jobs).toMatchObject([{ state: "running", generateClaims: 1 }]);
  await h.emit("session_shutdown", { reason: "reload" });
  await vi.advanceTimersByTimeAsync(0);
  expect(h.client!.usage().budget?.zombies).toBe(1);
  releaseGeneration();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.client!.usage().budget).toMatchObject({ outstanding: 0, zombies: 0, disposed: true });
  expect(h.suggestions()).toEqual([]);
  expect(h.coverage).not.toHaveBeenCalled();
  expect(fs.existsSync(join(h.blocks, ".jev/revisions"))).toBe(false);
  expect(h.client!.usage().costUsd).toBeGreaterThan(0);
});

it("same registry with changed model mapping invalidates the binding before a scheduled dispatch", async () => {
  const h = await wireFixture();
  await h.writePair();
  const originalFind = h.registry.find.bind(h.registry);
  vi.spyOn(h.registry, "find").mockImplementation((provider, id) => {
    const m = originalFind(provider, id);
    return m && id === "generation" ? { ...m, baseUrl: "https://changed.invalid" } : m;
  });
  expect(h.binding.isCurrent()).toBe(false);
  await h.natural();
  expect(h.generate).not.toHaveBeenCalled();
  expect(h.suggestions()).toEqual([]);
});

it("raw actual identity is required independently of raw usage; SDK requested id/default zeros never self-certify", async () => {
  const h = await wireFixture();
  await h.writePair();
  h.state.missingRaw = true;
  await h.natural();
  expect(h.ask!.mock.calls.filter(([r]) => r.jobId)).toHaveLength(2);
  expect(h.generate).not.toHaveBeenCalled();
  expect(h.suggestions()).toEqual([]);
});

it("missing raw usage retains reserve while verified raw identity remains usable for suggestion-only work", async () => {
  const h = await wireFixture();
  await h.writePair();
  h.state.missingUsage = true;
  const before = h.client!.usage().costUsd;
  await h.natural();
  expect(h.suggestions()).toHaveLength(1);
  expect(h.suggestions()[0]!.revision!.generationProvenance!.trusted).toBe(true);
  expect(h.client!.usage().budget?.costSource).toBe("mixed");
  expect(h.client!.usage().costUsd).toBeGreaterThan(before);
});

it("a positive but insufficient job cap cannot bypass A by falling back to legacy", async () => {
  const h = await wireFixture({ cap: 0.000001 });
  await h.writePair();
  const before = h.calls.length;
  await h.natural();
  expect(h.ask!.mock.calls.filter(([r]) => r.jobId)).toHaveLength(1);
  expect(h.calls).toHaveLength(before);
  expect(h.generate).not.toHaveBeenCalled();
  expect(h.suggestions()).toEqual([]);
});

it("last SDK payload is recounted against its reservation; an underquote sends zero P50 HTTP", async () => {
  const h = await wireFixture();
  await h.writePair();
  const before = h.calls.length;
  h.state.underquote = true; // intentionally INVALID synthetic certificate, not a successful tokenizer
  await h.natural();
  expect(h.ask!.mock.calls.filter(([r]) => r.jobId)).toHaveLength(1);
  expect(h.calls).toHaveLength(before);
  expect(h.generate).not.toHaveBeenCalled();
  expect(h.suggestions()).toEqual([]);
});

it("SDK bounded classifier transient response has no hidden retry", async () => {
  const h = await wireFixture();
  await h.writePair();
  const before = h.calls.length;
  h.state.classifierStatus = 429;
  await h.natural();
  expect(h.ask!.mock.calls.filter(([r]) => r.jobId)).toHaveLength(1);
  expect(h.calls).toHaveLength(before + 1);
  expect(h.generate).not.toHaveBeenCalled();
  expect(h.suggestions()).toEqual([]);
});

it("configured non-streaming proxy remains effective-off for P50, all legacy classifier traffic uses that proxy", async () => {
  const h = await wireFixture({ proxy: "http://offline-proxy.invalid:9" });
  await h.writePair();
  await h.natural();
  expect(h.calls.length).toBeGreaterThan(0);
  expect(h.proxyRequests).toHaveLength(h.calls.length);
  expect(h.calls.every((c) => c.payload.max_output_tokens === undefined)).toBe(true);
  expect(h.generate).not.toHaveBeenCalled();
  expect(h.suggestions()).toEqual([]);
  expect(h.warning.mock.calls.filter(([s]) => String(s).includes("streaming-proxy-contract-missing"))).toHaveLength(1);
});

it("missing-binding vs explicit P50-off is byte-identical for real legacy tool/SDK requests/index and hook surface", async () => {
  let projectCwd: string | undefined;
  const capture = async (off: boolean) => {
    const h = await wireFixture({ noBinding: true, off, ...(projectCwd ? { projectCwd } : {}) });
    projectCwd = h.cwd;
    const writes = await h.writePair();
    await h.natural();
    await h.emit("before_agent_start", {
      messageType: "user",
      prompt: "How do we preserve the directory lock and budget?",
    });
    await h.emit("tool_call", { toolName: "read", toolCallId: "differential", input: { path: "rules.md" } });
    await h.emit("tool_result", {
      toolName: "read",
      toolCallId: "differential",
      input: { path: "rules.md" },
      content: [],
      isError: false,
    });
    await h.emit("turn_end", { message: { stopReason: "stop" } });
    await vi.advanceTimersByTimeAsync(0);
    const files = fs
      .readdirSync(h.blocks, { recursive: true })
      .sort()
      .filter((n) => fs.statSync(join(h.blocks, String(n))).isFile());
    const data = {
      writes,
      calls: h.calls.map((c) => c.payload),
      files: files.map((n) => [n, fs.readFileSync(join(h.blocks, String(n)), "utf8")]),
      hooks: [...h.handlers].map(([name, fns]) => [name, fns.length]),
      tools: [...h.tools].map(([name, tool]) => [
        name,
        JSON.stringify({ description: tool.description, parameters: tool.parameters }),
      ]),
      sent: h.sent,
    };
    await h.emit("session_shutdown", { reason: "shutdown" });
    return data;
  };
  expect(await capture(false)).toEqual(await capture(true));
});

it("binding-loss observation cannot reopen a prior user-aborted scheduler while legacy Jev continues", async () => {
  const h = await wireFixture();
  await h.writePair();
  await h.emit("turn_end", { message: { stopReason: "aborted" } });
  // An ordinary actual client request observes effective-off after abort. It
  // must not let registry invalidation re-enable the aborted scheduler.
  const answer = await h.client!.ask({
    duty: "tag",
    registry: h.binding.registry,
    state: { probe: "ok" },
    questions: { probe: { type: "bool", instructions: "Check", criteria: { true: "ok", false: "no" } } },
    mode: "sync",
    budgetMs: 1000,
  });
  expect(answer.ok).toBe(true);
  await h.create("Another genuine external write about the lock.");
  await h.create("Another genuine external write about budget.");
  await h.natural();
  expect(h.generate).not.toHaveBeenCalled();
  expect(h.suggestions()).toEqual([]);
});

it("actual scopes owner signal revokes an old flight on manager-context rebind, then next natural writes use the new owner with the SAME client", async () => {
  const h = await wireFixture();
  let release!: () => void;
  h.state.heldKind = "generation";
  h.state.hold = new Promise<void>((r) => {
    release = r;
  });
  await h.writePair();
  await h.natural();
  expect(h.generate).toHaveBeenCalledTimes(1);
  const old = h.memoryScopes!.current()!;
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  (h.ctx as unknown as { sessionManager: object }).sessionManager = SessionManager.inMemory(h.cwd);
  await h.emit("input", { text: "new native context", source: "rpc" });
  expect(h.memoryScopes!.current()).not.toBe(old);
  expect(old.signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.client!.usage().budget?.zombies).toBe(1);
  release();
  h.state.heldKind = "";
  await vi.advanceTimersByTimeAsync(0);
  expect(h.suggestions()).toEqual([]);
  await Promise.all([
    h.create("A new current-owner durable lock rule."),
    h.create("A new current-owner durable budget rule."),
  ]);
  await h.natural();
  expect(h.suggestions().length).toBeGreaterThan(0);
  expect(h.generate!.mock.calls.length).toBeGreaterThan(1);
  expect(h.observed).toHaveLength(1);
});

it("an E effect followed by synchronous abort still invalidates the original cwd cache exactly through onAfterWrite", async () => {
  const { seedWireSource } = await import("./revision-wire-source.js");
  const safe = await import("../../../src/memory/safe-fs.js");
  const { EntryIndex } = await import("../../../src/memory/jev/entries.js");
  const h = await wireFixture({ auto: true });
  await h.writePair();
  await seedWireSource(h);
  h.state.relation = "supersedes";
  await h.create("External lock scheduling rule.");
  await h.create("External budget scheduling rule.");
  const invalidation = vi.spyOn(EntryIndex.prototype, "invalidate");
  const replace = safe.replaceRevisionObserved;
  let effect = false;
  vi.spyOn(safe, "replaceRevisionObserved").mockImplementation((...args) => {
    const result = replace(...args); // REAL data syscall/observation, not a simulated success
    if (args[0] === h.blocks) {
      effect = true;
      // Reentrant lifecycle event AFTER the real effect, before E observes its
      // final guard/result. It may be unknown, never permission to retry.
      void h.emit("turn_end", { message: { stopReason: "aborted" } });
    }
    return result;
  });
  await h.natural();
  expect(effect).toBe(true);
  expect(fs.readFileSync(join(h.blocks, "rules.002.md"), "utf8")).toContain("status: superseded");
  expect(invalidation.mock.calls.some(([dir]) => dir === h.dir)).toBe(true);
  const count = h.calls.length;
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.calls).toHaveLength(count);
});
