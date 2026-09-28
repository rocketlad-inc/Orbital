#!/usr/bin/env bash
# ============================================================
# THE REVIEW RIG: every watch screen, drawn from a real player's data.
#
#   wear-review.sh <debug apk> <out dir>
#   env FIXTURE_B64 = base64 of a .tar.gz holding the documents a watch
#                     fetches (state, command, worlds, standings,
#                     destinations .json) and shots.txt
#
# The documents are taken read-only from production by the server's own
# handlers and handed in as a workflow input, never committed: they are a
# player's empire, messages included. The app draws them in its debug-only
# fixture mode (MainActivity.EXTRA_FIXTURE), which fetches nothing and
# holds no token.
#
# shots.txt, one screen a line:   name|am start extras|scroll steps
# Each screen is shot once, then once per scroll step (a swipe up), at two
# sizes: the Galaxy Watch6 Classic 47mm (480x480, xhdpi) and the emulator's
# own small round face -- a layout that fits the big one and not the small
# one is still a bug.
# ============================================================
set -u
APK="$1"
OUT="$2"
mkdir -p "$OUT"
PKG=com.orbitalempire.game
ACT="$PKG/com.orbitalempire.wear.MainActivity"

adb install -r "$APK" >/dev/null || { echo "install failed"; exit 1; }

mkdir -p /tmp/fx
printf '%s' "${FIXTURE_B64:-}" | base64 -d | tar -xz -C /tmp/fx || { echo "no fixture"; exit 1; }
ls -la /tmp/fx
adb shell "run-as $PKG mkdir -p files/fixture"
for f in /tmp/fx/*.json; do
  n=$(basename "$f")
  adb push "$f" "/data/local/tmp/$n" >/dev/null
  adb shell "run-as $PKG sh -c 'cat /data/local/tmp/$n > files/fixture/$n'"
  adb shell "rm /data/local/tmp/$n"
done
adb shell "run-as $PKG ls -la files/fixture"

shoot() {
  local prefix="$1" w="$2" line name extras scrolls
  # Read up front: adb shell inside a `while read` loop eats the rest of
  # the list from stdin, and only the first screen would be shot.
  local -a lines
  mapfile -t lines < /tmp/fx/shots.txt
  for line in "${lines[@]}"; do
    IFS='|' read -r name extras scrolls <<< "$line"
    [ -z "$name" ] && continue
    adb shell am force-stop "$PKG"
    adb shell input keyevent KEYCODE_WAKEUP
    # shellcheck disable=SC2086
    adb shell am start -n "$ACT" --ez fixture true $extras >/dev/null
    if [ "$name" = "ticklanded" ]; then sleep 5; else sleep 11; fi
    adb exec-out screencap -p > "$OUT/$prefix-$name.png"
    for i in $(seq 1 "${scrolls:-0}"); do
      adb shell input swipe $((w / 2)) $((w * 3 / 4)) $((w / 2)) $((w / 4)) 400
      sleep 2
      adb exec-out screencap -p > "$OUT/$prefix-$name-scroll$i.png"
    done
  done
}

# The player's own watch first.
adb shell wm size 480x480
adb shell wm density 320
sleep 3
shoot big 480
# Then the small face the emulator ships with.
adb shell wm size reset
adb shell wm density reset
sleep 3
shoot small "$(adb shell wm size | grep -oE '[0-9]+x' | head -1 | tr -d x)"

if adb logcat -d | grep -A2 "FATAL EXCEPTION" | grep -q "Process: $PKG"; then
  echo "A SCREEN CRASHED:"
  adb logcat -d | grep -A20 "FATAL EXCEPTION" | head -60
fi
ls "$OUT" | wc -l
