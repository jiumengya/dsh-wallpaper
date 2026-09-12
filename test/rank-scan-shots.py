# -*- coding: utf-8 -*-
"""对 scan-out 的逐壁纸截图排序: 找「亮背景 + 成块暗斑」的黑方块异常。
metric: brightFrac(亮像素占比) 高 且 darkBlobFrac(暗像素占比) 显著 -> 疑似黑方块。
同时输出每张图的暗像素连通块统计(大方块计数)。
"""
import os, glob
from PIL import Image

OUT = r"D:\项目\dsh-native\plugins\dsh-wallpaper\test\scan-out"
rows = []
for p in sorted(glob.glob(os.path.join(OUT, "*.png"))):
    name = os.path.basename(p)[:-4]
    im = Image.open(p).convert("RGB").resize((320, 200))
    px = list(im.getdata())
    n = len(px)
    bright = dark = 0
    # grid dark-blob: 8x8 cell 全暗记一个块
    gw, gh = 40, 25
    cells = [[0] * gw for _ in range(gh)]
    for i, (r, g, b) in enumerate(px):
        mx = max(r, g, b)
        if r > 200 and g > 200 and b > 200:
            bright += 1
        if mx < 45:
            dark += 1
            cells[(i // 320) * gh // 200][(i % 320) * gw // 320] += 1
    blob = sum(1 for row in cells for c in row if c >= 50)  # 8x8 cell 里 >=50 个暗像素 = 实心暗块
    rows.append((name, bright / n, dark / n, blob))

rows.sort(key=lambda r: -(min(r[1], 0.9) * r[2] * 100 + r[3]))
print(f"{'id':12s} {'bright%':>8s} {'dark%':>6s} {'darkCells':>9s}  score")
for name, b, d, blob in rows[:20]:
    print(f"{name:12s} {b*100:7.1f}% {d*100:5.1f}% {blob:9d}  {min(b,0.9)*d*100+blob:.1f}")
