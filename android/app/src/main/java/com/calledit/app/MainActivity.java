package com.calledit.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.util.Log;
import android.view.KeyEvent;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.util.HashMap;
import java.util.Map;

/**
 * CalledIt Android app.
 *
 * Serves the bundled website from a tiny localhost HTTP server so that
 * HTTP-referrer-restricted API keys (Google Maps etc.) can whitelist
 * `http://localhost:8765/*` and `http://127.0.0.1:8765/*`.
 *
 * Bug fixes vs. a naive WebView wrapper:
 *  - back gesture / back button goes back through page & overlay history
 *    (the site pushes history entries for modals) instead of exiting the app
 *  - after location permission is granted, if the device's location (GPS)
 *    switch is OFF the user is prompted and taken to the system settings
 *  - file chooser support so profile photo upload works
 *  - external map/directions links open in the real map apps
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
        s.setSupportMultipleWindows(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setTextZoom(100);

        webView.addJavascriptInterface(new CalledItAndroid(), "CalledItAndroid");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request == null || request.getUrl() == null) return false;
                Uri url = request.getUrl();
                String host = url.getHost() == null ? "" : url.getHost();
                String scheme = url.getScheme() == null ? "http" : url.getScheme();
                if (host.equals("127.0.0.1") || host.equals("localhost")) {
                    return false; // our bundled app
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url.toString())));
                } catch (ActivityNotFoundException e) {
                    Log.w(TAG, "No activity for " + url);
                }
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
            localServer = new LocalServer(PORT);
            localServer.start();
        } catch (Exception e) {
            Log.w(TAG, "Local server failed to start, loading assets directly", e);
        }
        String startUrl = localServer != null
                ? "http://127.0.0.1:" + PORT + "/index.html"
                : "file:///android_asset/www/index.html";
        webView.loadUrl(startUrl);
    }

    private boolean hasLocationPermission() {
        int fine = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION);
        int coarse = checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION);
        return fine == PackageManager.PERMISSION_GRANTED || coarse == PackageManager.PERMISSION_GRANTED;
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

    /** If device location (GPS) is off, prompt the user to turn it on. */
    private void ensureLocationServicesEnabled() {
        LocationManager lm = (LocationManager) getSystemService(LOCATION_SERVICE);
        boolean enabled = lm != null && (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)
                || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER));
        if (!enabled) {
            new AlertDialog.Builder(this)
                    .setTitle("Turn on location")
                    .setMessage("CalledIt needs your location to find trails near you and to track "
                            + "your hike. Make sure device location (GPS) is turned on.")
                    .setPositiveButton("Open location settings", new android.content.DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(android.content.DialogInterface dialog, int which) {
                            openLocationSettingsNow();
                        }
                    })
                    .setNegativeButton("Not now", null)
                    .show();
        }
    }

    private void openLocationSettingsNow() {
        try {
            startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS));
        } catch (ActivityNotFoundException e) {
            startActivity(new Intent(Settings.ACTION_SETTINGS));
        }
    }

    /* Back button / back gesture: walk history (closes overlays first thanks
       to the site's history API), never an instant exit from a sub-page. */
    @Override
    public void onBackPressed() {
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
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (localServer != null) {
            try {
                localServer.stop();
            } catch (Exception ignored) {
            }
        }
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    /** Bridge exposed to the web app as window.CalledItAndroid. */
    class CalledItAndroid {
        @JavascriptInterface
        public void openLocationSettings() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    ensureLocationServicesEnabled();
                }
            });
        }
    }

    /** Tiny HTTP server for the bundled web app (assets/www). */
    class LocalServer extends Thread {
        private final ServerSocket serverSocket;
        private volatile boolean running = true;

        LocalServer(int port) throws IOException {
            serverSocket = new ServerSocket();
            serverSocket.setReuseAddress(true);
            serverSocket.bind(new InetSocketAddress("127.0.0.1", port));
            setDaemon(true);
        }

        void stopServer() {
            running = false;
            try {
                serverSocket.close();
            } catch (IOException ignored) {
            }
        }

        @Override
        public void run() {
            while (running) {
                try {
                    final Socket socket = serverSocket.accept();
                    handle(socket);
                } catch (SocketException e) {
                    break;
                } catch (IOException e) {
                    Log.w(TAG, "Local server accept failed", e);
                }
            }
        }

        private void handle(Socket socket) {
            InputStream in = null;
            try {
                in = socket.getInputStream();
                // read request line (we only need the path)
                StringBuilder req = new StringBuilder();
                int c;
                while ((c = in.read()) != -1 && c != '\n') {
                    if (req.length() < 2048) req.append((char) c);
                }
                String line = req.toString();
                String path = "/";
                String[] parts = line.split(" ");
                if (parts.length > 1) path = parts[1];

                byte[] body;
                String status = "HTTP/1.0 200 OK";
                String mime = "application/octet-stream";
                int q = path.indexOf('?');
                if (q >= 0) path = path.substring(0, q);
                if (path.equals("/") || path.isEmpty()) path = "/index.html";
                if (path.contains("..")) {
                    status = "HTTP/1.0 403 Forbidden";
                    body = "Forbidden".getBytes("UTF-8");
                    mime = "text/plain";
                } else {
                    InputStream asset;
                    try {
                        asset = getAssets().open("www" + path);
                    } catch (IOException e) {
                        asset = null;
                    }
                    if (asset == null) {
                        status = "HTTP/1.0 404 Not Found";
                        body = "Not found".getBytes("UTF-8");
                        mime = "text/plain";
                    } else {
                        body = readAll(asset);
                        mime = mimeFor(path);
                    }
                }

                OutputStream out = socket.getOutputStream();
                String head = status + "\r\nContent-Type: " + mime
                        + "\r\nContent-Length: " + body.length
                        + "\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
                out.write(head.getBytes("UTF-8"));
                out.write(body);
                out.flush();
            } catch (IOException e) {
                Log.w(TAG, "Local server request failed", e);
            } finally {
                try {
                    if (in != null) in.close();
                    socket.close();
                } catch (IOException ignored) {
                }
            }
        }

        private byte[] readAll(InputStream in) throws IOException {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        }

        private String mimeFor(String path) {
            int dot = path.lastIndexOf('.');
            String ext = dot >= 0 ? path.substring(dot + 1).toLowerCase() : "";
            if (ext.equals("html")) return "text/html; charset=utf-8";
            if (ext.equals("js")) return "text/javascript; charset=utf-8";
            if (ext.equals("css")) return "text/css; charset=utf-8";
            if (ext.equals("json") || ext.equals("webmanifest")) return "application/json";
            if (ext.equals("png")) return "image/png";
            if (ext.equals("jpg") || ext.equals("jpeg")) return "image/jpeg";
            if (ext.equals("svg")) return "image/svg+xml";
            if (ext.equals("ico")) return "image/x-icon";
            return "application/octet-stream";
        }
    }
}
