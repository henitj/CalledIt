# Keep the JS bridge exposed to the web app
-keepclassmembers class com.calledit.app.MainActivity$CalledItAndroid {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.calledit.app.** { *; }
