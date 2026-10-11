# CalledIt — Android app (APK)

The APK is a thin native shell around the **same website** in this repository,
so every website fix ships in the app too (the web app is bundled into the APK
at build time).

## What the shell adds over the website

| Fix | Where |
| --- | --- |
| Back gesture / back button walks page **and overlay** history (modals, assistant) instead of exiting the app | `OnBackPressedCallback` + the site’s `history.pushState` overlays |
| After you allow location, if the device’s GPS is off it **prompts you to turn location on** (and can open the system settings) | `WebChromeClient.onGeolocationPermissionsShowPrompt` + `LocationManager` check |
| Profile photo upload works (system file picker) | `onShowFileChooser` |
| Directions links open the real map apps | `shouldOverrideUrlLoading` |
| Google Maps works with HTTP-referrer keys | bundled site served from `http://127.0.0.1:8765` (NanoHTTPD) — whitelist `http://localhost:8765/*` and `http://127.0.0.1:8765/*` on your Google key |

## Build the APK

**Option A — GitHub Actions (no Android Studio needed).** Every push runs
`.github/workflows/apk.yml` and uploads `calledit-apk` artifacts (debug + release)
on the run page. Pushes to `main` also attach the APKs to the `apk-latest`
GitHub release.

**Option B — locally.** Open the `android/` folder in Android Studio (Ladybug or
newer), or run:

```bash
cd android
gradle assembleDebug        # or assembleRelease
# APK: app/build/outputs/apk/debug/app-debug.apk
```

(Gradle 8.7 + JDK 17 + Android SDK 35. The web app is copied into
`app/build/generated/webassets/www` automatically by the `copyWebAssets` task.)

## App ids

* release: `com.calledit.app`
* debug: `com.calledit.app.debug`
