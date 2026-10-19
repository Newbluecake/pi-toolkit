/** LAN security r2 §3.2 (package D): 「登录会话」 settings card. zh mirror: ../zh/sessions.ts. */
const sessions = {
  title: "Login sessions",
  hint: "Devices signed in on this LAN. A session expires after {idle} minutes without activity or {days} days after sign-in.",
  currentDevice: "This device",
  unknownDevice: "Unknown device",
  colIp: "IP",
  colLogin: "Signed in",
  colActive: "Last active",
  justNow: "just now",
  minutesAgo: "{n} min ago",
  hoursAgo: "{n} h ago",
  daysAgo: "{n} d ago",
  revoke: "Sign out",
  revokeOthers: "Sign out all other devices",
  revokeOthersArmed: "Click again to confirm",
  revokedOk: "Signed out {n} device(s)",
  revokedPartial: "Signed out {n} device(s); some sessions could not be revoked — please retry",
  capNote:
    "Showing at most {max} devices. Signing out takes effect immediately; the other side must sign in again on its next request.",
  loading: "Loading…",
  errorLoad: "Could not load the session list.",
  errorRevoke: "The sign-out failed.",
  retry: "Retry",
  refresh: "Refresh",
};

export default sessions;
