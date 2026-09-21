#!/usr/bin/env bash
# ============================================================
# Does the watch build PLAY SERVES start on a watch?
#
# wear-smoke.sh answers that for our own debug build, and it passes.
# A real watch still would not launch the app. The difference is the
# artifact: Play regenerates the watch APK from the bundle, re-signs it,
# replaces the Application class with com.pairip.application.Application
# and adds a license check (com.pairip.licensecheck.LicenseActivity).
# This installs exactly those APKs, the way Play does (base + splits),
# and reports what happens.
#
# EXPECT the license check to object: an emulator install did not come
# from Play. What matters is HOW it objects. On the phone it opens its
# own screen and the process lives; if on a watch it crashes or finishes
# the task, that is a real watch's launch too whenever the check fails.
#
# Informational: it always exits 0 and prints its findings, because the
# license objection makes "failure" ambiguous by design.
# ============================================================
set -uo pipefail

DIR="${1:-/tmp/wearplay}"
PKG=com.orbitalempire.game
ACT="$PKG/com.orbitalempire.wear.MainActivity"
OUT="${2:-wear-shots}"
mkdir -p "$OUT"

if ! ls "$DIR"/*.apk >/dev/null 2>&1; then
  echo "no Play watch APKs in $DIR (no secret on this run?) -- skipped"
  exit 0
fi

echo "=== Play's watch build ==="
ls -l "$DIR"

echo "=== install (as Play does: base + splits) ==="
adb uninstall "$PKG" >/dev/null 2>&1
adb install-multiple -r "$DIR"/*.apk 2>&1 | tail -3
adb shell pm path "$PKG"

echo "=== launch ==="
adb logcat -c
adb shell am start -n "$ACT" -W 2>&1 | tail -6

for t in 2 5 12; do
  sleep $(( t == 2 ? 2 : (t == 5 ? 3 : 7) ))
  echo "--- after ${t}s ---"
  echo "process: $(adb shell pidof "$PKG" || echo DEAD)"
  adb shell dumpsys activity activities | grep -E "ResumedActivity|topResumedActivity|mFocusedApp" | head -3
done

adb exec-out screencap -p > "$OUT/wear-play-launch.png" 2>/dev/null
[ -s "$OUT/wear-play-launch.png" ] && echo "screenshot: $(wc -c < "$OUT/wear-play-launch.png") bytes"

echo "=== everything the app, pairip and the system said ==="
adb logcat -d -v time | grep -iE "orbitalempire|pairip|licens|AndroidRuntime|FATAL|ActivityTaskManager|ActivityManager: (Process|Killing|Force)|am_crash|DEBUG +:|Abort message|backtrace" | head -150

echo "=== the app's own exit reasons (API 30+) ==="
adb shell dumpsys activity exit-info "$PKG" | head -60

exit 0
