/** Exact O7239 tool-build instrumentation, NEVER applied to a worktree or production N.
 * Observe original continuations/physical results/ACK CAS. No replacement authority,
 * proof, prune, ACK, timeout or admission result. Builder records originals + patch.
 */
export function patchOldMaintenanceSource(path: string, source: string): string {
  const once = (from: string, to: string) => {
    if (source.split(from).length !== 2) throw new Error(`fixed O patch drift: ${path}`);
    source = source.replace(from, to);
  };
  if (path === "src/web-hub/agent/terminal/owner.ts") {
    once(
      "  private readonly rows = new Map<string, Row>();",
      `  private readonly rows = new Map<string, Row>();
  private readonly maintenanceFutures = new Set<Promise<void>>();
  private readonly maintenanceAcks: unknown[] = [];
  private maintenanceOverflow = false;
  maintenanceSnapshot() {
    return structuredClone({
      disposed: this.disposed, pendingFutures: this.maintenanceFutures.size,
      channels: this.channels.size, authorityKnown: !!this.localAuthority,
      authorityActive: this.localAuthority?.active ?? false,
      auditOverflow: this.maintenanceOverflow, acks: this.maintenanceAcks,
      processIdentity: this.processIdentity,
      receipts: receiptStore().map(r => ({entry: r.entry, physical: r.physical, confirmed: !!r.confirmed})),
      handoff: handoffStore(), resources: this.resourceEntries(),
      rows: [...this.rows.values()].map(r => ({identity: r.identity, state: r.state,
        resolved: !!r.resolved, spawnSettled: r.backend?.spawnSettled ?? false,
        physical: r.physical, inputPending: !!r.input, resizePending: !!r.resizePromise}))
    });
  }`,
    );
    for (const [name, signature, args] of [
      ["open", 'f: Extract<TermReq, { op: "open" }>', "f"],
      ["input", 'r: Row, a: Attachment, f: Extract<TermReq, { op: "input" }>', "r, a, f"],
      ["inventory", 'f: Extract<TermReq, { op: "inventory" }>', "f"],
    ]) {
      once(
        `  private async ${name}(${signature}): Promise<void> {`,
        `  private ${name}(${signature}): Promise<void> {
    const original = this.maintenanceOriginal_${name}(${args});
    this.maintenanceFutures.add(original);
    void original.then(() => this.maintenanceFutures.delete(original), () => this.maintenanceFutures.delete(original));
    return original;
  }
  private async maintenanceOriginal_${name}(${signature}): Promise<void> {`,
      );
    }
    once(
      "    this.journalFloors.set(snapshot.challenge.hubBootId, f.resolved.journalRevision);",
      `    this.journalFloors.set(snapshot.challenge.hubBootId, f.resolved.journalRevision);
    if (this.maintenanceAcks.length < 32) this.maintenanceAcks.push(structuredClone(f.resolved));
    else this.maintenanceOverflow = true;`,
    );
  } else if (path === "src/web-hub/hub/terminal/resource-fence.ts") {
    once(
      '  private state: TerminalQuarantine["state"] = "collecting";',
      `  private state: TerminalQuarantine["state"] = "collecting";
  private readonly maintenanceCommits: unknown[] = [];
  private maintenanceOverflow = false;
  maintenanceSnapshot() {
    return structuredClone({loaded: this.loaded, failed: this.failed, busy: this.busy,
      journal: this.journal, state: this.state, commits: this.maintenanceCommits, auditOverflow: this.maintenanceOverflow,
      incompleteCollections: [...this.collections.values()].filter(c => !c.complete).length});
  }`,
    );
    once(
      "      this.journal = next;",
      `      this.journal = next;
      if (this.maintenanceCommits.length < 64) this.maintenanceCommits.push(structuredClone({before: old, after: next}));
      else this.maintenanceOverflow = true;`,
    );
  } else if (path === "src/web-hub/hub/terminal/service.ts") {
    once(
      "  let disposed = false;",
      "  let disposed = false;\n  const maintenanceFutures = new Set<Promise<unknown>>();",
    );
    once(
      "  async function request<K extends keyof TerminalHttpRequests>(",
      `  function request<K extends keyof TerminalHttpRequests>(...args: Parameters<typeof maintenanceOriginalRequest<K>>) {
    const original = maintenanceOriginalRequest<K>(...args);
    maintenanceFutures.add(original);
    void original.then(() => maintenanceFutures.delete(original), () => maintenanceFutures.delete(original));
    return original;
  }
  async function maintenanceOriginalRequest<K extends keyof TerminalHttpRequests>(`,
    );
    for (const name of ["exchange", "negotiate", "scope", "reclaim", "collect", "collectRaw"]) {
      once(
        `  async function ${name}(`,
        `  function ${name}(...args: Parameters<typeof maintenanceOriginal_${name}>) {
    const original = maintenanceOriginal_${name}(...args);
    maintenanceFutures.add(original);
    void original.then(() => maintenanceFutures.delete(original), () => maintenanceFutures.delete(original));
    return original;
  }
  async function maintenanceOriginal_${name}(`,
      );
    }
    once(
      "    auditHealth: () => ({ failures: auditFailures }),",
      `    auditHealth: () => ({ failures: auditFailures }),
    maintenanceSnapshot: () => ({disposed, pendingRequests: maintenanceFutures.size,
      waits: waits.size, offers: offers.size, inventoryWaits: inventoryWaits.size,
      collections: collections.size, pendingOpens: [...records.values()].filter(r => r.state === "starting").length}),`,
    );
  } else if (path === "src/web-hub/hub/assembly-terminal.ts") {
    once(
      "    service,\n    routes,\n    ingress,",
      "    service,\n    maintenanceFence: () => fence.maintenanceSnapshot(),\n    routes,\n    ingress,",
    );
  } else if (path === "src/web-hub/hub/hub.ts") {
    once(
      "export interface RunningHub {",
      "export interface RunningHub {\n  readonly maintenanceTerminal?: Awaited<ReturnType<typeof assembleTerminal>>;",
    );
    once(
      "      httpPort,\n      info,\n      identity: owner.identity,",
      "      httpPort,\n      info,\n      maintenanceTerminal: terminal,\n      identity: owner.identity,",
    );
  }
  return source;
}
export const OLD_PATCH_FILES = [
  "src/web-hub/agent/terminal/owner.ts",
  "src/web-hub/hub/terminal/resource-fence.ts",
  "src/web-hub/hub/terminal/service.ts",
  "src/web-hub/hub/assembly-terminal.ts",
  "src/web-hub/hub/hub.ts",
] as const;
