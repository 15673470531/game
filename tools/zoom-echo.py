#!/usr/bin/env python3
"""剑阵回响 V2 的细节核对图：把 docs/sword-echo.png 里的三处关键区域放大，
   方便逐元素核（用户口径"改渲染必须出图+放大逐元素核"）。

用法：python3 tools/zoom-echo.py
产出：/tmp/echo-v2-zoom.png
"""
from PIL import Image, ImageDraw

SRC = '/Users/guoqing/WeChatProjects/minigame-1/docs/sword-echo.png'
OUT = '/tmp/echo-v2-zoom.png'

CROPS = [
    ('A 布阵：两把剑（左=落稳/右=刚落地）+ 地面微光 + 扬尘', (280, 215, 660, 450), 3),
    ('B 预警：三角边框 + 斜线阵纹 + 边框短刺 + 顶点碎刃', (200, 590, 720, 1010), 2),
    ('C 齐斩：三道锥形刀光 + 交汇点 + 命中火花/冲击痕（阵外的不许有）', (320, 1280, 680, 1535), 3),
]

im = Image.open(SRC)
tiles = []
for label, box, z in CROPS:
    c = im.crop(box)
    tiles.append((label, c.resize((c.width * z, c.height * z), Image.LANCZOS)))

W = max(t[1].width for t in tiles) + 24
H = sum(t[1].height + 32 for t in tiles) + 12
out = Image.new('RGB', (W, H), (13, 15, 18))
d = ImageDraw.Draw(out)
y = 10
for label, c in tiles:
    d.text((12, y), label, fill=(207, 233, 168))
    y += 24
    out.paste(c, (12, y))
    d.rectangle([11, y - 1, 11 + c.width + 1, y + c.height + 1], outline=(70, 78, 88))
    y += c.height + 8
out.save(OUT)
print(OUT, out.size)
