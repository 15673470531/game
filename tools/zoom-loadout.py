#!/usr/bin/env python3
"""首页「开局武器」面板的熟练度读数 —— 把 docs/loadout-mastery.png 里的面板区放大，
   逐字核对（用户口径"改渲染必须出图+放大逐元素核"）。

用法：python3 tools/zoom-loadout.py
产出：/tmp/loadout-mastery-zoom.png
"""
from PIL import Image, ImageDraw

SRC = '/Users/guoqing/WeChatProjects/minigame-1/docs/loadout-mastery.png'
OUT = '/tmp/loadout-mastery-zoom.png'

CELL_Y0 = 26 + 6            # 第一格画面顶（脚本里 CAP + 6）
CELL_H = 375 + 26 + 10      # 每格占高（画面 + 标题 + 间隔）
PANEL = (236, 25, 576, 349)  # 812x375 里面板的矩形（240 宽居中：x=(812-340)/2）
PAD = 6
Z = 2                        # 放大倍数（15px 名字 → 30px，读数 11px → 22px，足够逐字读）

labels = ['① 长剑 0（Lv1 · 0/300）',
          '② 长剑 150（Lv1 · 150/300）',
          '③ 长剑 450（Lv2 · 450/600）',
          '④ 长剑 900（Lv4 · 满级）']

im = Image.open(SRC)
tiles = []
for i, lab in enumerate(labels):
    y0 = CELL_Y0 + i * CELL_H
    box = (PANEL[0] - PAD, y0 + PANEL[1] - PAD, PANEL[2] + PAD, y0 + PANEL[3] + PAD)
    c = im.crop(box)
    tiles.append((lab, c.resize((c.width * Z, c.height * Z), Image.LANCZOS)))

W = max(t[1].width for t in tiles) + 24
H = sum(t[1].height + 32 for t in tiles) + 12
out = Image.new('RGB', (W, H), (13, 15, 18))
d = ImageDraw.Draw(out)
y = 10
for lab, c in tiles:
    d.text((12, y), lab, fill=(207, 233, 168))
    y += 24
    out.paste(c, (12, y))
    d.rectangle([11, y - 1, 11 + c.width + 1, y + c.height + 1], outline=(70, 78, 88))
    y += c.height + 8
out.save(OUT)
print(OUT, out.size)
