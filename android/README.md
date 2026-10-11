# CalledIt — Android app (APK)

The APK is a thin native shell around the **same website** in this repository,
so every website fix ships in the app too (the web app is bundled into the APK
at build time by `copyWebAssets` / `ci/build-apk.sh`).

## What the shell adds over the website

| Fix | Where |
| --- | --- |
| Back gesture / back button walks page **and overlay** history (modals, assistant, sign-in sheet) instead of exiting the app — on Android 13+ too | `onBackPressed()` + the site’s `history.pushState` overlays; the manifest deliberately does **not** set `android:enableOnBackInvokedCallback="true"` (with it, Android 13+ never calls `onBackPressed()`) |
| Grok AI (Puter.js) sign-in works | `setSupportMultipleWindows(true)` + `onCreateWindow`: a `puter.com` window opens in an in-app sheet (✕ / back closes it) linked to `window.opener`, so the token comes back to the page; other `target=_blank` links go to the browser / map apps |
| After you allow location, if the device’s GPS is off it **prompts once** to turn location on, and the page **continues automatically** when you come back with it on | `onGeolocationPermissionsShowPrompt` + `LocationManager`; `onResume` → `CalledIt.onNativeLocationOn()`; JS bridge `CalledItAndroid.promptEnableLocation()` |
| Profile photo upload works (system file picker) | `onShowFileChooser` |
| Real web origin for Google Maps keys, Puter sign-in and localStorage | bundled site served from `http://127.0.0.1:8765` by `LocalServer.java` (thread per connection, timeouts, full header reads, GET/HEAD) |

The app uses **only framework APIs** (no AndroidX, no external libraries), so it
builds with plain `javac`/Gradle and stays tiny.

## Get the APK

1. **In this repo** — [`android/dist/CalledIt-1.2.1.apk`](dist/CalledIt-1.2.1.apk)
   (signed with the project's debug key; install via “Install unknown apps” or
   `adb install -r`). It upgrades earlier CalledIt builds in place.
   *The old 1.1.0 file was removed: it packaged the web pages in the wrong
   assets folder and opened to “Not found”.*
   Tested with `node test/browser/apk-check.mjs`: the APK's bundled files are
   compared with the repo, served by the app's own `LocalServer` on
   `http://127.0.0.1:8765` (via `ci/ServeAssets.java`) and driven in Chromium as
   an Android WebView with the `CalledItAndroid` bridge.
2. **GitHub Actions** — copy `ci/apk-workflow.yml` to
   `.github/workflows/apk.yml` and every push will build fresh APKs
   (the sandbox token that prepared this repo can’t create workflow files
   itself).
3. **Locally** — `android/ci/build-apk.sh` builds without Android Studio
   (needs `aapt2`, `d8`, `apksigner`, an `android.jar` and a JVM — or a normal
   `ANDROID_HOME`; `VERSION_NAME` / `VERSION_CODE` env vars override 1.2.1 / 4),
   and Android Studio can open the `android/` folder directly (Gradle, JDK 17,
   SDK 34):

   ```bash
   cd android && gradle assembleRelease
   # or, standalone toolchain:
   bash ci/build-apk.sh        # output: android/dist/CalledIt-<version>.apk
   ```

   The script ends with a check that the pages sit in `assets/www/` where the
   app serves them from.

## Tests

```bash
# LocalServer on a desktop JVM (no Android needed)
javac -source 1.7 -target 1.7 -d /tmp/ls app/src/main/java/com/calledit/app/LocalServer.java ci/LocalServerTest.java
java -cp /tmp/ls com.calledit.app.LocalServerTest ..
```

## App ids

* release: `com.calledit.app`
* debug (Android Studio): `com.calledit.app.debug`
