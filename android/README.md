# CalledIt — Android app (APK)

The APK is a thin native shell around the **same website** in this repository,
so every website fix ships in the app too (the web app is bundled into the APK
at build time by `copyWebAssets` / `ci/build-apk.sh`).

## What the shell adds over the website

| Fix | Where |
| --- | --- |
| Back gesture / back button walks page **and overlay** history (modals, assistant) instead of exiting the app | `onBackPressed()` + the site’s `history.pushState` overlays |
| After you allow location, if the device’s GPS is off it **prompts you to turn location on** (and can open the system settings) | `WebChromeClient.onGeolocationPermissionsShowPrompt` + `LocationManager` check |
| Profile photo upload works (system file picker) | `onShowFileChooser` |
| Directions links open the real map apps | `shouldOverrideUrlLoading` |
| Google Maps works with HTTP-referrer keys | bundled site served from `http://127.0.0.1:8765` (built-in `LocalServer`) — whitelist `http://localhost:8765/*` and `http://127.0.0.1:8765/*` on your Google key |

The app uses **only framework APIs** (no AndroidX, no external libraries), so it
builds with plain `javac`/Gradle and stays tiny.

## Get the APK

1. **GitHub Release** — `apk-latest` on the repo has a ready-to-install
   `CalledIt-<version>.apk` (signed with a debug key — install via
   “Install unknown apps” / `adb install`).
2. **GitHub Actions** — copy `ci/apk-workflow.yml` to
   `.github/workflows/apk.yml` and every push will build fresh APKs
   (the sandbox token that prepared this repo can’t create workflow files
   itself).
3. **Locally** — `android/ci/build-apk.sh` builds without Android Studio
   (needs `aapt2`, `d8`, `apksigner`, an `android.jar` and a JVM — or a normal
   `ANDROID_HOME`), and Android Studio can open the `android/` folder directly
   (Gradle, JDK 17, SDK 34):

   ```bash
   cd android && gradle assembleRelease
   # or, standalone toolchain:
   bash ci/build-apk.sh        # output: android/dist/CalledIt-<version>.apk
   ```

## App ids

* release: `com.calledit.app`
* debug (Android Studio): `com.calledit.app.debug`
