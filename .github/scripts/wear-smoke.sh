#!/usr/bin/env bash
# ============================================================
# Does the watch app install, launch and stay up on a real Wear OS?
#
# THE QUESTION NOTHING ELSE HAS ANSWERED. Every check that can be run
# from outside says the release is correct -- the bundle declares the
# watch feature, both wear tracks carry one completed release for all
# countries, the listing has its Wear screenshots and they cleared
# review, the tester accepted the opt-in -- and a real Galaxy Watch is
# still offered nothing. That leaves exactly two possibilities, and they
# want different fixes:
#
#   the artifact is broken     -> this run fails, and says how
#   Play's serving is at fault -> this run passes, and the argument
#                                 moves to Play with evidence
#
# So this is not a test of the UI. It is a test of the premise.
#
# It also produces the thing the store listing really wants: screenshots
# captured from a running watch rather than drawn to match one.
# ============================================================
set -uo pipefail

APK="$1"
PKG=com.orbitalempire.game
ACT="$PKG/com.orbitalempire.wear.MainActivity"
OUT="${2:-wear-shots}"
mkdir -p "$OUT"

fail() { echo "FAIL  $*"; FAILED=1; }
ok()   { echo "PASS  $*"; }
FAILED=0

echo "=== the emulator we got ==="
adb shell getprop ro.build.version.sdk
adb shell getprop ro.build.characteristics
adb shell getprop ro.product.model

# THE FEATURE PLAY FILTERS ON. If the image does not report itself as a
# watch, this whole run is measuring the wrong device and every result
# below is meaningless -- so it is checked first and loudly.
if adb shell pm list features | grep -q 'android.hardware.type.watch'; then
  ok "the emulator reports android.hardware.type.watch"
else
  fail "this image is NOT a watch; the run proves nothing about Wear"
fi

echo "=== install ==="
# -r so a rerun replaces rather than errors; -d because a debuggable
# downgrade is normal on a rerun of the same version code.
if adb install -r -d "$APK" 2>&1 | tee /tmp/install.log | tail -3; then
  if grep -qi 'success' /tmp/install.log; then
    ok "installed"
  else
    fail "install did not report success"
  fi
else
  fail "install failed"
fi

# INSTALLABILITY IS THE HEADLINE. If the package manager refuses the
# APK on a genuine watch image, Play refusing to serve it is not a
# distribution mystery -- it is the same refusal, earlier.
adb shell pm path "$PKG" | tee /tmp/paths.txt
grep -q 'package:' /tmp/paths.txt && ok "package manager sees it" || fail "package not present after install"

echo "=== launch ==="
adb logcat -c
adb shell am start -n "$ACT" -W 2>&1 | tee /tmp/start.log | tail -5
grep -qiE 'Error|does not exist|Permission Denial' /tmp/start.log \
  && fail "am start reported an error" || ok "activity started"

# Compose takes a moment on a cold start, and the pairing screen has a
# network call behind its button rather than in front of it, so there is
# nothing to wait on but the frame.
sleep 12

echo "=== is it still up? ==="
if adb shell dumpsys activity activities | grep -q "$PKG"; then
  ok "still in the activity stack after 12s"
else
  fail "the app is gone from the activity stack -- it died"
fi

echo "=== screenshot ==="
adb exec-out screencap -p > "$OUT/wear-launch.png" 2>/dev/null
if [ -s "$OUT/wear-launch.png" ]; then
  ok "captured $(wc -c < "$OUT/wear-launch.png") bytes"
else
  fail "screencap produced nothing"
fi

echo "=== crashes ==="
adb logcat -d -v brief '*:E' | grep -iE "orbitalempire|orbitalwear|AndroidRuntime" \
  | head -40 | tee /tmp/errs.txt
if grep -qiE 'FATAL|AndroidRuntime' /tmp/errs.txt; then
  fail "there is a fatal exception in logcat (above)"
else
  ok "no fatal exception"
fi

echo "=== tiles ==="
# THE THREE TILES, ON THE WATCH'S OWN CAROUSEL, WITH REAL DATA. A paired
# token is planted first (the debug build is debuggable, so run-as can
# write its prefs). It is a WEAR-scoped token for a CI agent faction in
# a test game -- read state and vote there, nothing else -- the same
# kind of planted credential android-smoke.sh uses for the card.
TOKEN=P-woDBRQAPt18wc66DYlVpkQLFKlLkrc
cat > /tmp/orbital_wear.xml <<EOF
<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="token">$TOKEN</string>
</map>
EOF
adb push /tmp/orbital_wear.xml /data/local/tmp/orbital_wear.xml >/dev/null
adb shell "run-as $PKG sh -c 'mkdir -p shared_prefs && cp /data/local/tmp/orbital_wear.xml shared_prefs/orbital_wear.xml'"
adb shell am force-stop "$PKG"

# The debug surface: add each tile to the carousel, then show it.
i=0
for svc in EmpireTileService BattlesTileService SenateTileService; do
  adb logcat -c
  adb shell am broadcast -a com.google.android.wearable.app.DEBUG_SURFACE \
    --es operation add-tile --ecn component "$PKG/com.orbitalempire.wear.$svc" 2>&1 | tail -1
  adb shell am broadcast -a com.google.android.wearable.app.DEBUG_SYSUI \
    --es operation show-tile --ei index "$i" 2>&1 | tail -1
  sleep 10
  adb exec-out screencap -p > "$OUT/tile-$svc.png" 2>/dev/null
  if [ -s "$OUT/tile-$svc.png" ]; then ok "$svc drawn ($(wc -c < "$OUT/tile-$svc.png") bytes)"; else fail "$svc: no screenshot"; fi
  adb logcat -d -v brief '*:E' | grep -iE "AndroidRuntime|orbitalempire|protolayout|Tile" | head -15
  i=$((i + 1))
done
if adb logcat -d | grep -q "FATAL EXCEPTION"; then fail "a tile crashed (above)"; fi

echo
[ "$FAILED" = 0 ] && echo "WEAR SMOKE PASSED" || echo "WEAR SMOKE FAILED"
exit "$FAILED"
