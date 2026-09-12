# -*- coding: utf-8 -*-
"""扫描场景缓存: 找「非 additive 混合、可见像素近黑且大面积不透明」的粒子纹理。
这类纹理在画布上会画成黑方块(正常混合下 alpha 丢失)。
"""
import os, glob, json
from PIL import Image

cache = os.path.expanduser(r"~\.dsh\plugin-wallpaper-scene")

def tex_stats(p):
    im = Image.open(p).convert("RGBA")
    data = im.getdata()
    total = len(data)
    vis = 0; rgb_sum = 0.0; dark = 0; opaque_dark = 0
    for r, g, b, a in data:
        if a > 16:
            vis += 1
            rgb_sum += (r + g + b) / 3.0
            if max(r, g, b) < 25:
                dark += 1
                if a > 240:
                    opaque_dark += 1
    if vis == 0:
        return None
    return dict(vis=vis/total, mean=rgb_sum/vis, dark=dark/vis, odark=opaque_dark/total)

suspects = []
for aj in sorted(glob.glob(os.path.join(cache, "*.anim.json"))):
    wid = os.path.basename(aj)[:-10]
    try:
        d = json.load(open(aj, encoding="utf-8"))
    except Exception as e:
        print(wid, "anim.json ERR", e); continue
    texs = d.get("textures") or []
    for i, t in enumerate(texs):
        blending = (t.get("blending") or "normal").lower()
        p = os.path.join(cache, f"{wid}.anim-tex-{i}.png")
        if not os.path.exists(p):
            print(f"{wid} tex{i} MISSING png"); continue
        st = tex_stats(p)
        if st is None:
            print(f"{wid} tex{i} [{blending}] 空纹理")
            continue
        bad = blending not in ("additive",) and st["dark"] > 0.5 and st["odark"] > 0.3
        mark = "  <== 黑方块(正常混合+不透明黑)" if bad else ""
        if bad or st["dark"] > 0.5:
            print(f"{wid} tex{i} [{blending:8s}] vis={st['vis']*100:5.1f}% meanRGB={st['mean']:6.1f} darkVis={st['dark']*100:5.1f}% opaqueDark={st['odark']*100:5.1f}%{mark}")
        if bad:
            suspects.append((wid, i))

print()
print("REAL SUSPECTS:", suspects)
