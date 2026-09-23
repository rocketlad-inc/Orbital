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
if adb logcat -d | grep -A2 "FATAL EXCEPTION" | grep -q "Process: $PKG"; then
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

# The debug surface ADDS each tile to the carousel. Showing one is done
# the way a finger does it: wake, go to the watch face, swipe left. (The
# show-tile operation returns 0 on this Wear OS 3 image and navigates
# nowhere, which photographed three black screens.)
adb logcat -c
for svc in EmpireTileService BattlesTileService SenateTileService TerritoryTileService; do
  adb shell am broadcast -a com.google.android.wearable.app.DEBUG_SURFACE     --es operation add-tile --ecn component "$PKG/com.orbitalempire.wear.$svc" 2>&1 | tail -1
done
adb shell input keyevent KEYCODE_WAKEUP
adb shell input keyevent KEYCODE_HOME
sleep 3
adb exec-out screencap -p > "$OUT/tile-0-watchface.png" 2>/dev/null
for n in 1 2 3 4 5 6; do
  adb shell input keyevent KEYCODE_WAKEUP
  adb shell input swipe 290 160 30 160 150
  sleep 7
  adb exec-out screencap -p > "$OUT/tile-$n.png" 2>/dev/null
  echo "swipe $n: $(wc -c < "$OUT/tile-$n.png") bytes"
done
echo "--- tile services bound ---"
adb shell dumpsys activity services "$PKG" | grep -E "ServiceRecord|intent=" | head -12
echo "--- tile log ---"
adb logcat -d -v brief | grep -iE "TileService|orbitalempire|protolayout|TileRenderer|AndroidRuntime" | grep -v "chatty" | head -40
if adb logcat -d | grep -A2 "FATAL EXCEPTION" | grep -q "Process: $PKG"; then fail "a tile crashed (above)"; fi

echo "=== systems and porthole ==="
# The app itself screenshots fine (the tile carousel does not), so the
# two new views are photographed here, with the planted token's data.
adb logcat -c
adb shell input keyevent KEYCODE_WAKEUP
adb shell am start -n "$ACT" --ei page 3 >/dev/null
sleep 14
adb exec-out screencap -p > "$OUT/systems.png" 2>/dev/null
echo "systems: $(wc -c < "$OUT/systems.png") bytes"
adb shell am force-stop "$PKG"
adb shell input keyevent KEYCODE_WAKEUP
adb shell am start -n "$ACT" --es porthole "NIHhWA6i_wId:oberon" >/dev/null
sleep 14
adb exec-out screencap -p > "$OUT/porthole.png" 2>/dev/null
echo "porthole: $(wc -c < "$OUT/porthole.png") bytes"
adb logcat -d -v brief '*:E' | grep -iE "AndroidRuntime|orbitalempire|OrbitalWear" | head -20
if adb logcat -d | grep -A2 "FATAL EXCEPTION" | grep -q "Process: $PKG"; then fail "systems or porthole crashed (above)"; fi

echo "=== orders, comms, yards ==="
# The ORDERS-scope token for the same CI agent faction (wear_orders), so
# the order screens render as a player who allowed orders sees them.
cat > /tmp/orbital_wear.xml <<EOF
<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="token">anUY612FcbwYXmeq-BrtXcGBfzg1gtSw</string>
</map>
EOF
adb push /tmp/orbital_wear.xml /data/local/tmp/orbital_wear.xml >/dev/null
adb shell "run-as $PKG sh -c 'cp /data/local/tmp/orbital_wear.xml shared_prefs/orbital_wear.xml'"
# Territory is page 4 now; comms and yards shifted one along with it.
for shot in "orders:--es orders NIHhWA6i_wId:s1_oberon_0" "territory:--ei page 4" "comms:--ei page 5" "yards:--ei page 6" "battlefx:--ez fxdemo true"; do
  name="${shot%%:*}"; extra="${shot#*:}"
  adb shell am force-stop "$PKG"
  adb shell input keyevent KEYCODE_WAKEUP
  adb shell am start -n "$ACT" $extra >/dev/null
  sleep 14
  adb exec-out screencap -p > "$OUT/$name.png" 2>/dev/null
  echo "$name: $(wc -c < "$OUT/$name.png") bytes"
done
if adb logcat -d | grep -A2 "FATAL EXCEPTION" | grep -q "Process: $PKG"; then fail "an order screen crashed (above)"; fi

echo
[ "$FAILED" = 0 ] && echo "WEAR SMOKE PASSED" || echo "WEAR SMOKE FAILED"
exit "$FAILED"
