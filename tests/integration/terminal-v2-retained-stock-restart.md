# P7B stock consumer restart gate — blocked, NOT accepted

**Baseline checkpoint only:** this red gate records the pre-fix `7d3f1d05` defect.
After the separately authorized loader repair is integrated, retain the bare-jiti diagnostic as
an explicit negative control, not as a required production-positive startup. Resume positive
acceptance only through the actual consumer's sealed pi launcher / formal product spawn plan;
do not hand-build aliases or treat this raw preflight as the repaired startup contract.
The repair plan is `/home/bluecake/pi-evidence-t51/hub-loader-fix-plan.md`.

This dedicated integration fixture requires **two real, already unpacked publication consumers**:
`PI_TOOLKIT_STOCK_CONSUMERS/npm` and `PI_TOOLKIT_STOCK_CONSUMERS/zip`. Neither may contain
`node_modules`. There is deliberately no checkout fallback or missing-resource skip.

Run one cell per bounded command (Node 22; private HOME/cache/tmp; workers 1; no cache):

```sh
PI_TOOLKIT_STOCK_CONSUMERS=/absolute/private/consumers \
  node node_modules/vitest/vitest.mjs run --project tier2 --maxWorkers=1 --no-cache \
  tests/integration/terminal-v2-retained-stock-restart.test.ts -t 'stock npm L2'
# Repeat with -t 'stock zip L2'.
```

Do not invoke `npm test` to run this gate: it is an explicitly provisioned consumer acceptance
fixture, not permission to rebuild/reinstall packages or run all tests. An unprovisioned invocation
fails clearly, rather than replacing the consumer with the development checkout or skipping green.

## What is real

- Setup reuses the existing ordinary-O fixture path: measured, unpatched O7239 source; original
  pi SDK; two actual prior SDK sessions; original native test-backend PTYs and original persisted
  journals. Only this **old O setup** uses the previously audited private backend fixture seam.
- The subsequent CLI is the actual selected consumer's maintenance executable, run in independent
  processes; it initializes and publishes that consumer through the original sealed launcher.
- Stock N is never compiled from or imported as a business service from the development checkout.
  The main load preflight executes the original profile SDK's `jiti-cli.mjs` and the **consumer's
  unchanged `src/web-hub/hub/main.ts`**. It intentionally provides no `PI_WEBHUB_CONFIG` and no
  `PI_WEBHUB_TERMINAL_SOURCE`; a loadable main must exit 2 at its original missing-config check.
  Resolving jiti from `profile.piCli` is the original SDK lookup, not a resolver override.
- The downstream scaffold invokes the sealed launcher in RPC mode, checks original SDK
  `get_commands.sourceInfo` and actual process argv/artifact hashes, and checks close/new PID/new
  login/new session/retained identity and quota/independent CLI/off publication/return-N. Those
  downstream assertions have **NOT run successfully** in this package.

## Current blocking failure

Both actual npm and ZIP consumers fail the stock-main preflight with exit **1**, not expected 2:

```text
Error: Cannot find module '@sinclair/typebox'
Require stack:
- <consumer>/src/web-hub/protocol/feishu.ts
```

This occurs during imports, **before main reads its missing configuration**, and without an N
PTY/backend or business service starting. The gate remains red. No `test.fails`, skip, `NODE_PATH`,
consumer `node_modules`, package modification, test-only loader alias or expected-failure success
is used to conceal it. Production resolution/packaging repair belongs to a separately authorized
package. Earlier real sealed-launcher RPC attempts loaded the npm consumer extension successfully
but timed out waiting for a stock hub; the standalone failure identifies a concrete module-load
blocker. A prior namespace explanation was a hypothesis, **not established** by those timeouts.

## Scope and limits

There is no stock N backend injection. Production PTY setup intentionally resolves HOME/shell via
`pwd.getpwuid(uid)`, ignoring the private HOME. The older native test-backend seam is therefore
**not evidence of a closed stock test UID**. Without separately authorized isolated UID/container
resources, L1 stock create/input/PID/physical-prune remains **NOT RUN**, and is not parameterized as
though tested. Do not read or execute real user rc, install tools, alter users/namespaces or introduce
an adapter to make this test pass.

The blocked L2 scaffold only attempts creation when the real principal quota is already full.
Its intended no-backend evidence combines original `E_LIMIT effect:none`, unchanged allocations
and supplemental process sampling; process sampling is **not an exact backend-factory counter**.
No L2 runtime/zero-backend/restart assertion is claimed while the main-load gate is red.

The original automatic `spawnHub` path and an explicitly invoked stock business main are separate
claims. No successful automatic-spawn/namespace verdict or stock N OS-process restart is claimed.
No Inspector/ACK/gone/reboot or deployment contract is reopened.

Full chronological red logs, original SDK/consumer hashes and the scoped verdict are in the external
`/home/bluecake/pi-evidence-t51/stock-restart-report.md`. Temporary private fixture state is retained
as evidence; authenticating token/state stays at its original private location and is not archived
or restored.
