#!/usr/bin/env bash
# 小样出图（都走无头 Chrome + 真渲染器，不是手绘示意）
#
#   bash tools/shot-boss.sh           荒原巨蝎机制四格 → docs/boss-warden.png
#   bash tools/shot-boss.sh burst     「开天」限次爆发三格 → docs/burst-open-sky.png
#
# 用途：改完之后不开微信开发者工具，先自己看一眼版式和表现（断言抓不到"丑/挤/像 bug"）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WHAT="${1:-boss}"

case "$WHAT" in
  boss)  PAGE="preview-boss.html"; OUT="$HERE/../docs/boss-warden.png"; W=1640; H=828 ;;
  burst) PAGE="preview-burst.html"; OUT="$HERE/../docs/burst-open-sky.png"; W=820; H=2070 ;;
  cards) PAGE="preview-trial-cards.html"; OUT="$HERE/../docs/trial-cards.png"; W=820; H=1258 ;;
  title) PAGE="preview-title.html"; OUT="$HERE/../docs/title-trial-entry.png"; W=820; H=850 ;;
  player) PAGE="preview-player.html"; OUT="$HERE/../docs/player-current.png"; W=812; H=390 ;;
  walk) PAGE="preview-walk.html"; OUT="$HERE/../docs/player-walk.png"; W=812; H=208 ;;
  head)  PAGE="preview-head.html"; OUT="$HERE/../docs/player-head.png"; W=810; H=218 ;;
  hud)   PAGE="preview-hud.html"; OUT="$HERE/../docs/hud-corner-card.png"; W=812; H=1700 ;;
  onespin) PAGE="preview-onespin.html"; OUT="$HERE/../docs/one-spin-per-attack.png"; W=812; H=1060 ;;
  icons)  PAGE="preview-icons.html"; OUT="$HERE/../docs/kill-icon-options.png"; W=812; H=360 ;;
  lvrow)  PAGE="preview-lvrow.html"; OUT="$HERE/../docs/lv-row-options.png"; W=812; H=430 ;;
  growth) PAGE="preview-growth.html"; OUT="$HERE/../docs/weapon-growth.png"; W=812; H=460 ;;
  lowhp) PAGE="preview-lowhp.html"; OUT="$HERE/../docs/lowhp-signals.png"; W=812; H=1090 ;;
  skilldrop) PAGE="preview-skilldrop.html"; OUT="$HERE/../docs/skill-drop.png"; W=812; H=2960 ;;
  swordsman) PAGE="preview-swordsman.html"; OUT="$HERE/../docs/player-swordsman.png"; W=812; H=430 ;;
  side) PAGE="preview-side.html"; OUT="$HERE/../docs/player-side.png"; W=812; H=430 ;;
  settings) PAGE="preview-settings.html"; OUT="$HERE/../docs/panel-settings.png"; W=812; H=1230 ;;
  reroll) PAGE="preview-reroll.html"; OUT="$HERE/../docs/card-reroll.png"; W=1408; H=2822 ;;
  attackcd) PAGE="preview-attackcd.html"; OUT="$HERE/../docs/attack-ring.png"; W=1140; H=2900 ;;
  mastery) PAGE="preview-mastery.html"; OUT="$HERE/../docs/mastery-block.png"; W=900; H=620 ;;
  echo)   PAGE="preview-echo.html"; OUT="$HERE/../docs/sword-echo.png"; W=910; H=890 ;;
  blades) PAGE="preview-blades.html"; OUT="$HERE/../docs/blade-count.png"; W=660; H=2210 ;;
  echo2)  PAGE="preview-echo2.html"; OUT="$HERE/../docs/sword-echo-variants.png"; W=1900; H=1500 ;;
  spike)  PAGE="preview-spike.html"; OUT="$HERE/../docs/sword-echo-spike.png"; W=1900; H=1500 ;;
  settle) PAGE="preview-settle.html"; OUT="$HERE/../docs/settle-mastery-text.png"; W=1700; H=1300 ;;
  loadout) PAGE="preview-loadout.html"; OUT="$HERE/../docs/loadout-mastery.png"; W=812; H=1650 ;;
  codex)  PAGE="preview-codex.html"; OUT="$HERE/../docs/codex.png"; W=1670; H=850 ;;
  pause)  PAGE="preview-pause.html"; OUT="$HERE/../docs/pause-bag.png"; W=812; H=2440 ;;
  *) echo "用法: bash tools/shot-boss.sh [boss|burst|cards|title|player|walk|head|hud|lowhp|skilldrop|swordsman|side|settings|reroll|attackcd|mastery|echo|blades|echo2|spike|settle|loadout|codex|pause]" >&2; exit 1 ;;
esac

CHROME=""
for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
         "/Applications/Chromium.app/Contents/MacOS/Chromium" \
         "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"; do
  [ -x "$c" ] && CHROME="$c" && break
done
[ -n "$CHROME" ] || { echo "找不到 Chrome/Chromium/Edge，没法无头截图" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"

# 先跑一遍拿 title：预览页成功时会写 `READY <宽>x<高>`（失败写 ERR: ...）。
# 用它（a）确认页面真的跑起来了 —— 否则截图只会得到一张纯色图，看着像"版式就是空白"；
#    （b）**按页面自己的高度截图** —— 格数一变就自动跟上，不用回头改脚本常量。
DOM=$("$CHROME" --headless=new --disable-gpu --virtual-time-budget=6000 \
      --dump-dom "file://${HERE}/${PAGE}" 2>/dev/null || true)
TITLE=$(printf '%s' "$DOM" | grep -o '<title>[^<]*</title>' | head -1 | sed -e 's/<[^>]*>//g')
case "$TITLE" in
  READY*) ;;
  ERR*)   echo "预览页报错: $TITLE" >&2; exit 1 ;;
  *)      echo "预览页没跑起来（title=${TITLE}，期望 READY…）—— 先查预览页的 JS 报错" >&2; exit 1 ;;
esac
if printf '%s' "$TITLE" | grep -qE 'READY [0-9]+x[0-9]+'; then
  W=$(printf '%s' "$TITLE" | sed -E 's/.*READY ([0-9]+)x[0-9]+.*/\1/')
  H=$(printf '%s' "$TITLE" | sed -E 's/.*READY [0-9]+x([0-9]+).*/\1/')
fi

"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --window-size="${W},${H}" --virtual-time-budget=6000 \
  --screenshot="$OUT" "file://${HERE}/${PAGE}" 2>/dev/null | grep -i written || true

[ -s "$OUT" ] || { echo "截图没生成" >&2; exit 1; }
echo "$OUT  (${W}x${H})"
