#!/usr/bin/env bash
# ============================================================
# CalledIt — build the Android APK without Android Studio.
#
# Works with a standard Android SDK ($ANDROID_HOME) OR with
# standalone tools pointed at by env vars:
#   JAVA        java runtime (default: java)
#   ANDROID_JAR android.jar (default: $ANDROID_HOME/platforms/android-34/android.jar)
#   AAPT2       aapt2 binary
#   D8          d8 jar (or 'd8' script via D8_CMD)
#   ECJ_JAR     Eclipse compiler jar (only if 'javac' is not on PATH)
#   APKSIGNER   apksigner jar (runs with java) or apksigner binary
#   PREBUILT_DEX optional: a classes.dex — or an APK to take it from — built
#               from the SAME Java sources. Java is still compiled (so source
#               errors still fail the build) but the d8 step is skipped. For
#               web-only releases when no JVM d8 is at hand.
#
# Output: android/dist/CalledIt-<version>.apk  (signed with a debug keystore)
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"   # repo root (website + android/)
AND="$ROOT/android"
BUILD="$AND/ci/build"
DIST="$AND/dist"
JAVA="${JAVA:-java}"
AAPT2="${AAPT2:-${ANDROID_HOME:-}/build-tools/34.0.0/aapt2}"
ANDROID_JAR="${ANDROID_JAR:-${ANDROID_HOME:-}/platforms/android-34/android.jar}"
VERSION_NAME="${VERSION_NAME:-1.2.2}"
VERSION_CODE="${VERSION_CODE:-5}"

mkdir -p "$BUILD" "$DIST"
rm -rf "$BUILD"/* 

echo "== 1/7 staging web assets =="
# The app serves files from assets/www/… (MainActivity: getAssets().open("www" + path)),
# so stage them under <assets-root>/www and hand aapt2 the assets ROOT.
WWW="$BUILD/assets/www"
mkdir -p "$WWW"
cp "$ROOT"/index.html "$ROOT"/start.html "$ROOT"/trails.html "$ROOT"/social.html "$ROOT"/manifest.webmanifest "$WWW/"
cp -r "$ROOT"/css "$ROOT"/js "$ROOT"/assets "$ROOT"/vendor "$WWW/"

echo "== 2/7 compile Java =="
mkdir -p "$BUILD/classes"
SOURCES="$AND/app/src/main/java/com/calledit/app/MainActivity.java $AND/app/src/main/java/com/calledit/app/LocalServer.java"
if command -v javac >/dev/null 2>&1; then
  javac -source 1.8 -target 1.8 -bootclasspath "$ANDROID_JAR" -classpath "$ANDROID_JAR" \
        -d "$BUILD/classes" $SOURCES
else
  "$JAVA" -jar "$ECJ_JAR" -source 1.8 -target 1.8 -nowarn \
        -bootclasspath "$ANDROID_JAR" -classpath "$ANDROID_JAR" \
        -d "$BUILD/classes" $SOURCES
fi

echo "== 3/7 dex (d8) =="
mkdir -p "$BUILD/dex"
if [ -n "${PREBUILT_DEX:-}" ]; then
  case "$PREBUILT_DEX" in
    *.apk) unzip -p "$PREBUILT_DEX" classes.dex > "$BUILD/dex/classes.dex" ;;
    *)     cp "$PREBUILT_DEX" "$BUILD/dex/classes.dex" ;;
  esac
  [ -s "$BUILD/dex/classes.dex" ] || { echo "PREBUILT_DEX has no classes.dex" >&2; exit 1; }
  echo "   (reusing classes.dex from $PREBUILT_DEX — Java sources must be unchanged)"
elif [ -n "${D8_CMD:-}" ]; then
  $D8_CMD --min-api 24 --output "$BUILD/dex" "$BUILD/classes"
elif command -v d8 >/dev/null 2>&1; then
  d8 --min-api 24 --output "$BUILD/dex" "$BUILD/classes"
else
  # plain d8.jar on a JVM; older d8 needs explicit files, so pass a classes jar
  ( cd "$BUILD/classes" && "$JAVA" -version >/dev/null 2>&1 && jar cf "$BUILD/classes.jar" . 2>/dev/null || \
    python3 -c "import zipfile,os,sys
z=zipfile.ZipFile('$BUILD/classes.jar','w')
for r,d,fs in os.walk('.'):
    for f in fs: z.write(os.path.join(r,f), os.path.relpath(os.path.join(r,f),'.'))
z.close()" )
  "$JAVA" -Xverify:none -cp "$D8" com.android.tools.r8.D8 --min-api 24 --output "$BUILD/dex" "$BUILD/classes.jar"
fi

echo "== 4/7 resources + manifest (aapt2) =="
"$AAPT2" compile --dir "$AND/app/src/main/res" -o "$BUILD/res.zip"
"$AAPT2" link -o "$BUILD/base.apk" \
  -I "$ANDROID_JAR" \
  --manifest "$AND/app/src/main/AndroidManifest.xml" \
  -R "$BUILD/res.zip" \
  -A "$BUILD/assets" \
  --min-sdk-version 24 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  --auto-add-overlay

echo "== 5/7 add classes.dex =="
python3 - "$BUILD/base.apk" "$BUILD/dex/classes.dex" <<'PY'
import sys, zipfile, shutil, os
base, dex = sys.argv[1], sys.argv[2]
out = base + ".tmp"
with zipfile.ZipFile(base) as zin, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        data = zin.read(item.filename)
        if item.filename == "classes.dex":
            continue
        zout.writestr(item, data)
    with open(dex, "rb") as f:
        zout.writestr("classes.dex", f.read(), compress_type=zipfile.ZIP_STORED)
shutil.move(out, base)
print("classes.dex added")
PY

echo "== 6/7 keystore =="
KS="$AND/ci/debug.keystore"
if [ ! -f "$KS" ]; then
  "$JAVA_HOME/bin/keytool" -genkeypair -v -keystore "$KS" -storepass android \
    -alias androiddebugkey -keypass android -keyalg RSA -keysize 2048 \
    -validity 10000 -dname "CN=CalledIt Debug,O=CalledIt,C=US" >/dev/null 2>&1 || \
  keytool -genkeypair -v -keystore "$KS" -storepass android \
    -alias androiddebugkey -keypass android -keyalg RSA -keysize 2048 \
    -validity 10000 -dname "CN=CalledIt Debug,O=CalledIt,C=US" >/dev/null 2>&1
fi

echo "== 7/7 sign =="
OUT="$DIST/CalledIt-$VERSION_NAME.apk"
if [ -n "${APKSIGNER_CMD:-}" ]; then
  $APKSIGNER_CMD sign --ks "$KS" --ks-pass pass:android --ks-key-alias androiddebugkey \
    --key-pass pass:android --out "$OUT" "$BUILD/base.apk"
elif command -v apksigner >/dev/null 2>&1; then
  apksigner sign --ks "$KS" --ks-pass pass:android --ks-key-alias androiddebugkey \
    --key-pass pass:android --out "$OUT" "$BUILD/base.apk"
else
  "$JAVA" -jar "$APKSIGNER" sign --ks "$KS" --ks-pass pass:android --ks-key-alias androiddebugkey \
    --key-pass pass:android --out "$OUT" "$BUILD/base.apk"
fi

echo "== check: bundled pages are where the app looks for them =="
python3 - "$OUT" <<'PY'
import sys, zipfile
names = set(zipfile.ZipFile(sys.argv[1]).namelist())
need = ["assets/www/index.html", "assets/www/trails.html", "assets/www/start.html", "assets/www/social.html",
        "assets/www/js/app.js", "assets/www/js/trails.js", "assets/www/js/config.js", "assets/www/css/styles.css",
        "assets/www/vendor/leaflet/leaflet.js", "classes.dex", "AndroidManifest.xml"]
missing = [n for n in need if n not in names]
if missing:
    sys.exit("APK is missing: " + ", ".join(missing))
print("assets OK (%d entries)" % len(names))
PY

echo "OK: $OUT"
