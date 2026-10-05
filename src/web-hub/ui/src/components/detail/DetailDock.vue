<!--
  Bottom dock (ui-design.md §5.4/§6.5, vue-plan.md v2.1 §3.2/§5.2 — P3; control plane per
  control-plan.md v2.1 §7.4/§7.7 — C5). Lives in the document flow (`.detail`'s column flex,
  `dock.css`), never `position: fixed`, so it can never cover the transcript (K19's soft-
  keyboard interaction is a W5 真机 item).

  Control ON (`CONTROL_VIEW.enabled`): QueueList (mergeQueue model) + Composer + StopButton
  replace the read-only line; the Latest button is kept. (2026-10, user-decided: the Follow
  switch is retired — the transcript already auto-follows symmetrically: scrolling up turns
  follow off, returning to the bottom turns it back on, and the jump-to-latest button covers
  the manual case.) Command mode
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
import type { CommandOutputWire } from "@protocol/messages.js";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import type { DetailDockEmits, DetailDockProps } from "../../contracts.js";
import Composer from "../control/Composer.vue";
import CommandConfirm from "../control/CommandConfirm.vue";
import CommandResult from "../control/CommandResult.vue";
import QueueList from "../control/QueueList.vue";
import StopButton from "../control/StopButton.vue";
import { CONTROL_VIEW } from "../control/controlContext.js";

const props = defineProps<DetailDockProps>();
const emit = defineEmits<DetailDockEmits>();
const { t } = useI18n();

const view = inject(CONTROL_VIEW, null);

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
  void c.sendPrompt(key, text, deliver).catch(() => {});
}

function onStop(): void {
  const c = handle();
  const key = agentKey();
  if (!c || key === null) return;
  void c.abort(key).catch(() => {});
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
      <StopButton :busy="busy" :queue-count="queueItems.length" @stop="onStop" />
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
