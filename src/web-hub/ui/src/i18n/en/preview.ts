/**
 * `preview` i18n namespace (web-hub-preview plan v3 §3.2/§4.6 — PV5): the five preview
 * phases' copy (loading / image / text / unsupported / tooLarge / error), retry/close, the
 * plaintext-transport standing warning (§5.2), and the truncated-text badge. Paths, error
 * codes and sizes render verbatim (`translate="no"`), never through this namespace.
 */
const preview = {
  dialogLabel: "File preview",
  close: "Close",
  retry: "Retry",
  retryAfter: "You can retry in {n}s.",
  loading: "Loading preview…",
  plaintextWarning: "Plaintext connection — anything you preview can be seen by the network.",
  fit: "Fit to window",
  actualSize: "Actual size",
  copyPath: "Copy path",
  truncatedBadge: "Truncated",
  truncatedNote: "Showing the first {size} — copy only takes what is shown.",
  unsupportedTitle: "No preview available",
  unsupportedBody: "This file cannot be previewed ({reason}).",
  reasonBinary: "binary file",
  reasonNotRegular: "not a regular file",
  reasonDimsUnknown: "unrecognized image",
  reasonGeneric: "unsupported content",
  fileSize: "Size: {size}",
  tooLargeTitle: "Too large to preview",
  tooLargePixels: "The image is {w} × {h}, over the browser preview budget.",
  tooLargeBytes: "The file is {size}, over the {max} preview limit.",
  tooLargeGeneric: "This file exceeds the preview limit.",
  errorTitle: "Preview failed",
} satisfies Record<string, string>;

export default preview;
