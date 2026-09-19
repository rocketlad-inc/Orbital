#!/usr/bin/env bash
# ============================================================
# Put a REAL Orbital widget on the emulator's home screen.
#
# A fake appWidgetId gets an empty options bundle and a silently dropped
# update, so every earlier "widget receiver" scenario exercised almost
# none of the code that runs against a real launcher. This binds one for
# real, the only way that exists: the launcher's own widget picker,
# driven by uiautomator dumps and taps.
# ============================================================
set -u
PKG=com.orbitalempire.game

dump() { adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; adb shell cat /sdcard/ui.xml 2>/dev/null; }
# Centre of the first node whose text or content-desc contains $1.
centre_of() {
  dump | python3 -c '
import sys,re
xml=sys.stdin.read(); needle=sys.argv[1].lower()
for m in re.finditer(r"<node[^>]*>", xml):
    n=m.group(0)
    t=(re.search(r"text=\"([^\"]*)\"",n) or [None,""])[1]; d=(re.search(r"content-desc=\"([^\"]*)\"",n) or [None,""])[1]
    if needle in (t+" "+d).lower():
        b=re.search(r"bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"",n)
        if b:
            x1,y1,x2,y2=map(int,b.groups()); print((x1+x2)//2,(y1+y2)//2); sys.exit(0)
sys.exit(1)' "$1"
}
tap() { adb shell input tap "$1" "$2"; sleep 1.5; }

adb shell input keyevent KEYCODE_HOME; sleep 2
W=$(adb shell wm size | grep -oE "[0-9]+x[0-9]+" | tail -1); SW=${W%x*}; SH=${W#*x}
# Long-press an empty spot on the home screen.
adb shell input swipe $((SW/2)) $((SH*6/10)) $((SW/2)) $((SH*6/10)) 1200; sleep 2

if C=$(centre_of "Widgets"); then tap $C; else echo "no Widgets entry in the long-press menu"; dump | head -c 1500; exit 1; fi
sleep 2
# The picker lists apps; find ours (scroll a few times if needed).
for i in 1 2 3 4 5 6; do
  if C=$(centre_of "Orbital"); then break; fi
  adb shell input swipe $((SW/2)) $((SH*8/10)) $((SW/2)) $((SH*3/10)) 400; sleep 1.5
done
[ -n "${C:-}" ] || { echo "Orbital not found in widget picker"; dump | grep -oE 'text="[^"]{1,30}"' | sort -u | head -40; exit 1; }
tap $C; sleep 2
# Expanding the app row reveals the widget itself; long-press-drag it onto the home screen.
if C=$(centre_of "Orbital"); then :; fi
X=${C% *}; Y=${C#* }
# Some pickers need the specific widget cell, which sits below the app name.
if C2=$(dump | python3 -c '
import sys,re
xml=sys.stdin.read()
cands=[]
for m in re.finditer(r"<node[^>]*>", xml):
    n=m.group(0)
    if "com.orbitalempire.game" in n or "Orbital" in n:
        b=re.search(r"bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"",n)
        if b:
            x1,y1,x2,y2=map(int,b.groups()); cands.append(((y2-y1)*(x2-x1),(x1+x2)//2,(y1+y2)//2))
cands.sort(reverse=True)
print(cands[0][1],cands[0][2]) if cands else sys.exit(1)'); then X=${C2% *}; Y=${C2#* }; fi
adb shell input swipe "$X" "$Y" $((SW/2)) $((SH/3)) 2000; sleep 3
adb shell input keyevent KEYCODE_HOME; sleep 2
echo "--- widgets now bound to our provider ---"
adb shell dumpsys appwidget | grep -A3 -iE "orbitalempire" | head -20
