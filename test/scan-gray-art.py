# -*- coding: utf-8 -*-
"""扫描场景缓存的主合成图: 找「大面积单一色(提取丢图层)」的条目。
metric: 最常见的量化颜色(bin=16)占比 > 60% -> 疑似空/灰底。
"""
import os, glob, collections
from PIL import Image

cache = os.path.expanduser(r"~\.dsh\plugin-wallpaper-scene")
rows = []
for p in sorted(glob.glob(os.path.join(cache, "*.png"))):
    name = os.path.basename(p)
    if ".anim-tex-" in name or name.endswith(".flat.png"):
        continue
    wid = name[:-4]
    try:
        im = Image.open(p).convert("RGB").resize((160, 90))
        counts = collections.Counter()
        for r, g, b in im.getdata():
            counts[(r // 16, g // 16, b // 16)] += 1
        top, n = counts.most_common(1)[0]
        rows.append((wid, n / (160 * 90), top))
    except Exception as e:
        print(wid, "ERR", e)

rows.sort(key=lambda r: -r[1])
print(f"{'id':12s} {'topColor%':>9s}  bin")
for wid, frac, top in rows:
    mark = "  <== 疑似丢图层" if frac > 0.6 else ""
    print(f"{wid:12s} {frac*100:8.1f}%  {top}{mark}")
