package com.calledit.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.content.ActivityNotFoundException;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.provider.Settings;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.IOException;
import java.io.InputStream;

/**
 * CalledIt Android app (framework-only WebView shell, no AndroidX).
 *
 * The bundled website is served from a tiny HTTP server on
 * http://127.0.0.1:8765 so it has a real web origin: Google Maps keys work,
 * localStorage persists, and Puter.js (the free Grok AI) can sign in.
 *
 * v1.2 fixes:
 *  - BACK GESTURE: the manifest no longer opts into OnBackInvokedCallback.
 *    With that flag on, Android 13+ never calls onBackPressed(), so the back
 *    gesture closed the app. Now back walks page/overlay history first.
 *  - AI SIGN-IN: Puter's one-time sign-in uses window.open(); WebViews block
 *    popups by default. Popups are now supported: Puter's window opens in an
 *    in-app sheet (with a close button + back support) and hands the token
 *    back to the page via window.opener. Other target=_blank links open in
 *    the browser / maps app as before.
 *  - LOCATION: one native "Turn on location" prompt (no stacked dialogs) and,
 *    when you come back from Settings with location on, the page continues
 *    automatically (Near me / Track hike).
 *  - Local server (LocalServer.java): one thread per connection with
 *    timeouts and full header reads (a stalled preconnect socket can no
 *    longer freeze the app).
 */
public class MainActivity extends Activity {

    private static final String TAG = "CalledIt";
    private static final int PORT = 8765;
    private static final int REQ_GEO = 1001;
    private static final int REQ_FILE = 1002;

    private WebView webView;
    private LocalServer localServer;
    private ValueCallback<Uri[]> filePathCallback;
    private String pendingGeoOrigin;
    private GeolocationPermissions.Callback pendingGeoCallback;

    private Dialog popupDialog;
    private WebView popupView;
    private AlertDialog locationDialog;
    private boolean notifyLocationOnResume = false;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setSupportMultipleWindows(true);                 // Puter sign-in window
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setTextZoom(100);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new CalledItAndroid(), "CalledItAndroid");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request == null || request.getUrl() == null) return false;
                if (!request.isForMainFrame()) return false;          // iframes load normally
                Uri url = request.getUrl();
                String scheme = url.getScheme() == null ? "" : url.getScheme();
                if (scheme.equals("about") || scheme.equals("data") || scheme.equals("blob")
                        || scheme.equals("javascript")) return false;
                String host = url.getHost() == null ? "" : url.getHost();
                if (host.equals("127.0.0.1") || host.equals("localhost")) {
                    return false; // our bundled app
                }
                openExternal(url.toString());
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin,
                                                           GeolocationPermissions.Callback callback) {
                if (hasLocationPermission()) {
                    callback.invoke(origin, true, false);
                    ensureLocationServicesEnabled();
                } else {
                    pendingGeoCallback = callback;
                    pendingGeoOrigin = origin;
                    requestPermissions(new String[]{
                            Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION
                    }, REQ_GEO);
                }
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture,
                                          Message resultMsg) {
                WebView popup = createPopupWebView();
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(popup);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view,
                                             ValueCallback<Uri[]> filePathCallback,
                                             FileChooserParams fileChooserParams) {
                if (MainActivity.this.filePathCallback != null) {
                    MainActivity.this.filePathCallback.onReceiveValue(null);
                }
                MainActivity.this.filePathCallback = filePathCallback;
                Intent intent = fileChooserParams != null
                        ? fileChooserParams.createIntent()
                        : new Intent(Intent.ACTION_GET_CONTENT);
                if (intent.getAction() == null || intent.getAction().isEmpty()) {
                    intent.setAction(Intent.ACTION_GET_CONTENT);
                }
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                if (intent.getType() == null || intent.getType().isEmpty()) {
                    intent.setType("image/*");
                }
                try {
                    startActivityForResult(intent, REQ_FILE);
                    return true;
                } catch (ActivityNotFoundException e) {
                    MainActivity.this.filePathCallback = null;
                    return false;
                }
            }
        });

        try {
            localServer = new LocalServer(PORT, new LocalServer.AssetSource() {
                @Override
                public InputStream open(String path) throws IOException {
                    return getAssets().open(path);
                }
            });
            localServer.start();
        } catch (Exception e) {
            Log.w(TAG, "Local server failed to start, loading assets directly", e);
            localServer = null;
        }
        String startUrl = localServer != null
                ? "http://127.0.0.1:" + PORT + "/index.html"
                : "file:///android_asset/www/index.html";
        webView.loadUrl(startUrl);
    }

    /* ======================= popup windows (Puter sign-in) ======================= */

    private static boolean isPuterHost(String host) {
        if (host == null) return false;
        host = host.toLowerCase();
        return host.equals("puter.com") || host.endsWith(".puter.com");
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView createPopupWebView() {
        final WebView popup = new WebView(this);
        WebSettings ps = popup.getSettings();
        ps.setJavaScriptEnabled(true);
        ps.setDomStorageEnabled(true);
        ps.setDatabaseEnabled(true);
        ps.setSupportMultipleWindows(false);   // nested window.open loads in place
        ps.setJavaScriptCanOpenWindowsAutomatically(true);
        ps.setLoadWithOverviewMode(true);
        ps.setUseWideViewPort(true);
        ps.setTextZoom(100);
        CookieManager.getInstance().setAcceptThirdPartyCookies(popup, true);
        popup.setWebViewClient(new PopupClient(popup));
        popup.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onCloseWindow(WebView window) {
                destroyPopup(window);            // Puter closes itself after sign-in
            }
        });
        return popup;
    }

    /** Decides on the popup's first real URL: Puter → in-app sheet; anything else → browser. */
    private class PopupClient extends WebViewClient {
        private final WebView popup;
        private boolean decided = false;

        PopupClient(WebView popup) {
            this.popup = popup;
        }

        private boolean route(String url) {
            if (url == null || url.length() == 0) return false;
            if (url.startsWith("about:") || url.startsWith("data:") || url.startsWith("blob:")
                    || url.startsWith("javascript:")) return false;
            Uri u = Uri.parse(url);
            if (isPuterHost(u.getHost())) {
                if (!decided) {
                    decided = true;
                    showPopupDialog(popup);
                }
                return false;                    // keep Puter pages in the sheet
            }
            if (!decided) {                      // a plain target=_blank link
                decided = true;
                openExternal(url);
                popup.post(new Runnable() {
                    @Override
                    public void run() {
                        destroyPopup(popup);
                    }
                });
                return true;
            }
            openExternal(url);                   // links leaving Puter → browser
            return true;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (request == null || request.getUrl() == null) return false;
            if (!request.isForMainFrame()) return false;
            return route(request.getUrl().toString());
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            super.onPageStarted(view, url, favicon);
            if (!decided) route(url);            // the first load may skip shouldOverrideUrlLoading
        }
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private void showPopupDialog(final WebView popup) {
        if (isFinishing()) return;
        if (popupDialog != null && popupView != popup) destroyPopup(popupView);
        popupView = popup;

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(0xFF14532D);
        bar.setPadding(dp(14), dp(8), dp(6), dp(8));

        TextView title = new TextView(this);
        title.setText("Free Puter sign-in · powers the Grok AI");
        title.setTextColor(Color.WHITE);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setSingleLine(true);
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView close = new TextView(this);
        close.setText("\u2715");
        close.setTextColor(Color.WHITE);
        close.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        close.setGravity(Gravity.CENTER);
        close.setContentDescription("Close sign-in");
        close.setClickable(true);
        close.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                destroyPopup(popup);
            }
        });
        bar.addView(close, new LinearLayout.LayoutParams(dp(48), dp(48)));

        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));
        ViewParent parent = popup.getParent();
        if (parent instanceof ViewGroup) ((ViewGroup) parent).removeView(popup);
        root.addView(popup, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        Dialog d = new Dialog(this, android.R.style.Theme_Material_Light_NoActionBar) {
            @Override
            public void onBackPressed() {
                if (popup.canGoBack()) popup.goBack();
                else destroyPopup(popup);
            }
        };
        d.setContentView(root);
        d.setCancelable(true);
        d.setOnDismissListener(new DialogInterface.OnDismissListener() {
            @Override
            public void onDismiss(DialogInterface dialog) {
                destroyPopup(popup);
            }
        });
        Window w = d.getWindow();
        if (w != null) {
            w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
            w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        }
        popupDialog = d;
        d.show();
    }

    /** Idempotent: hides the sheet (if this popup owns it) and destroys the WebView. */
    private void destroyPopup(WebView popup) {
        if (popup == null) return;
        if ("destroyed".equals(popup.getTag())) return;
        popup.setTag("destroyed");
        if (popup == popupView) {
            popupView = null;
            Dialog d = popupDialog;
            popupDialog = null;
            if (d != null) {
                try {
                    if (d.isShowing()) d.dismiss();
                } catch (Exception ignored) {
                }
            }
        }
        try {
            ViewParent parent = popup.getParent();
            if (parent instanceof ViewGroup) ((ViewGroup) parent).removeView(popup);
            popup.stopLoading();
            popup.destroy();   // the opener now sees window.closed === true
        } catch (Exception e) {
            Log.w(TAG, "popup cleanup", e);
        }
    }

    private void openExternal(String url) {
        try {
            Intent intent;
            if (url.startsWith("intent:")) {
                intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
                intent.addCategory(Intent.CATEGORY_BROWSABLE);
                intent.setComponent(null);
                intent.setSelector(null);
            } else {
                intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            }
            startActivity(intent);
        } catch (Exception e) {
            Log.w(TAG, "No activity for " + url);
        }
    }

    /* ======================= location ======================= */

    private boolean hasLocationPermission() {
        int fine = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION);
        int coarse = checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION);
        return fine == PackageManager.PERMISSION_GRANTED || coarse == PackageManager.PERMISSION_GRANTED;
    }

    private boolean isLocationEnabled() {
        LocationManager lm = (LocationManager) getSystemService(LOCATION_SERVICE);
        if (lm == null) return false;
        if (Build.VERSION.SDK_INT >= 28) return lm.isLocationEnabled();
        try {
            return lm.isProviderEnabled(LocationManager.GPS_PROVIDER)
                    || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception e) {
            return false;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_GEO) {
            boolean granted = false;
            for (int r : grantResults) {
                if (r == PackageManager.PERMISSION_GRANTED) granted = true;
            }
            if (granted && pendingGeoCallback != null) {
                pendingGeoCallback.invoke(pendingGeoOrigin, true, false);
                ensureLocationServicesEnabled();
            } else if (pendingGeoCallback != null) {
                pendingGeoCallback.invoke(pendingGeoOrigin, false, false);
            }
            pendingGeoCallback = null;
            pendingGeoOrigin = null;
        }
    }

    /** Permission granted but the device's location switch is OFF → prompt once. */
    private void ensureLocationServicesEnabled() {
        if (!isLocationEnabled()) {
            notifyLocationOnResume = true;
            showLocationDialog();
        }
    }

    private void showLocationDialog() {
        if (isFinishing()) return;
        if (locationDialog != null && locationDialog.isShowing()) return;   // never stack prompts
        locationDialog = new AlertDialog.Builder(this)
                .setTitle("Turn on location")
                .setMessage("CalledIt is allowed to use your location, but your phone's location (GPS) "
                        + "is switched off. Turn it on to find trails near you and to track your hike.")
                .setPositiveButton("Turn on location", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        notifyLocationOnResume = true;
                        openLocationSettingsNow();
                    }
                })
                .setNegativeButton("Not now", null)
                .create();
        locationDialog.show();
    }

    private void openLocationSettingsNow() {
        try {
            startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS));
        } catch (ActivityNotFoundException e) {
            startActivity(new Intent(Settings.ACTION_SETTINGS));
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE) {
            Uri[] uris = null;
            if (resultCode == RESULT_OK && data != null) {
                Uri single = data.getData();
                if (data.getClipData() != null && data.getClipData().getItemCount() > 0) {
                    int n = data.getClipData().getItemCount();
                    uris = new Uri[n];
                    for (int i = 0; i < n; i++) {
                        uris[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (single != null) {
                    uris = new Uri[]{single};
                }
            }
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(uris);
                filePathCallback = null;
            }
        }
    }

    /* ======================= back + lifecycle ======================= */

    /* Back button / back gesture: close the sign-in sheet, then walk page and
       overlay history (the site pushes history entries for its sheets and
       modals); only exits from the very first page. Works on Android 13+
       because the manifest does NOT opt into OnBackInvokedCallback. */
    @Override
    public void onBackPressed() {
        if (popupView != null) {
            if (popupView.canGoBack()) popupView.goBack();
            else destroyPopup(popupView);
            return;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        if (notifyLocationOnResume && isLocationEnabled()) {
            notifyLocationOnResume = false;
            if (locationDialog != null && locationDialog.isShowing()) locationDialog.dismiss();
            if (webView != null) {
                webView.evaluateJavascript(
                        "window.CalledIt&&CalledIt.onNativeLocationOn&&CalledIt.onNativeLocationOn()", null);
            }
        }
    }

    @Override
    protected void onDestroy() {
        if (popupView != null) destroyPopup(popupView);
        if (localServer != null) {
            localServer.stopServer();
        }
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    /** Bridge exposed to the web app as window.CalledItAndroid. */
    class CalledItAndroid {
        /** Straight to the system location settings (the user already chose to). */
        @JavascriptInterface
        public void openLocationSettings() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    notifyLocationOnResume = true;
                    openLocationSettingsNow();
                }
            });
        }

        /** Shows the single native prompt if location is off; false = location is already on. */
        @JavascriptInterface
        public boolean promptEnableLocation() {
            if (isLocationEnabled()) return false;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    notifyLocationOnResume = true;
                    showLocationDialog();
                }
            });
            return true;
        }

        @JavascriptInterface
        public boolean isLocationOn() {
            return isLocationEnabled();
        }

        @JavascriptInterface
        public String appVersion() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "";
            }
        }
    }
}
