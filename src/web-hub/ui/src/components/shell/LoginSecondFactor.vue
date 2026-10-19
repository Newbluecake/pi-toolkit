<!--
  LAN security r2 §5.9 (package G): the second-factor step of a password login from a new IP.
  Approved layout = preview variant B (`~/pwh-preview/lan-security.html` §2B): ONE primary
  method panel (authenticator-app code / Feishu approval wait / recovery code) plus an
  「其他方式」 row of links to switch, and 「取消登录」. Only methods the challenge actually
  offers are shown (`challenge.methods`; Feishu additionally requires `challenge.feishu ===
  "sent"` — an unsent card can never be approved, plan §5.7).

  Purely declarative over the parent's state: the parent (LoginView, I-owned) drives
  `busy`/`attemptsLeft`/`lockedUntil`/`now` from `@logic/password-client.js`'s
  `submitSecondFactor`/`waitApproval` outcomes and owns all terminal handling (expired /
  exhausted / denied ⇒ back to the password form). This component never fetches, never
  stores the code after emitting `submit`, and never renders HTML (no v-html).

  Local terminal states derived from the frozen props alone: `now >= challenge.expiresAt`
  ⇒ expired view with 返回登录 (emits `cancel`); `attemptsLeft === 0` ⇒ attempts-exhausted
  view (the challenge is server-side dead:attempts, §5.4). `lockedUntil` (ms epoch, from a
  `E_2FA_METHOD_LOCKED` reply's `retryAfterMs`) pins a per-method lock notice with a live
  countdown off the `now` prop; other methods stay usable (§5.5).
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import {
  LAN_2FA_LIMITS,
  TOTP_CODE_RE,
  normalizeRecoveryCode,
  type Lan2faChallenge,
  type LanFactorBody,
} from "@protocol/lan-2fa.js";

type Method = "totp" | "feishu" | "recovery";

const props = defineProps<{
  challenge: Lan2faChallenge;
  busy: boolean;
  attemptsLeft?: number;
  lockedUntil?: number;
  now: number;
}>();
const emit = defineEmits<{ submit: [body: LanFactorBody]; cancel: []; wait: [] }>();
const { t } = useI18n();

const challengeMinutes = Math.max(1, Math.round(LAN_2FA_LIMITS.challengeMs / 60_000));

/** Feishu is offerable only when the challenge says a card was actually sent (§5.7). */
const feishuUsable = computed(() => props.challenge.methods.includes("feishu") && props.challenge.feishu === "sent");

/** Methods the UI may offer, in the challenge's own order (wire guarantees ≥1 method). */
const usableMethods = computed<Method[]>(() => {
  const out: Method[] = [];
  for (const m of props.challenge.methods) {
    if (m === "totp" || m === "recovery") out.push(m);
    else if (m === "feishu" && feishuUsable.value) out.push(m);
  }
  return out;
});

function initialMethod(): Method {
  const u = usableMethods.value;
  if (u.includes("totp")) return "totp";
  if (u.includes("feishu")) return "feishu";
  return "recovery";
}

/** A challenge whose only offered methods are unusable (e.g. `["feishu"]` with the card
 *  unsent, §5.7) gets an honest dead-end view instead of a recovery panel that was never
 *  offered — the user can only return to the login form (emits `cancel`). */
const noUsableMethod = computed(() => usableMethods.value.length === 0);

const method = ref<Method>(initialMethod());
const totpCode = ref("");
const recoveryCode = ref("");
const localError = ref<"" | "totp" | "recovery">("");
/** Method of the last emitted submit — the attemptsLeft error only shows on that method's panel. */
const lastSubmitMethod = ref<Method | null>(null);
/** Method the latest `lockedUntil` prop belongs to (it arrives right after that method's submit). */
const lockedMethod = ref<Method | null>(props.lockedUntil !== undefined ? initialMethod() : null);
/** `now` value at the moment the Feishu wait view was entered (approval TTL countdown).
 *  Initialized synchronously when Feishu is the initial primary, so the very first paint
 *  already shows the full TTL instead of flashing the timed-out line. */
const waitStartedAt = ref<number | null>(method.value === "feishu" ? props.now : null);

const expired = computed(() => props.now >= props.challenge.expiresAt);
const attemptsExhausted = computed(() => props.attemptsLeft === 0);
const terminalState = computed<"" | "expired" | "exhausted">(() =>
  expired.value ? "expired" : attemptsExhausted.value ? "exhausted" : "",
);

const lockedRemainingS = computed(() => {
  if (props.lockedUntil === undefined) return 0;
  return Math.max(0, Math.ceil((props.lockedUntil - props.now) / 1000));
});
const lockedActive = computed(
  () => lockedMethod.value === method.value && lockedRemainingS.value > 0 && terminalState.value === "",
);

/** Seconds left of the Feishu approval TTL (§5.7: 120s from entering the wait view). */
const approvalRemainingS = computed(() => {
  if (method.value !== "feishu" || waitStartedAt.value === null) return null;
  const left = LAN_2FA_LIMITS.approvalMs - (props.now - waitStartedAt.value);
  return Math.max(0, Math.ceil(left / 1000));
});

const heading = computed(() =>
  method.value === "feishu"
    ? t("login.2fa.headingFeishu")
    : method.value === "recovery"
      ? t("login.2fa.headingRecovery")
      : t("login.2fa.headingTotp"),
);
const headIcon = computed(() => (method.value === "feishu" ? "message" : method.value === "recovery" ? "key" : "lock"));

const errorText = computed(() => {
  if (localError.value === "totp") return t("login.2fa.invalidTotp");
  if (localError.value === "recovery") return t("login.2fa.invalidRecovery");
  if (
    props.attemptsLeft !== undefined &&
    props.attemptsLeft > 0 &&
    lastSubmitMethod.value === method.value &&
    method.value !== "feishu"
  ) {
    return method.value === "recovery"
      ? t("login.2fa.errorRecovery", { n: props.attemptsLeft })
      : t("login.2fa.errorTotp", { n: props.attemptsLeft });
  }
  return "";
});

watch(
  () => props.lockedUntil,
  (v, prev) => {
    if (typeof v === "number" && Number.isFinite(v) && v !== prev) lockedMethod.value = method.value;
    if (v === undefined) lockedMethod.value = null;
  },
);

// Editing the code clears any stale local/server error for that panel. The programmatic clear
// right after a `submit` emit sets the field to "" — only a non-empty change counts as typing,
// otherwise the just-recorded `lastSubmitMethod` would be wiped before the parent can pass
// `attemptsLeft` back in.
watch(totpCode, (v) => {
  if (localError.value === "totp") localError.value = "";
  if (v !== "" && lastSubmitMethod.value === "totp") lastSubmitMethod.value = null;
});
watch(recoveryCode, (v) => {
  if (localError.value === "recovery") localError.value = "";
  if (v !== "" && lastSubmitMethod.value === "recovery") lastSubmitMethod.value = null;
});

function enterFeishu(): void {
  waitStartedAt.value = props.now;
  emit("wait");
}

function selectMethod(m: Method): void {
  if (props.busy || m === method.value || !usableMethods.value.includes(m)) return;
  method.value = m;
  localError.value = "";
  if (m === "feishu") enterFeishu();
}

onMounted(() => {
  if (method.value === "feishu") enterFeishu();
});

// A fresh challenge (parent restarted the login without remounting) resets every local state.
watch(
  () => props.challenge,
  () => {
    method.value = initialMethod();
    totpCode.value = "";
    recoveryCode.value = "";
    localError.value = "";
    lastSubmitMethod.value = null;
    lockedMethod.value = null;
    waitStartedAt.value = null;
    if (method.value === "feishu") enterFeishu();
  },
);

function submitCurrent(): void {
  if (props.busy || terminalState.value !== "" || lockedActive.value) return;
  if (method.value === "totp") {
    const code = totpCode.value.trim();
    if (!TOTP_CODE_RE.test(code)) {
      localError.value = "totp";
      return;
    }
    localError.value = "";
    lastSubmitMethod.value = "totp";
    totpCode.value = ""; // single-use on the wire; never held after emit (LoginView precedent)
    emit("submit", { method: "totp", code });
    return;
  }
  if (method.value === "recovery") {
    const code = normalizeRecoveryCode(recoveryCode.value);
    if (code === undefined) {
      localError.value = "recovery";
      return;
    }
    localError.value = "";
    lastSubmitMethod.value = "recovery";
    recoveryCode.value = "";
    emit("submit", { method: "recovery", code });
  }
}

function onCancel(): void {
  emit("cancel");
}
</script>

<template>
  <div class="login-card tfa-card">
    <!-- Terminal states: expired (incl. the parent's E_2FA_EXPIRED restart path) or attempts exhausted. -->
    <template v-if="terminalState !== ''">
      <div class="tfa-head">
        <span class="tfa-head-icon tfa-head-icon--danger" aria-hidden="true"><AppIcon name="alert" /></span>
        <h2>{{ t("login.2fa.heading") }}</h2>
      </div>
      <div class="notice notice--danger notice--boxed" role="alert">
        <span class="notice-body">{{
          terminalState === "expired"
            ? t("login.2fa.expired", { min: challengeMinutes })
            : t("login.2fa.attemptsExhausted")
        }}</span>
      </div>
      <button class="btn btn-primary btn-lg" type="button" @click="onCancel">
        {{ t("login.2fa.backToLogin") }}
      </button>
    </template>

    <!-- Dead end: the challenge offers no method the user can actually complete. -->
    <template v-else-if="noUsableMethod">
      <div class="tfa-head">
        <span class="tfa-head-icon tfa-head-icon--danger" aria-hidden="true"><AppIcon name="alert" /></span>
        <h2>{{ t("login.2fa.heading") }}</h2>
      </div>
      <div class="notice notice--danger notice--boxed" role="alert">
        <span class="notice-body">{{ t("login.2fa.noMethod") }}</span>
      </div>
      <button class="btn btn-primary btn-lg" type="button" @click="onCancel">
        {{ t("login.2fa.backToLogin") }}
      </button>
    </template>

    <template v-else>
      <div class="tfa-head">
        <span class="tfa-head-icon" aria-hidden="true"><AppIcon :name="headIcon" /></span>
        <h2>{{ heading }}</h2>
        <p>{{ t("login.2fa.lead", { min: challengeMinutes }) }}</p>
      </div>

      <!-- Feishu approval wait (§5.7): spinner + remaining seconds of the 120s approval TTL. -->
      <div v-if="method === 'feishu'" class="tfa-panel tfa-wait" role="status">
        <AppIcon name="loader" class="tfa-wait-icon spin" />
        <p>{{ t("login.2fa.waitLead") }}</p>
        <span class="tfa-countdown">{{
          approvalRemainingS !== null && approvalRemainingS > 0
            ? t("login.2fa.waitCountdown", { s: approvalRemainingS })
            : t("login.2fa.waitExpired")
        }}</span>
      </div>

      <!-- Code entry (TOTP / recovery share one panel; both submit LanFactorBody). -->
      <form v-else class="form tfa-panel" novalidate @submit.prevent="submitCurrent">
        <div class="field">
          <label for="tfa-code">{{
            method === "totp" ? t("login.2fa.totpLabel") : t("login.2fa.recoveryLabel")
          }}</label>
          <input
            v-if="method === 'totp'"
            id="tfa-code"
            v-model="totpCode"
            class="input tfa-code-input"
            name="one-time-code"
            inputmode="numeric"
            autocomplete="one-time-code"
            autocapitalize="none"
            spellcheck="false"
            placeholder="000000"
            maxlength="6"
            :disabled="busy || lockedActive"
          />
          <input
            v-else
            id="tfa-code"
            v-model="recoveryCode"
            class="input tfa-code-input tfa-code-input--recovery"
            name="recovery-code"
            inputmode="text"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck="false"
            placeholder="XXXX-XXXX-XXXX"
            maxlength="14"
            :disabled="busy || lockedActive"
          />
        </div>
        <p class="tfa-hint">{{ method === "totp" ? t("login.2fa.totpHint") : t("login.2fa.recoveryHint") }}</p>
        <p class="form-error" role="alert">{{ errorText }}</p>
        <div v-if="lockedActive" class="notice notice--warn notice--boxed" role="alert">
          <span class="notice-body">{{ t("login.2fa.methodLocked", { s: lockedRemainingS }) }}</span>
        </div>
        <button class="btn btn-primary btn-lg" type="submit" :disabled="busy || lockedActive">
          <AppIcon v-if="busy" name="loader" class="icon-sm spin" />{{
            busy ? t("login.2fa.verifying") : t("login.2fa.submit")
          }}
        </button>
      </form>

      <div class="tfa-alt">
        <span class="tfa-alt-title">{{ t("login.2fa.altTitle") }}</span>
        <div class="tfa-links">
          <button
            v-if="method !== 'totp' && usableMethods.includes('totp')"
            class="tfa-link-btn"
            type="button"
            :disabled="busy"
            @click="selectMethod('totp')"
          >
            <AppIcon name="lock" class="icon-sm" /> {{ t("login.2fa.useTotp") }}
          </button>
          <button
            v-if="method !== 'feishu' && usableMethods.includes('feishu')"
            class="tfa-link-btn"
            type="button"
            :disabled="busy"
            @click="selectMethod('feishu')"
          >
            <AppIcon name="message" class="icon-sm" /> {{ t("login.2fa.useFeishu") }}
          </button>
          <button
            v-if="method !== 'recovery' && usableMethods.includes('recovery')"
            class="tfa-link-btn"
            type="button"
            :disabled="busy"
            @click="selectMethod('recovery')"
          >
            <AppIcon name="key" class="icon-sm" /> {{ t("login.2fa.useRecovery") }}
          </button>
          <button class="tfa-link-btn" type="button" @click="onCancel">{{ t("login.2fa.cancel") }}</button>
        </div>
      </div>
    </template>
  </div>
</template>
