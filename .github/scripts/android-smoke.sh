#!/usr/bin/env bash
# ============================================================
# The four launch scenarios, run against a booted emulator.
#
# ONE FILE, ON PURPOSE. reactivecircus/android-emulator-runner executes
# every line of its `script:` input as a separate `sh -c`, so shell
# variables and functions defined on one line do not exist on the next.
# The first version of this lived inline and every `$LAUNCH` expanded to
# nothing — the emulator booted, ran `am start -n` with no argument, and
# reported success on a test that had tested nothing.
# ============================================================
set -u

PKG=com.orbitalempire.game
LAUNCH="$PKG/com.google.androidbrowserhelper.trusted.LauncherActivity"

alive() {
  if adb shell pidof "$PKG" >/dev/null 2>&1; then echo ">>> process ALIVE"; else echo ">>> process DEAD"; fi
}
fatal() {
  echo "--- AndroidRuntime:E ---"
  adb logcat -d AndroidRuntime:E '*:S' | grep -v "^--------- beginning" | head -80
  echo "--- end ---"
}

adb install -r android/app/build/outputs/apk/debug/app-debug.apk

echo "==================== 1. CLEAN LAUNCH ===================="
adb logcat -c
adb shell am start -W -n "$LAUNCH" || true
sleep 8
fatal; alive
adb shell am force-stop "$PKG"

echo "==================== 2. WIDGET RECEIVER, TOKEN PLANTED ===================="
adb push /tmp/orbital_widget.xml /data/local/tmp/orbital_widget.xml
adb shell run-as "$PKG" mkdir -p shared_prefs
adb shell run-as "$PKG" cp /data/local/tmp/orbital_widget.xml shared_prefs/orbital_widget.xml
echo "--- planted prefs ---"
adb shell run-as "$PKG" cat shared_prefs/orbital_widget.xml
adb logcat -c
adb shell am broadcast -a android.appwidget.action.APPWIDGET_UPDATE -n "$PKG/.OrbitalWidget" --eia appWidgetIds 42
sleep 10
echo "--- OrbitalWidget log ---"
adb logcat -d OrbitalWidget:V '*:S' | grep -v "^--------- beginning" | head -40
fatal; alive

echo "==================== 3. LAUNCH AFTER THE RECEIVER (the phone's state) ===================="
adb logcat -c
adb shell am start -W -n "$LAUNCH" || true
sleep 8
fatal; alive
adb shell dumpsys activity activities | grep -iE "orbitalempire|chrome" | head -8
adb shell am force-stop "$PKG"

echo "==================== 4. OPEN VIA THE WIDGET TAP RELAY ===================="
adb logcat -c
adb shell am start -W -n "$PKG/.LauncherRelayActivity" || true
sleep 8
fatal; alive
adb shell dumpsys activity activities | grep -iE "orbitalempire|chrome" | head -8

echo "==================== CHROME ON THIS IMAGE ===================="
adb shell dumpsys package com.android.chrome | grep -m1 versionName || echo "no chrome"
