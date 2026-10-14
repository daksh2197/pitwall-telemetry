"""Assemble the demo GIF from the frames media.mjs wrote. One shared palette, exact timings."""

import glob
import sys

from PIL import Image

src = sys.argv[1] if len(sys.argv) > 1 else "/tmp/pitwall-frames"
out = sys.argv[2] if len(sys.argv) > 2 else "docs/screenshots/demo.gif"
files = sorted(glob.glob(f"{src}/f*.png"))
width = 720
frames = []
for f in files:
    im = Image.open(f).convert("RGB")
    h = round(im.height * width / im.width)
    frames.append(im.resize((width, h), Image.LANCZOS))
palette = frames[len(frames) // 2].quantize(colors=96, method=Image.Quantize.MEDIANCUT)
quant = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in frames]
durations = [110] * len(quant)
durations[0] = 900
durations[-1] = 1400
quant[0].save(
    out,
    save_all=True,
    append_images=quant[1:],
    duration=durations,
    loop=0,
    optimize=True,
    disposal=1,
)
print(f"{len(quant)} frames -> {out}")
