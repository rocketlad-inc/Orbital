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
BASE_URL=https://orbital-empire.com
LAUNCH="$PKG/com.google.androidbrowserhelper.trusted.LauncherActivity"

alive() {
  if adb shell pidof "$PKG" >/dev/null 2>&1; then echo ">>> process ALIVE"; else echo ">>> process DEAD"; fi
}
fatal() {
  echo "--- AndroidRuntime:E ---"
  adb logcat -d AndroidRuntime:E '*:S' | grep -v "^--------- beginning" | head -80
  echo "--- end ---"
}

# Root, so the shell may send the protected APPWIDGET_UPDATE broadcast
# and start non-exported activities. google_apis images allow it;
# playstore images do not, which is why this job uses google_apis.
adb root >/dev/null 2>&1 || echo "(adb root unavailable; scenarios 2 and 4 will be permission-denied)"
adb wait-for-device
sleep 3

# Get Chrome past its first-run screen, or the Trusted Web Activity never
# actually launches and the page never loads -- every earlier scenario
# stopped at FirstRunActivity and tested the shell, not the app.
CHROME_PREFS=/data/data/com.android.chrome/shared_prefs
adb shell mkdir -p "$CHROME_PREFS" >/dev/null 2>&1
cat > /tmp/chrome_prefs.xml <<'X'
<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <boolean name="first_run_flow" value="true" />
    <boolean name="first_run_tos_accepted" value="true" />
    <boolean name="skip_welcome_page" value="true" />
    <boolean name="first_run_signin_complete" value="true" />
</map>
X
adb push /tmp/chrome_prefs.xml /data/local/tmp/chrome_prefs.xml >/dev/null
adb shell "cp /data/local/tmp/chrome_prefs.xml $CHROME_PREFS/com.android.chrome_preferences.xml && chown \$(stat -c %u:%g /data/data/com.android.chrome) $CHROME_PREFS/com.android.chrome_preferences.xml && chmod 660 $CHROME_PREFS/com.android.chrome_preferences.xml" || echo "(could not write Chrome prefs; FRE may still appear)"

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

echo "==================== 5. INSTALL THE WAY PLAY DOES (split APKs from the AAB) ===================="
# Play never ships the universal APK. It takes the AAB and serves each
# device a base APK plus config splits for its density, ABI and locale.
# Every sideload tested above was the universal APK, so a crash that
# lives only in the split layout would pass all four scenarios and still
# crash on every phone that installed from the store. bundletool builds
# the same split set Play would for this device.
adb shell am force-stop "$PKG"
adb uninstall "$PKG" >/dev/null 2>&1 || true
# A throwaway key. Gradle's debug keystore is not reliably where the
# docs say on a CI runner, and the emulator does not care whose key it
# is -- only that the splits are signed consistently.
keytool -genkeypair -v -keystore /tmp/smoke.jks -storepass smokepass -keypass smokepass \
  -alias smoke -keyalg RSA -keysize 2048 -validity 1 -dname "CN=smoke" >/dev/null 2>&1
java -jar /tmp/bundletool.jar build-apks \
  --bundle=android/app/build/outputs/bundle/debug/app-debug.aab \
  --output=/tmp/orbital.apks --overwrite --connected-device \
  --ks=/tmp/smoke.jks --ks-pass=pass:smokepass \
  --ks-key-alias=smoke --key-pass=pass:smokepass
echo "--- splits built for this device ---"
unzip -l /tmp/orbital.apks | grep -E "\.apk" || true
java -jar /tmp/bundletool.jar install-apks --apks=/tmp/orbital.apks
echo "--- splits installed ---"
adb shell pm path "$PKG"
adb logcat -c
adb shell am start -W -n "$LAUNCH" || true
sleep 8
fatal; alive

echo "==================== 6. INSTALL THE ACTUAL PLAY ARTIFACT (Google-signed) ===================="
# Scenario 5 proved the split LAYOUT is fine. This one proves the
# SIGNATURE is: these APKs came from Play's own API, generated from the
# AAB and signed with Google's app signing key -- the certificate a
# store install carries and the one assetlinks.json did not list until
# tonight. If a launch crash is specific to the store install, this is
# the first scenario that can see it.
if ls /tmp/playapks/*.apk >/dev/null 2>&1; then
  # WHAT PLAY DID TO THE MANIFEST. Play's automatic integrity protection
  # repackages the bundle and REPLACES android:name on <application>
  # with com.pairip.application.Application, without delegating to the
  # class it displaced. Our Application subclass therefore ran on every
  # emulator here and on no phone that installed from the store -- the
  # widget's whole invisible-pairing path was dead in the field while
  # this file reported success. Nothing else in CI can see that, because
  # nothing else installs the artifact Play actually serves.
  AAPT=$(ls "${ANDROID_HOME:-$ANDROID_SDK_ROOT}"/build-tools/*/aapt2 2>/dev/null | tail -1)
  if [ -n "$AAPT" ]; then
    echo "--- what Play made of our manifest ---"
    "$AAPT" dump xmltree --file AndroidManifest.xml /tmp/playapks/base.apk > /tmp/playman.txt 2>/dev/null || true
    grep -E "application|provider|E: " /tmp/playman.txt | grep -iE "name|application" | head -20
    if grep -q "OrbitalStartup" /tmp/playman.txt; then
      echo ">>> THE STARTUP HOOK SURVIVED PLAY"
    else
      echo ">>> THE STARTUP HOOK IS GONE FROM THE PLAY BUILD -- the widget will not pair on an app open"
    fi
    if grep -q "pairip" /tmp/playman.txt; then
      echo ">>> (Play integrity protection is rewriting this app; never put startup code in Application)"
    fi
  else
    echo "(no aapt2; cannot inspect the Play manifest)"
  fi
  adb shell am force-stop "$PKG"
  adb uninstall "$PKG" >/dev/null 2>&1 || true
  adb install-multiple /tmp/playapks/base.apk /tmp/playapks/split_config.xxhdpi.apk /tmp/playapks/split_config.en.apk
  echo "--- installed ---"
  adb shell pm path "$PKG"
  adb logcat -c
  adb shell am start -W -n "$LAUNCH" || true
  sleep 10
  fatal; alive
  echo "--- anything from the app or chrome about the launch ---"
  adb logcat -d | grep -iE "orbitalempire|TWALauncher|TwaLauncher|androidbrowserhelper|OriginVerifier|TrustedWebActivity" | grep -v "BroadcastQueue" | head -30
else
  echo "no Play artifact fetched; skipped"
fi

echo "==================== 7. REAL WIDGET ON THE LAUNCHER, TOKEN PLANTED, THEN LAUNCH ===================="
# The scenario the phone is actually in. The universal debug APK goes
# back on (run-as needs debuggable), the token is planted BEFORE the
# widget is placed so its very first render takes the network path, and
# then the app is opened with the receiver having run for real.
adb shell am force-stop "$PKG"
adb uninstall "$PKG" >/dev/null 2>&1 || true
adb install -r android/app/build/outputs/apk/debug/app-debug.apk >/dev/null
adb shell run-as "$PKG" mkdir -p shared_prefs
adb shell run-as "$PKG" cp /data/local/tmp/orbital_widget.xml shared_prefs/orbital_widget.xml
adb logcat -c
bash .github/scripts/place-widget.sh || echo "(widget placement did not complete)"
sleep 12
echo "--- OrbitalWidget log ---"
adb logcat -d OrbitalWidget:V '*:S' | grep -v "^--------- beginning" | head -40
fatal; alive
echo "--- now open the app with the widget live ---"
adb logcat -c
adb shell am start -W -n "$LAUNCH" || true
sleep 15
fatal; alive
adb shell dumpsys activity activities | grep -iE "orbitalempire|chrome" | head -8
echo "--- chrome / renderer trouble, if any ---"
adb logcat -d | grep -iE "FATAL|chromium.*crash|Fatal signal|has died|ANR in" | grep -viE "SwiftShader" | head -20

echo "==================== 8. A REAL WIDGET, BOUND BY AN AppWidgetHost IN OUR OWN PROCESS ===================="
# The deterministic version of scenario 7. The instrumentation is an
# AppWidgetHost -- which is what a launcher is -- so the system delivers
# the genuine update with a genuine id and phone-sized options into this
# process. If the receiver kills the process, am instrument reports
# "Process crashed" and AndroidRuntime:E has the trace.
adb shell am force-stop "$PKG"
adb uninstall "$PKG" >/dev/null 2>&1 || true
adb install -r android/app/build/outputs/apk/debug/app-debug.apk >/dev/null
adb install -r android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk >/dev/null
adb shell run-as "$PKG" mkdir -p shared_prefs
adb shell run-as "$PKG" cp /data/local/tmp/orbital_widget.xml shared_prefs/orbital_widget.xml
adb shell appwidget grantbind --package "$PKG" --user 0 || echo "(grantbind failed)"
adb logcat -c
adb shell am instrument -w -e class com.orbitalempire.game.RealWidgetTest "$PKG.test/androidx.test.runner.AndroidJUnitRunner" 2>&1 | tail -20
echo "--- OrbitalWidget + test log ---"
adb logcat -d OrbitalWidget:V RealWidgetTest:V '*:S' | grep -v "^--------- beginning" | head -40
fatal; alive
echo "--- widgets bound ---"
adb shell dumpsys appwidget | grep -B1 -A6 "Widgets:" | grep -iE "orbitalempire|id=|host" | head -10
echo "--- now open the app with the widget live ---"
adb logcat -c
adb shell am start -W -n "$LAUNCH" || true
sleep 12
fatal; alive

echo "==================== 9. DROP THE WIDGET, WALK AWAY: PAIRING END TO END ===================="
# Requirement 1, as the phone experiences it, with NOTHING planted. A
# real widget is bound -- which is all that placing one does now, since
# there is no configuration activity -- and the receiver has to invent
# its own pairing code. The player then opens the game the ordinary way,
# which is where the app quietly points the launch at the connect page
# and starts polling. The connect page's own job (the authenticated
# POST) is done by the script, because an emulator has no session.
# Nothing here taps the widget or names a code.
pair_scenario() {
  LABEL="$1"
  adb shell am force-stop "$PKG"
  adb shell run-as "$PKG" rm -f shared_prefs/orbital_widget.xml || true
  adb shell appwidget grantbind --package "$PKG" --user 0 >/dev/null 2>&1 || true
  adb logcat -c

  # PLACEMENT. Binding a widget is the whole of it.
  adb shell am instrument -w -e class com.orbitalempire.game.RealWidgetTest "$PKG.test/androidx.test.runner.AndroidJUnitRunner" > /tmp/instr.log 2>&1 || true
  tail -2 /tmp/instr.log
  echo "--- prefs after placement: a code the widget invented, no token ---"
  adb shell run-as "$PKG" cat shared_prefs/orbital_widget.xml || true
  # THE REGRESSION THIS EXISTS FOR: placement must not open the game.
  # A configuration activity that did took the screen from the launcher
  # and the widget was never placed at all.
  if adb logcat -d ActivityTaskManager:I ActivityManager:I '*:S' | grep -q "Displayed $PKG/com.google.androidbrowserhelper"; then
    echo ">>> PLACEMENT OPENED THE GAME ($LABEL) -- this is the bug"
  else
    echo ">>> placement opened nothing ($LABEL)"
  fi

  # THE PLAYER OPENS THE GAME, the ordinary way, from the icon. The
  # launch must carry the code into the GAME itself (?w=), not into a
  # connect page of its own: the extra document load in front of the
  # game was seconds of grey on a real phone.
  adb logcat -c
  adb shell am start -W -n "$LAUNCH" >/dev/null || true
  sleep 5
  CODE=$(adb shell run-as "$PKG" cat shared_prefs/orbital_widget.xml | tr -d '\r' | grep -oE 'name="pending_code">[^<]+' | cut -d'>' -f2)
  echo "the widget's own code: ${CODE:0:8}..."
  if adb logcat -d OrbitalWidget:V '*:S' | grep -q "launch carries the pairing code"; then
    echo ">>> LAUNCH CARRIES THE CODE ($LABEL)"
  else
    echo ">>> launch did not carry the code ($LABEL)"
  fi
  # And it must be the game, not a page in front of it.
  LAUNCHED=$(adb shell dumpsys activity activities | grep -oE "orbital-empire[^ ]*" | head -1)
  case "$LAUNCHED" in
    *"/widget/connect"*) echo ">>> THE LAUNCH GOES VIA A CONNECT PAGE ($LABEL) -- that is the grey screen" ;;
    *) echo ">>> launch goes straight to the game ($LABEL)" ;;
  esac

  # The connect page's job: the same POST it makes, with a real session.
  TOK=$(curl -sS -X POST "$BASE_URL/api/agent/session" -H "X-Agent-Key: $ORBITAL_AGENT_KEY" -H "content-type: application/json" -d '{"handle":"widgetpair"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
  curl -sS -X POST "$BASE_URL/api/me/widget-tokens/pair" -H "Authorization: Bearer $TOK" -H "content-type: application/json" -d "{\"code\":\"$CODE\"}" | head -c 120; echo
  sleep 25

  echo "--- widget log ---"
  adb logcat -d OrbitalWidget:V '*:S' | grep -v "^--------- beginning" | head -25
  echo "--- prefs after ---"
  adb shell run-as "$PKG" cat shared_prefs/orbital_widget.xml
  if adb shell run-as "$PKG" cat shared_prefs/orbital_widget.xml | grep -q 'name="token"'; then echo ">>> PAIRED ($LABEL)"; else echo ">>> NOT PAIRED ($LABEL)"; fi
  if adb shell run-as "$PKG" cat shared_prefs/orbital_widget.xml | grep -q 'name="drew_once" value="true"'; then echo ">>> PAINTED ($LABEL)"; else echo ">>> NOT PAINTED ($LABEL)"; fi
  fatal; alive
  adb shell am force-stop "$PKG"
}

if [ -n "${ORBITAL_AGENT_KEY:-}" ]; then
  adb uninstall "$PKG" >/dev/null 2>&1 || true
  adb install -r android/app/build/outputs/apk/debug/app-debug.apk >/dev/null
  adb install -r android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk >/dev/null
  pair_scenario "clean"
else
  echo "ORBITAL_AGENT_KEY not set; skipped"
fi

echo "==================== 10. THE PHONE: DATA SAVER ON, APP RESTRICTED ===================="
# "Unknown host exception" on the real phone. Chrome, which does all the
# game's networking, is foreground and unaffected; the widget's fetch is
# our own process, and Data Saver blocks background network -- DNS
# first, which surfaces as UnknownHostException. TWO THINGS THE FIRST
# VERSION OF THIS GOT WRONG, both of which made it pass on unfixed code:
# Data Saver only bites on a METERED network, and the emulator's Wi-Fi
# is unmetered; and an instrumented process counts as foreground, so the
# instrumentation must be finished before the part under test.
if [ -n "${ORBITAL_AGENT_KEY:-}" ]; then
  UID_=$(adb shell dumpsys package "$PKG" | grep -oE "userId=[0-9]+" | head -1 | cut -d= -f2)
  echo "app uid=$UID_"
  adb shell cmd netpolicy set restrict-background true
  adb shell cmd netpolicy add restrict-background-blacklist "$UID_" || true
  for SSID in $(adb shell cmd netpolicy list wifi-networks | tr -d '\r' | cut -d';' -f1); do
    adb shell cmd netpolicy set metered-network "$SSID" true || true
  done
  adb shell cmd netpolicy get restrict-background
  adb shell cmd netpolicy list wifi-networks || true
  pair_scenario "data saver"
  adb shell cmd netpolicy remove restrict-background-blacklist "$UID_" || true
  adb shell cmd netpolicy set restrict-background false
else
  echo "ORBITAL_AGENT_KEY not set; skipped"
fi
