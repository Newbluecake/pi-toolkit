<!--
  Bottom dock (ui-design.md §5.4/§6.5, vue-plan.md v2.1 §3.2/§5.2 — P3; control plane per
  control-plan.md v2.1 §7.4/§7.7 — C5). Lives in the document flow (`.detail`'s column flex,
  `dock.css`), never `position: fixed`, so it can never cover the transcript (K19's soft-
  keyboard interaction is a W5 真机 item).

  Control ON (`CONTROL_VIEW.enabled`): QueueList (mergeQueue model) + Composer replace the
  read-only line; the Latest button is kept. (2026-10, user-decided: the Follow
  switch is retired — the transcript already auto-follows symmetrically: scrolling up turns
  follow off, returning to the bottom turns it back on, and the jump-to-latest button covers
  the manual case. The Stop button later moved INTO the composer's input edge — same
  `CONTROL_VIEW` channel.) Command mode
  orchestration lives HERE because the frozen `DetailDockEmits` has no send/stop/retry/discard
  events (C0 froze only the props side) — the dock calls the `ControlHandle` straight from the
  injected `CONTROL_VIEW` instead of emitting up:
    - `/cmd` text ⇒ policy check (deny never leaves the palette) ⇒ `runCommand`;
      `E_CONFIRM_REQUIRED` ⇒ inline `CommandConfirm` (re-issued with a NEW id + confirm:true);
      sync results (incl. §4.9 captured output) render in `CommandResult`; `completion:"async"`
      tracks the pendingCtl item and does one `queryOnly` when it settles (SSE cmd_late never
      carries output, §6.6) — plus the "waiting in the terminal" banner when a non-ask_user
      ui_prompt_start shows up within 2s of dispatch (§7.7).
    - plain text ⇒ `sendPrompt` (Alt+Enter ⇒ followUp); a `//` prefix forces text.
    - QueueList `retry` on a `notExecuted` item re-sends with a NEW id (§7.7) and discards the
      old one; everything else retries with the SAME id (hub/agent dedupe, §3.4/§7.3).

  Control OFF: the original read-only line, plus the reason (§7.4: hub without cmd.v1 / agent
  without control.cmd / agent offline).
-->
<script setup lang="ts">
import { computed, inject, onUnmounted, ref, watch } from "vue";
import { commandPolicyFor, parseSlash } from "@logic/control.js";
import { mentionSendRoute } from "@logic/mention.js";
import { clientImageBudget, previewScopeOf } from "@logic/preview.js";
import {
  expandPromptWithFiles,
  FILE_MENTION_MAX_FILES,
  findFileMentionTokens,
  isImagePath,
} from "@logic/file-mention.js";
import type { CommandOutputWire } from "@protocol/messages.js";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import type { DetailDockEmits, DetailDockProps } from "../../contracts.js";
import Composer from "../control/Composer.vue";
import CommandConfirm from "../control/CommandConfirm.vue";
import CommandResult from "../control/CommandResult.vue";
import QueueList from "../control/QueueList.vue";
import { CONTROL_ENV, CONTROL_VIEW } from "../control/controlContext.js";
import { HUB_CTX } from "../control/controlContext.js";

const props = defineProps<DetailDockProps>();
const emit = defineEmits<DetailDockEmits>();
const { t } = useI18n();

const view = inject(CONTROL_VIEW, null);
const hub = inject(HUB_CTX, null);
const env = inject(CONTROL_ENV, null);

const ctlEnabled = computed(() =>
  view !== null ? view.enabled.value : props.control != null && props.readonlyReason === undefined,
);
const busy = computed(() => (view !== null ? view.busy.value : props.busy === true));
const queueItems = computed<readonly unknown[]>(() => (view !== null ? view.queueItems.value : (props.queue ?? [])));
const reasonKey = computed(() => (view !== null ? view.readonlyReason.value : (props.readonlyReason ?? null)));

// --- command mode orchestration --------------------------------------------------------------

interface CmdResultState {
  readonly name: string;
  readonly state: "running" | "done" | "failed";
  readonly output?: CommandOutputWire | null;
  readonly captured?: boolean;
  readonly error?: string;
  readonly message?: string;
}

const pendingConfirm = ref<{ name: string; args: string; message?: string } | null>(null);
const cmdResult = ref<CmdResultState | null>(null);
const cmdWaitingTerminal = ref(false);

/** pendingCtl id of the in-flight async command we're tracking (found by kind+name after the
 * optimistic item lands in the reducer). */
let trackingCmd: { id: string | null; name: string } | null = null;
let waitPromptTimer: ReturnType<typeof setTimeout> | undefined;

function agentKey(): string | null {
  return view?.agentKey ?? null;
}

function handle(): import("../../types.js").ControlHandle | null {
  return view?.control ?? props.control ?? null;
}

async function runCommand(name: string, args: string, confirm: boolean): Promise<void> {
  const c = handle();
  const key = agentKey();
  if (!c || key === null) return;
  pendingConfirm.value = null;
  cmdResult.value = { name, state: "running" };
  cmdWaitingTerminal.value = false;
  trackingCmd = { id: null, name };
  watchCommandItem();

  // §7.7: a non-ask_user ui_prompt_start within 2s of dispatch ⇒ the command is parked on a
  // terminal interaction (third-party extension commands; pi-toolkit's own are degraded).
  const promptsBefore = promptCount();
  if (waitPromptTimer !== undefined) clearTimeout(waitPromptTimer);
  waitPromptTimer = setTimeout(() => {
    cmdWaitingTerminal.value = promptCount() > promptsBefore;
  }, 2000);

  const outcome = await c.runCommand(key, name, args, confirm ? { confirm: true } : undefined);
  if (!outcome.ok) {
    trackingCmd = null;
    if (outcome.error === "E_CONFIRM_REQUIRED") {
      cmdResult.value = null;
      pendingConfirm.value = {
        name,
        args,
        ...(outcome.message !== undefined ? { message: outcome.message } : {}),
      };
    } else {
      cmdResult.value = {
        name,
        state: "failed",
        error: outcome.error ?? "E_FAILED",
        ...(outcome.message !== undefined ? { message: outcome.message } : {}),
      };
    }
    return;
  }
  const data = (outcome.data ?? {}) as {
    completion?: string;
    captured?: boolean;
    output?: CommandOutputWire;
  };
  if (data.completion === "async" || data.completion === "unknown") {
    return; // stays "running" — the pendingCtl watcher + queryOnly finish it (cmd_late path)
  }
  trackingCmd = null;
  cmdResult.value = {
    name,
    state: "done",
    captured: data.captured === true,
    output: data.output ?? null,
  };
}

function promptCount(): number {
  return view?.agent.value.prompts.length ?? 0;
}

/** Track the async command's optimistic item: when the ledger resolves it (item leaves
 * pendingCtl — cmd_late ok) do ONE queryOnly for the full result (with output); a failed/
 * notExecuted terminal state renders straight from the item. */
function watchCommandItem(): void {
  const stop = watch(
    () => (view ? view.agent.value.pendingCtl : undefined),
    (pending) => {
      const tracking = trackingCmd;
      if (tracking === null || view === null) {
        stop();
        return;
      }
      const items = Array.isArray(pending) ? (pending as readonly Record<string, unknown>[]) : [];
      if (tracking.id === null) {
        const found = items.find((it) => it["kind"] === "command" && it["name"] === tracking.name);
        if (found && typeof found["id"] === "string") tracking.id = found["id"];
        return;
      }
      const item = items.find((it) => it["id"] === tracking.id);
      if (item !== undefined) {
        if (item["state"] === "failed" || item["state"] === "notExecuted") {
          trackingCmd = null;
          stop();
          cmdResult.value = {
            name: tracking.name,
            state: "failed",
            error: typeof item["error"] === "string" ? item["error"] : "E_FAILED",
            ...(typeof item["message"] === "string" ? { message: item["message"] } : {}),
          };
        }
        return;
      }
      // Item gone ⇒ settled ok. One queryOnly to fetch the output (§6.6: SSE cmd_late has none).
      trackingCmd = null;
      stop();
      const c = handle();
      const key = agentKey();
      const id = tracking.id;
      if (!c || key === null || id === null) return;
      void c.query(key, id).then((outcome) => {
        if (!cmdResult.value || cmdResult.value.name !== tracking.name) return;
        if (outcome.ok) {
          const data = (outcome.data ?? {}) as { captured?: boolean; output?: CommandOutputWire };
          cmdResult.value = {
            name: tracking.name,
            state: "done",
            captured: data.captured === true,
            output: data.output ?? null,
          };
        } else {
          cmdResult.value = { name: tracking.name, state: "done", captured: false, output: null };
        }
      });
    },
  );
}

function onSend(text: string, deliver: "steer" | "followUp"): void {
  const c = handle();
  const key = agentKey();
  if (!c || key === null) return;
  const slash = parseSlash(text);
  const commands = view?.commands.value ?? [];
  const commandMode = slash !== undefined && (view?.commandsEnabled.value ?? false);
  if (commandMode && slash) {
    const policy = commandPolicyFor([...commands], slash.name, busy.value);
    if (policy === "deny") return; // palette already shows the reason; never falls back to text
    void runCommand(slash.name, slash.args, false);
    return;
  }
  // @mention routing (task #11): a leading `@label msg` resolving to a RUNNING fleet row
  // steers that sub-agent instead of opening a new turn (steer works in both busy and idle —
  // interjecting IS the steer semantics). Terminal/unknown labels stay plain text, exactly
  // like the terminal's own mention interceptor, so web and TUI never diverge. Failures ride
  // the standard pendingCtl path (QueueList's "steer sub" item with retry), same as
  // FleetActions' inline steer.
  const mention = mentionSendRoute(text, view?.agent.value.fleet ?? []);
  if (mention.kind === "steer") {
    void c.steerSub(key, mention.runId, mention.message).catch(() => {});
    return;
  }
  // @文件补全 send expansion (file-mention): every `@<absolute path>` token under the
  // session cwd gets its TEXT fetched through the preview endpoint and appended as an
  // attachment-style block (≤ the shared 48 KiB prompt cap). Never blocks the send: no
  // scope/transport, no tokens, or any failed fetch (image/binary/too large/timeout) just
  // leaves the token as plain text — the path itself is model-readable — with a console note.
  void expandFileRefs(text).then((expanded) => {
    c.sendPrompt(key, expanded, deliver).catch(() => {});
  });
}

/** Per-file fetch deadline — the preview transport's own 40s budget is for human-scale
 * previews; a send must not hang on one dead file (5s here, all fetches in parallel). */
const FILE_REF_FETCH_MS = 5_000;

interface RefScope {
  readonly agentKey: string;
  readonly sessionId: string;
  readonly cwd: string | null;
}

async function fetchFileText(path: string, scope: RefScope): Promise<{ path: string; text: string } | null> {
  const preview = hub?.preview;
  if (preview === undefined || scope.cwd === null) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FILE_REF_FETCH_MS);
  try {
    const r = await preview.fetch(
      { agentKey: scope.agentKey, sessionId: scope.sessionId, path },
      { signal: ctl.signal, maxPixels: clientImageBudget({ coarse: false }) },
    );
    if (!r.ok || r.kind !== "text") return null; // images/binary/unsupported — path stays
    return { path, text: r.text };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The send-time file expansion: detect tokens under the session cwd, fetch their text in
 * parallel (image extensions skipped up front), compose the block. Returns the ORIGINAL text
 * unchanged whenever anything in the chain is unavailable — the send always proceeds. */
async function expandFileRefs(text: string): Promise<string> {
  const agent = view?.agent.value;
  if (hub === null || view === null || agent === undefined) return text;
  const scope = previewScopeOf({
    mode: env?.authMode ?? "token",
    hubCaps: (hub.state.value.hub as { caps?: unknown } | null | undefined)?.caps,
    hasTransport: hub.preview !== undefined,
    agentKey: view.agentKey,
    session: agent.session,
  });
  if (scope === null || scope.cwd === null) return text;
  const tokens = findFileMentionTokens(text, scope.cwd);
  if (tokens.length === 0) return text;
  const wanted = tokens.slice(0, FILE_MENTION_MAX_FILES).filter((tk) => !isImagePath(tk.path));
  const settled = await Promise.all(wanted.map((tk) => fetchFileText(tk.path, scope)));
  const fetched = settled.filter((r): r is { path: string; text: string } => r !== null);
  const out = expandPromptWithFiles(text, scope.cwd, fetched);
  // Skip notes stay OUT of the prompt (requirement: skip + console, 文案不进 prompt).
  if (out.skipped.length > 0) {
    console.warn("[web-hub] file mention not inlined:", out.skipped.join(", "));
  }
  return out.text;
}

function findPending(id: string): Record<string, unknown> | undefined {
  const pending = view?.agent.value.pendingCtl;
  if (!Array.isArray(pending)) return undefined;
  return (pending as readonly Record<string, unknown>[]).find((it) => it["id"] === id);
}

function onQueueRetry(id: string): void {
  const c = handle();
  const key = agentKey();
  if (!c || key === null) return;
  const item = findPending(id);
  // §7.7: notExecuted (E_UNKNOWN_ID) re-sends with a NEW id — the old id provably never ran.
  if (item && item["state"] === "notExecuted") {
    if (item["kind"] === "prompt" && typeof item["text"] === "string") {
      const deliver = item["deliver"] === "followUp" ? "followUp" : "steer";
      void c.sendPrompt(key, item["text"], deliver).catch(() => {});
    } else if (item["kind"] === "command" && typeof item["name"] === "string") {
      void runCommand(item["name"], "", false);
    }
    c.discard(key, id);
    return;
  }
  void c.retry(key, id).catch(() => {});
}

function onQueueDiscard(id: string): void {
  const c = handle();
  const key = agentKey();
  if (!c || key === null) return;
  c.discard(key, id);
}

onUnmounted(() => {
  if (waitPromptTimer !== undefined) clearTimeout(waitPromptTimer);
});
</script>

<template>
  <div v-if="ctlEnabled" class="dock dock-ctl">
    <QueueList :items="queueItems" @retry="onQueueRetry" @discard="onQueueDiscard" />
    <CommandResult
      v-if="cmdResult"
      :name="cmdResult.name"
      :state="cmdResult.state"
      :output="cmdResult.output ?? null"
      :captured="cmdResult.captured"
      :error="cmdResult.error"
      :message="cmdResult.message"
      :waiting-terminal="cmdWaitingTerminal"
      @dismiss="cmdResult = null"
    />
    <CommandConfirm
      v-if="pendingConfirm"
      :name="pendingConfirm.name"
      :args="pendingConfirm.args"
      :message="pendingConfirm.message"
      @confirm="void runCommand(pendingConfirm!.name, pendingConfirm!.args, true)"
      @cancel="pendingConfirm = null"
    />
    <div class="dock-row">
      <Composer :enabled="true" :busy="busy" @send="onSend" />
      <div class="dock-actions">
        <button
          v-if="!following && newCount > 0"
          class="btn btn-primary jump-latest"
          type="button"
          @click="emit('jump')"
        >
          <AppIcon name="arrow-down" />{{ t("detail.latest")
          }}<span class="badge-new">{{ t("detail.newCount", { n: newCount }) }}</span>
        </button>
      </div>
    </div>
  </div>

  <div v-else class="dock">
    <span class="readonly"
      ><AppIcon name="eye" class="icon-sm" />{{ t(reasonKey ?? "common.readonly")
      }}<span v-if="reasonKey === null" class="long"> {{ t("detail.dockLong") }}</span></span
    >
    <div class="dock-actions">
      <button v-if="!following && newCount > 0" class="btn btn-primary jump-latest" type="button" @click="emit('jump')">
        <AppIcon name="arrow-down" />{{ t("detail.latest")
        }}<span class="badge-new">{{ t("detail.newCount", { n: newCount }) }}</span>
      </button>
    </div>
  </div>
</template>
