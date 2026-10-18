# raw-*.png -> $README_SHOTS_DIR/final/<repo image names>, 256-colour quantized (PIL), size-checked (<=150 KB).
import os
from PIL import Image
OUT = os.environ.get("README_SHOTS_DIR", os.path.expanduser("~/readme-shots"))
os.makedirs(f"{OUT}/final", exist_ok=True)
M = {"raw-web-desktop-zh-light.png": "hero-web-desktop.png", "raw-web-desktop-en-light.png": "hero-web-desktop-en.png",
     "raw-web-desktop-zh-dark.png": "web-desktop-dark.png", "raw-web-mobile-list.png": "web-mobile-list.png",
     "raw-web-mobile-chat.png": "web-mobile-chat.png", "raw-web-mobile-agents.png": "web-mobile-agents.png",
     "raw-tui.png": "tui-agent-tree.png"}
CROP_H = {"web-mobile-agents.png": 1420}  # drop the empty lower part of the drawer (2x px)
for s, d in M.items():
    im = Image.open(f"{OUT}/{s}").convert("RGB")
    if d in CROP_H: im = im.crop((0, 0, im.width, min(im.height, CROP_H[d])))
    q = im.quantize(256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    p = f"{OUT}/final/{d}"; q.save(p, optimize=True)
    kb = os.path.getsize(p) // 1024
    print(f"{d:28s} {im.size[0]}x{im.size[1]} {kb} KB", "" if kb <= 150 else "  <-- OVER 150 KB")
