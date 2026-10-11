# Avatar PNG corpus

`chrome-canvas.png` was generated on 2026-10-11 with `/snap/bin/chromium --headless`
from an HTML canvas and `canvas.toDataURL("image/png")`; the snap profile used was
`/home/bluecake/snap/chromium/common/avatar-a0` as required by the snap confinement.

Firefox was not installed in the verification environment, so no Firefox canvas sample
is included. Safari cannot be generated here; iOS Safari and desktop Safari are real-device
acceptance items for the avatar implementation (plan §9 R5).

The negative corpus is generated deterministically in `tests/web-hub/hub/avatar/avatar-png.test.ts`
so each mutation remains tied to the structural reason it covers. The valid-deflate-plus-trailing,
two-zlib-stream, and split-IDAT trailing-byte cases are marked there as hub-side zlib checks
for package H; A0's pure validator intentionally does not inflate IDAT.
