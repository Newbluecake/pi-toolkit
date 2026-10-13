/**
 * `privacy` i18n namespace (web-hub-privacy plan v2.1, package P2): the per-session privacy
 * lock. 命名分离 (plan v2.1 N1, a pinned distinction): 「隐私标记」 is the PERSISTENT mark
 * (card lock icon / header button → `POST /api/privacy/lock`) — keys `mark*`/`unmark*`;
 * 「立即锁定」 is the VIEW relock (pure client-side, no request) — key `lockNow`. The two
 * vocabularies never mix. Error copy itself stays in `errors.*` (the lock screen and the
 * unmark dialog reuse the sign-in verdict/throttle lines verbatim, plan「解锁」).
 *
 * UI-text split (AGENTS.md): compact inline fragments (badge, unit) stay English tokens in
 * both languages; prose blocks (screen body, dialog hints) translate.
 */
const privacy = {
  /** Lock badge on a marked session's card (常显) — compact marker, English token. */
  badgeMarked: "Private",
  /** Card/header button while the session is NOT marked: create the persistent mark. */
  mark: "Mark private",
  markAria: "Mark this session as private",
  /** Header button while viewing an unlocked marked session: relock the VIEW (no request). */
  lockNow: "Lock now",
  lockNowAria: "Relock this session's view immediately",
  /** Lock screen (replaces the whole AgentDetail subtree while locked). */
  screenTitle: "This session is private",
  screenBody:
    "Its transcript and panels are hidden until you unlock the view. Unlocking is per viewing and relocks when you switch away, after idle time, or when the tab is hidden.",
  passwordLabel: "LAN password",
  unlockSubmit: "Unlock",
  /** loopback/token mode: no second credential exists — honest click-to-confirm (plan 评审 #7 (a)). */
  confirmView: "Click to view",
  loopbackHint:
    "This hub is unlocked with a link token, so there is no password to check — viewing is a click-to-confirm, not a real verification.",
  /** Transient action failure (mark/unmark) — `{code}` is the wire error code. */
  actionFailed: "Privacy action failed ({code})",
  /** 409 E_SESSION_CHANGED: the session rotated between seeing the card and the call. */
  sessionChanged: "The session changed just now — try again.",
  /** Unmark dialog (取消标记). */
  unmarkTitle: "Remove privacy mark",
  unmarkBodyLan:
    "Enter the LAN password to remove this session's privacy mark. The password is used for this request only and is never stored.",
  unmarkBodyLoopback:
    "Remove this session's privacy mark? This hub has no second credential, so removal is a plain confirmation.",
  unmarkConfirm: "Remove mark",
  unmarkCancel: "Cancel",
  /** Settings card (idle relock timeout, `pwh_privacy_timeout`). */
  timeoutSection: "Privacy lock",
  timeoutHint:
    "An unlocked private session relocks itself after this many minutes without keyboard, pointer, touch or scroll activity — only while you are viewing it. Switching sessions or hiding the tab always relocks immediately. Desktop only; the phone layout never locks.",
  timeoutLabel: "Relock after (minutes)",
  timeoutUnit: "min",
} satisfies Record<string, string>;

export default privacy;
