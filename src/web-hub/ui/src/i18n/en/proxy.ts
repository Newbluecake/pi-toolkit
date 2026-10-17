/**
 * `proxy` i18n namespace (web-hub-proxy plan v2 §8, package X2): the port-proxy dialog, the
 * message-link affordance and the copy of every deny reason / error outcome.
 *
 * UI-text split (AGENTS.md): compact inline markers (address-class tokens, `port N`, `mine`)
 * stay English in both languages; prose (intro, notes, every error sentence) translates.
 */
const proxy = {
  openBtn: "Open local port",
  openBtnTitle: "Open a local or LAN port through the hub (new tab)",
  dialogTitle: "Open local port",
  intro:
    "Open an HTTP service that runs on the hub machine or its private network in a new tab, through a hub-managed proxy port.",
  targetLabel: "Address",
  targetPlaceholder: "127.0.0.1:23434 or localhost:3000/app",
  targetHint: "Enter host:port or a full http URL. Only loopback and private-network addresses are allowed.",
  submit: "Open",
  submitting: "Opening…",
  close: "Close",
  listTitle: "Open proxies",
  listLoading: "Loading…",
  listEmpty: "No proxy is open.",
  listRetry: "Retry",
  listRefresh: "Refresh",
  itemOpen: "Open",
  itemStop: "Stop",
  itemStopping: "Stopping…",
  itemMine: "mine",
  itemPort: "port {port}",
  "cls.loopback": "loopback",
  "cls.private": "private",
  "cls.cgnat": "cgnat",
  "cls.ula": "ula",
  policy: "Up to {max} proxies, ports {lo}-{hi}.",
  noteLanOn:
    "LAN access is on: proxy ports are reachable from the LAN as well, and stay protected by a one-time link and a separate proxy session.",
  noteLanOff: "LAN access is off: proxy ports listen on this machine only.",
  noteTunnel:
    "Behind an SSH tunnel or port forwarding, forward the proxy ports {lo}-{hi} as well, otherwise the new tab cannot connect.",
  noteReverse: "Behind a reverse proxy the port proxy is not available; open the hub through its direct address.",
  blockedNote: "The browser blocked the new tab. Open the proxy manually:",
  blockedLink: "Open proxy tab",
  refTitle: "Open via hub proxy (new tab)",
  refBusy: "Opening…",
  "reason.syntax": "Invalid address. Enter host:port or an http URL with host and port.",
  "reason.scheme": "Only the http scheme is supported (no https or other schemes).",
  "reason.userinfo": "The address must not contain a username or password.",
  "reason.port": "Invalid port: it must be an integer from 1 to 65535.",
  "reason.public": "Only this machine and private-network addresses can be proxied; public addresses are refused.",
  "reason.link-local": "Link-local addresses (169.254.x.x, fe80::) cannot be proxied.",
  "reason.metadata": "Cloud metadata addresses cannot be proxied.",
  "reason.multicast": "Multicast addresses cannot be proxied.",
  "reason.reserved": "Reserved address ranges cannot be proxied.",
  "reason.translation": "Address-translation ranges (NAT64, 6to4) cannot be proxied.",
  "reason.unspecified": "0.0.0.0 and :: are not valid targets.",
  "reason.mixed-answer": "That hostname resolves to an address that is not allowed, so it was refused.",
  "reason.dns-failed": "The hostname could not be resolved. Check the spelling.",
  "reason.dns-timeout": "Resolving the hostname timed out. Try again later.",
  "reason.self-port": "The hub's own ports and the proxy ports cannot be proxied.",
  "reason.port-busy": "A proxy port is busy. Try again in a moment.",
  "reason.ports-exhausted":
    "All proxy ports are bound to other targets (a target keeps its port for good). Widen webHub.proxy.portRange or restart the hub.",
  "reason.ports-store":
    "The port map cannot be saved, so the request was refused for safety. Check the hub state directory.",
  "reason.reverse-proxy": "The port proxy is not available through a reverse proxy. Use the hub's direct address.",
  "reason.closing": "The hub is shutting down. Try again later.",
  "reason.revocation-gap": "Login state could not be verified right now. Try again.",
  "reason.listen-timeout": "Opening the proxy port timed out. Try again.",
  "reason.denied": "This address is not allowed.",
  "reason.unavailable": "The proxy is temporarily unavailable. Try again later.",
  "limit.proxies": "Too many proxies are open. Stop one you no longer need first.",
  "limit.ports-exhausted":
    "All proxy ports are bound to other targets. Widen webHub.proxy.portRange or restart the hub.",
  rate: "Too many requests. Wait a moment and try again.",
  auth: "Your login has expired. Sign in again.",
  cookieConflict:
    "Duplicate login cookies were detected (possibly from another port on this host). Clear this site's cookies in the browser, then sign in again.",
  notFound: "That proxy no longer exists.",
  network: "The hub did not answer in time. Check the connection and try again.",
  aborted: "Cancelled.",
  error: "The proxy request failed.",
} satisfies Record<string, string>;

export default proxy;
