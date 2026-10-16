<!--
  web-hub-version plan §5.2 (V2): the version/compat panel — a LAZY chunk mounted only through
  `VersionHost.vue`'s `defineAsyncComponent` (top-bar popover on ≥1025px, or `embedded` inside
  the settings popup's 「版本」 card on every viewport per the 2026-10-16 D4 refinement).

  Sections (§5.2, in order):
    1. 建议 — one row per §4 finding (refresh is a BUTTON for `tab-stale`; every other advice is
       a copyable command via `detail/CopyButton.vue`). The `dirty` info row and the
       other-sessions summary line live here too (§4: no extra dots for other sessions — the
       cards' own `outdated` icon already marks them).
    2. 界面 — the tab's own bundle (UI_BUILD + the /assets/* fingerprint read from the page's
       startup DOM) vs the bundle the hub is CURRENTLY serving (`hub.ui`), with the §4 status
       term (一致/不一致/无法验证 — gray, never shown as 一致 without proof).
    3. hub — version/buildId/bootHead/pid + start time and uptime (computed ONCE at open — no
       ticking timer by design).
    4. 当前会话 — the selected agent's pluginVersion/buildId/outdated vs the hub (§4 terms incl.
       旧于/无法验证).
    5. 仓库 — snapshot `repo`: HEAD, package version, last tag, and a collapsed `<details>` with
       ≤20 commits rendered as PLAIN TEXT interpolation (never markdown, never v-html).
    6. 更新日志 — a collapsed `<details>` rendering each changelog section through
       `transcript/MarkdownView.vue` (the repo's v-html-free parser; the ONLY markdown surface
       in this feature per the task's frozen rule).

  Without the `version.v1` cap (old hub / transport without the method) sections 5–6 are
  REPLACED by the one-line 「hub 版本过旧，升级后可见」 (§6: no request is ever sent, and the
  repo/changelog hints never appear). While the snapshot loads/errored, those sections show a
  loading/error line instead of partial data — never fabricated values.

  Fetch-on-open (§4): `onMounted` → `VERSION_CTX.refresh()` — for the settings card this means
  the request fires exactly when the card (i.e. the settings dialog) mounts, sharing the
  composable's single flight with an open popover.

  Live hub-frame / selection reads come from `HUB_CTX` (the established pattern — every other
  shell component reads the hub state that way); `VERSION_CTX` carries only the version
  feature's own state (phase/snapshot/matcher result).
-->
<script setup lang="ts">
import { computed, inject, onMounted } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import MarkdownView from "../transcript/MarkdownView.vue";
import CopyButton from "../detail/CopyButton.vue";
import { HUB_CTX } from "../control/controlContext.js";
import { VERSION_CTX } from "../../composables/useVersionInfo.js";
import { UI_BUILD } from "../../build-info.js";
import { tabAssets, uiBuildStamp } from "@logic/build-stamp.js";
import { formatDuration } from "@logic/duration.js";
import { type VersionChangelogSection, type VersionRepoCommit } from "@protocol/version-info.js";

withDefaults(defineProps<{ stale?: boolean; embedded?: boolean }>(), { stale: false, embedded: false });
const { t } = useI18n();

const handle = inject(VERSION_CTX, null);
const hub = inject(HUB_CTX, null);

const match = computed(() => handle?.match.value);
const phase = computed(() => handle?.phase.value ?? "unsupported");
const snapshot = computed(() => handle?.snapshot.value);

/** §4/§5.2: fetch once when the panel (popover OR settings card) mounts. */
onMounted(() => handle?.refresh());

// ---------------------------------------------------------------------------
// 1. 建议 — findings → rows; per-code copyable advice commands (§4's rightmost column).
// ---------------------------------------------------------------------------
const FINDING_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  "tab-stale": [], // refresh BUTTON, not a command (§4: hub already serves the new bundle)
  "ui-unservable": ["/webhub restart"],
  "hub-disk-changed": ["/webhub restart"],
  "hub-older": ["/webhub restart"],
  "ui-drift": ["npm run build:web"],
  "agent-older": ["/reload"],
  "agent-newer": ["/webhub restart"],
  "agent-drift": ["/reload", "/webhub restart"],
};
const FINDING_TEXT_KEYS: Readonly<Record<string, string>> = {
  "tab-stale": "version.findingTabStale",
  "ui-unservable": "version.findingUiUnservable",
  "hub-disk-changed": "version.findingHubDiskChanged",
  "hub-older": "version.findingHubOlder",
  "ui-drift": "version.findingUiDrift",
  "agent-older": "version.findingAgentOlder",
  "agent-newer": "version.findingAgentNewer",
  "agent-drift": "version.findingAgentDrift",
};
const findings = computed(() => match.value?.findings ?? []);
const dirty = computed(() => match.value?.dirty === true);
const commandsOf = (code: string): readonly string[] => FINDING_COMMANDS[code] ?? [];
const textKeyOf = (code: string): string => FINDING_TEXT_KEYS[code] ?? "version.findingUnknown";
const summary = computed(() => match.value?.summary ?? { older: 0, newer: 0, drift: 0 });
const hasSummary = computed(() => summary.value.older + summary.value.newer + summary.value.drift > 0);

function onRefreshPage(): void {
  window.location.reload();
}

// ---------------------------------------------------------------------------
// 2. 界面 — tab identity (UI_BUILD + the startup DOM fingerprint, re-read here: the page's
//    DOM cannot change its loaded assets while alive, so this equals the composable's
//    startup read) vs the served bundle (`hub.ui`).
// ---------------------------------------------------------------------------
const tabStamp = computed(() => uiBuildStamp(UI_BUILD));
const tabDirty = UI_BUILD.commit.endsWith("-dirty");
const tabAssetList: readonly string[] = tabAssets(document) ?? [];
const hubUi = computed(() => match.value?.hubUi ?? null);
const uiStatus = computed(() => match.value?.uiStatus ?? "unknown");
const uiStatusKey = computed(() =>
  uiStatus.value === "same"
    ? "version.statusSame"
    : uiStatus.value === "differ"
      ? "version.statusDiffer"
      : "version.statusUnknown",
);

// ---------------------------------------------------------------------------
// 3. hub — uptime is computed ONCE at panel open (§5.2「打开时计算一次」— no ticking timer).
// ---------------------------------------------------------------------------
const openedAtMs = Date.now();
const hubFrame = computed<Record<string, unknown> | null>(() => hub?.state.value.hub ?? null);
const hubVersion = computed(() => strOf(hubFrame.value?.["version"]));
const hubBuildId = computed(() => strOf(hubFrame.value?.["buildId"]));
const hubPid = computed(() => {
  const v = hubFrame.value?.["pid"];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
});
const hubStartedAt = computed(() => {
  const v = hubFrame.value?.["startedAt"];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
});
const hubStartedText = computed(() =>
  hubStartedAt.value === null ? null : new Date(hubStartedAt.value).toLocaleString(),
);
const hubUptime = computed(() => {
  if (hubStartedAt.value === null) return null;
  const d = formatDuration(Math.max(0, openedAtMs - hubStartedAt.value));
  return d === null ? null : `up ${d}`;
});
const bootHead = computed(() => match.value?.bootHead ?? null);
const bootHeadText = computed(() => (bootHead.value === null ? null : bootHeadTextOf(bootHead.value)));

function bootHeadTextOf(b: { commit: string; dirty?: true }): string {
  return b.dirty === true ? `${b.commit} dirty` : b.commit;
}

// ---------------------------------------------------------------------------
// 4. 当前会话 — selected card vs hub, §4 status terms.
// ---------------------------------------------------------------------------
const sessionCard = computed<Record<string, unknown> | undefined>(() => {
  const s = hub?.state.value;
  const k = s?.selected ?? null;
  if (k === null) return undefined;
  return s?.agents.get(k)?.card;
});
const sessionStatus = computed(() => match.value?.sessionStatus ?? "unknown");
const sessionStatusKey = computed(() => `version.sessionStatus.${sessionStatus.value}`);
const sessionPlugin = computed(() => strOf(sessionCard.value?.["pluginVersion"]));
const sessionBuildId = computed(() => strOf(sessionCard.value?.["buildId"]));

// ---------------------------------------------------------------------------
// 5/6. 仓库 + 更新日志 — snapshot-gated; without the cap the whole block is the one-line
// upgrade hint (§6「不请求端点」，无 repo/changelog 提示).
// ---------------------------------------------------------------------------
const supported = computed(() => phase.value !== "unsupported");
const repo = computed(() => {
  const r = snapshot.value?.repo;
  return r !== undefined && !("error" in r) ? r : undefined;
});
const repoError = computed(() => {
  const r = snapshot.value?.repo;
  return r !== undefined && "error" in r ? (r.error as string) : undefined;
});
const repoErrorKey = computed(() => `version.sectionError.${repoError.value ?? "unavailable"}`);
const repoHead = computed(() => repo.value?.head);
const repoHeadText = computed(() => (repoHead.value === undefined ? null : bootHeadTextOf(repoHead.value)));
const repoHeadTime = computed(() =>
  typeof repoHead.value?.time === "number" ? new Date(repoHead.value.time * 1000).toLocaleString() : null,
);
const repoCommitsTotal = computed(() => repo.value?.commitsTotal ?? repo.value?.commits?.length ?? 0);
const commitRows = computed(() => {
  const src: readonly VersionRepoCommit[] = repo.value?.commits ?? [];
  return src.map((c) => ({
    commit: c.commit,
    date: new Date(c.time * 1000).toLocaleDateString(),
    subject: c.subject,
  }));
});
const changelog = computed(() => {
  const c = snapshot.value?.changelog;
  return c !== undefined && !("error" in c) ? c : undefined;
});
const changelogError = computed(() => {
  const c = snapshot.value?.changelog;
  return c !== undefined && "error" in c ? (c.error as string) : undefined;
});
const changelogSections = computed<readonly VersionChangelogSection[]>(() => changelog.value?.sections ?? []);
const changelogSummaryTitle = computed(() => changelogSections.value[0]?.title ?? t("version.sectionChangelog"));
const commitsOmitted = computed(() => Math.max(0, repoCommitsTotal.value - commitRows.value.length));

function onRetrySnapshot(): void {
  handle?.refresh();
}

function strOf(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}
</script>

<template>
  <div class="version-panel">
    <!-- 1. 建议 -->
    <section class="version-section" :aria-label="t('version.sectionAdvice')">
      <h3 class="version-h">{{ t("version.sectionAdvice") }}</h3>
      <p v-if="findings.length === 0 && !dirty" class="version-ok">{{ t("version.allConsistent") }}</p>
      <ul v-else class="version-findings">
        <li v-for="f in findings" :key="f.code" class="version-finding" :data-level="f.level">
          <span class="version-finding-text">{{ t(textKeyOf(f.code)) }}</span>
          <span class="version-finding-actions">
            <button v-if="f.code === 'tab-stale'" type="button" class="btn btn-ghost" @click="onRefreshPage">
              {{ t("version.refreshPage") }}
            </button>
            <CopyButton v-for="cmd in commandsOf(f.code)" :key="cmd" :value="cmd" :label="t('version.copyCommand')" />
          </span>
        </li>
        <li v-if="dirty" class="version-finding" data-level="none">
          <span class="version-finding-text">{{ t("version.findingDirty") }}</span>
        </li>
      </ul>
      <p v-if="hasSummary" class="version-summary">{{ t("version.summaryOther", summary) }}</p>
    </section>

    <!-- 2. 界面 -->
    <section class="version-section" :aria-label="t('version.sectionUi')">
      <h3 class="version-h">
        {{ t("version.sectionUi") }}
        <span class="version-status" :data-status="uiStatus">{{ t(uiStatusKey) }}</span>
      </h3>
      <dl class="version-kv">
        <dt>{{ t("version.uiTab") }}</dt>
        <dd>
          <span class="version-mono" translate="no">{{ tabStamp ?? UI_BUILD.version }}</span>
          <span v-if="tabDirty" class="version-flag" translate="no">dirty</span>
        </dd>
        <dt>{{ t("version.uiTabAssets") }}</dt>
        <dd>
          <span v-if="tabAssetList.length === 0" class="version-muted">{{ t("version.unknown") }}</span>
          <ul v-else class="version-assets">
            <li v-for="a in tabAssetList" :key="a" class="version-mono" translate="no">{{ a }}</li>
          </ul>
        </dd>
        <dt>{{ t("version.uiServed") }}</dt>
        <dd>
          <template v-if="hubUi !== null">
            <span class="version-mono" translate="no">{{ hubUi.version }}@{{ hubUi.commit }}</span>
            <span class="version-muted" translate="no"> · {{ hubUi.builtAt }} · {{ hubUi.source }}</span>
            <ul class="version-assets">
              <li v-for="a in hubUi.assets" :key="a" class="version-mono" translate="no">{{ a }}</li>
            </ul>
          </template>
          <span v-else class="version-muted">{{ t("version.uiServedNone") }}</span>
        </dd>
      </dl>
    </section>

    <!-- 3. hub -->
    <section class="version-section" :aria-label="t('version.sectionHub')">
      <h3 class="version-h">{{ t("version.sectionHub") }}</h3>
      <dl class="version-kv">
        <template v-if="hubVersion !== undefined">
          <dt>{{ t("version.hubVersionLabel") }}</dt>
          <dd class="version-mono" translate="no">{{ hubVersion }}</dd>
          <dt>{{ t("version.hubBuildLabel") }}</dt>
          <dd class="version-mono" translate="no">{{ hubBuildId ?? t("version.unknown") }}</dd>
          <dt>{{ t("version.hubBootHeadLabel") }}</dt>
          <dd class="version-mono" translate="no">{{ bootHeadText ?? t("version.unknown") }}</dd>
          <dt>{{ t("version.hubStartedLabel") }}</dt>
          <dd>
            <span v-if="hubStartedText !== null">{{ hubStartedText }}</span>
            <span v-if="hubUptime !== null" class="version-muted" translate="no"> · {{ hubUptime }}</span>
          </dd>
          <dt>{{ t("version.hubPidLabel") }}</dt>
          <dd class="version-mono" translate="no">{{ hubPid ?? t("version.unknown") }}</dd>
        </template>
        <template v-else>
          <dt>
            <span class="sr-only">{{ t("version.sectionHub") }}</span>
          </dt>
          <dd class="version-muted">{{ t("version.hubNone") }}</dd>
        </template>
      </dl>
    </section>

    <!-- 4. 当前会话 -->
    <section class="version-section" :aria-label="t('version.sectionSession')">
      <h3 class="version-h">
        {{ t("version.sectionSession") }}
        <span class="version-status" :data-status="sessionStatus">{{ t(sessionStatusKey) }}</span>
      </h3>
      <dl class="version-kv">
        <template v-if="sessionCard !== undefined">
          <dt>{{ t("version.sessionPluginLabel") }}</dt>
          <dd class="version-mono" translate="no">{{ sessionPlugin ?? t("version.unknown") }}</dd>
          <dt>{{ t("version.sessionBuildLabel") }}</dt>
          <dd class="version-mono" translate="no">{{ sessionBuildId ?? t("version.unknown") }}</dd>
          <dt>{{ t("version.sessionOutdatedLabel") }}</dt>
          <dd>{{ sessionCard["outdated"] === true ? t("version.yes") : t("version.no") }}</dd>
        </template>
        <template v-else>
          <dt>
            <span class="sr-only">{{ t("version.sectionSession") }}</span>
          </dt>
          <dd class="version-muted">{{ t("version.sessionNone") }}</dd>
        </template>
      </dl>
    </section>

    <!-- 5/6. 仓库 + 更新日志 — cap-gated (§6: no request, one-line hint, no repo/changelog UI) -->
    <section v-if="!supported" class="version-section" :aria-label="t('version.sectionRepo')">
      <h3 class="version-h">{{ t("version.sectionRepo") }}</h3>
      <p class="version-muted">{{ t("version.unsupportedHint") }}</p>
    </section>
    <template v-else>
      <section class="version-section" :aria-label="t('version.sectionRepo')">
        <h3 class="version-h">{{ t("version.sectionRepo") }}</h3>
        <p v-if="phase === 'loading'" class="version-muted" role="status">{{ t("version.loading") }}</p>
        <div v-else-if="phase === 'error'" class="version-error">
          <p class="version-muted">{{ t("version.error") }}</p>
          <button type="button" class="btn btn-ghost" @click="onRetrySnapshot">{{ t("version.retry") }}</button>
        </div>
        <p v-else-if="repoError !== undefined" class="version-muted">{{ t(repoErrorKey) }}</p>
        <dl v-else-if="repo !== undefined" class="version-kv">
          <dt>{{ t("version.repoHeadLabel") }}</dt>
          <dd>
            <span class="version-mono" translate="no">{{ repoHeadText ?? t("version.unknown") }}</span>
            <span v-if="repoHeadTime !== null" class="version-muted"> · {{ repoHeadTime }}</span>
          </dd>
          <dt>{{ t("version.repoPkgLabel") }}</dt>
          <dd class="version-mono" translate="no">{{ repo?.packageVersion ?? t("version.unknown") }}</dd>
          <dt>{{ t("version.repoTagLabel") }}</dt>
          <dd class="version-mono" translate="no">{{ repo?.lastTag ?? t("version.none") }}</dd>
        </dl>
        <p v-else class="version-muted">{{ t("version.repoMissing") }}</p>
        <details v-if="commitRows.length > 0" class="version-details">
          <summary>{{ t("version.repoCommitsTitle", { n: commitRows.length }) }}</summary>
          <ul class="version-commits">
            <!-- plain text interpolation only (§5.2): short hash · date · one-line subject -->
            <li v-for="c in commitRows" :key="c.commit">
              <span class="version-mono" translate="no">{{ c.commit }}</span>
              <span class="version-muted"> · {{ c.date }} · </span>
              <span>{{ c.subject }}</span>
            </li>
          </ul>
          <p v-if="commitsOmitted > 0" class="version-muted">
            {{ t("version.repoCommitsMore", { n: commitsOmitted }) }}
          </p>
        </details>
      </section>

      <section class="version-section" :aria-label="t('version.sectionChangelog')">
        <h3 class="version-h">{{ t("version.sectionChangelog") }}</h3>
        <p v-if="phase === 'loading'" class="version-muted" role="status">{{ t("version.loading") }}</p>
        <div v-else-if="phase === 'error'" class="version-error">
          <p class="version-muted">{{ t("version.error") }}</p>
          <button type="button" class="btn btn-ghost" @click="onRetrySnapshot">{{ t("version.retry") }}</button>
        </div>
        <p v-else-if="changelogError !== undefined" class="version-muted">
          {{ t(`version.sectionError.${changelogError}`) }}
        </p>
        <details v-else-if="changelogSections.length > 0" class="version-details">
          <summary class="version-mono" translate="no">{{ changelogSummaryTitle }}</summary>
          <!-- MarkdownView is the repo's v-html-free renderer — the ONLY markdown surface here -->
          <div class="version-changelog">
            <section v-for="s in changelogSections" :key="s.title" class="version-changelog-section">
              <h4 class="version-changelog-title">
                <span class="version-mono" translate="no">{{ s.title }}</span>
                <span v-if="s.date" class="version-muted" translate="no"> · {{ s.date }}</span>
              </h4>
              <MarkdownView :text="s.markdown" />
              <p v-if="s.truncated === true" class="version-muted">{{ t("version.changelogTruncated") }}</p>
            </section>
          </div>
        </details>
        <p v-else class="version-muted">{{ t("version.changelogMissing") }}</p>
      </section>
    </template>
  </div>
</template>
