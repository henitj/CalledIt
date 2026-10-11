# Keep the JS interface and NanoHTTPD
-keepclassmembers class com.calledit.app.MainActivity$CalledItAndroid {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class fi.iki.elonen.** { *; }
