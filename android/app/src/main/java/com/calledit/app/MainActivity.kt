package com.calledit.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import fi.iki.elonen.NanoHTTPD
import java.io.ByteArrayInputStream

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
class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "CalledIt"
        private const val PORT = 8765
    }

    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var localServer: AssetServer? = null

    private val fileChooserLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val uris: Array<Uri>? = when {
                result.resultCode != RESULT_OK -> null
                result.data == null -> null
                else -> {
                    val single = result.data!!.data
                    val clip = result.data!!.clipData
                    when {
                        clip != null -> Array(clip.itemCount) { clip.getItemAt(it).uri }
                        single != null -> arrayOf(single)
                        else -> null
                    }
                }
            }
            filePathCallback?.onReceiveValue(uris)
            filePathCallback = null
        }

    private val locationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            val fine = grants[Manifest.permission.ACCESS_FINE_LOCATION] == true
            val coarse = grants[Manifest.permission.ACCESS_COARSE_LOCATION] == true
            if (fine || coarse) {
                ensureLocationServicesEnabled()
            }
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)

        val s = webView.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.databaseEnabled = true
        s.setGeolocationEnabled(true)
        s.cacheMode = WebSettings.LOAD_DEFAULT
        s.mediaPlaybackRequiresUserGesture = true
        s.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        s.allowFileAccess = false
        s.allowContentAccess = true
        s.setSupportMultipleWindows(false)
        s.loadWithOverviewMode = true
        s.useWideViewPort = true
        s.textZoom = 100

        webView.addJavascriptInterface(CalledItAndroid(), "CalledItAndroid")
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url ?: return false
                val host = url.host ?: ""
                val scheme = url.scheme ?: "http"
                /* localhost = our bundled app; map links = real map apps */
                return when {
                    host == "127.0.0.1" || host == "localhost" -> false
                    scheme == "http" || scheme == "https" -> {
                        try {
                            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url.toString())))
                        } catch (e: ActivityNotFoundException) {
                            /* no browser — ignore */
                        }
                        true
                    }
                    else -> {
                        try {
                            startActivity(Intent(Intent.ACTION_VIEW, url))
                            true
                        } catch (e: ActivityNotFoundException) {
                            false
                        }
                    }
                }
            }
        }
        webView.webChromeClient = object : WebChromeClient() {

            /* ---- geolocation: permission + “turn location on” prompt ---- */
            override fun onGeolocationPermissionsShowPrompt(
                origin: String?,
                callback: GeolocationPermissions.Callback?
            ) {
                val fine = ContextCompat.checkSelfPermission(
                    this@MainActivity, Manifest.permission.ACCESS_FINE_LOCATION
                ) == PackageManager.PERMISSION_GRANTED
                val coarse = ContextCompat.checkSelfPermission(
                    this@MainActivity, Manifest.permission.ACCESS_COARSE_LOCATION
                ) == PackageManager.PERMISSION_GRANTED
                if (fine || coarse) {
                    callback?.invoke(origin, true, false)
                    ensureLocationServicesEnabled()
                } else {
                    pendingGeoCallback = callback
                    pendingGeoOrigin = origin
                    locationPermissionLauncher.launch(
                        arrayOf(
                            Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION
                        )
                    )
                }
            }

            /* ---- file chooser (profile photo upload) ---- */
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                this@MainActivity.filePathCallback?.onReceiveValue(null)
                this@MainActivity.filePathCallback = filePathCallback
                val intent = (fileChooserParams?.createIntent()
                    ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "image/*"
                    })
                return try {
                    fileChooserLauncher.launch(intent)
                    true
                } catch (e: ActivityNotFoundException) {
                    this@MainActivity.filePathCallback = null
                    false
                }
            }
        }

        /* ---- back gesture / back button: walk history (closes overlays
               first thanks to the site's history API), never instant-exit ---- */
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        /* ---- start the localhost server with the bundled site ---- */
        try {
            localServer = AssetServer(this, PORT).also { it.start() }
        } catch (e: Exception) {
            Log.w(TAG, "Local server failed to start, loading assets directly", e)
        }
        val startUrl = localServer?.let { "http://127.0.0.1:$PORT/index.html" }
            ?: "file:///android_asset/www/index.html"
        webView.loadUrl(startUrl)
    }

    private var pendingGeoCallback: GeolocationPermissions.Callback? = null
    private var pendingGeoOrigin: String? = null

    private fun ensureLocationServicesEnabled() {
        val lm = getSystemService(LOCATION_SERVICE) as LocationManager
        val enabled = lm.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
            lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
        if (!enabled) {
            AlertDialog.Builder(this)
                .setTitle("Turn on location")
                .setMessage(R.string.location_rationale)
                .setPositiveButton("Open location settings") { _, _ ->
                    try {
                        startActivity(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS))
                    } catch (e: ActivityNotFoundException) {
                        startActivity(Intent(Settings.ACTION_SETTINGS))
                    }
                }
                .setNegativeButton("Not now", null)
                .show()
        }
    }

    override fun onResume() {
        super.onResume()
        pendingGeoCallback?.let { cb ->
            cb.invoke(pendingGeoOrigin, true, false)
            ensureLocationServicesEnabled()
        }
        pendingGeoCallback = null
    }

    override fun onPause() {
        super.onPause()
        webView.onPause()
    }

    override fun onDestroy() {
        try {
            localServer?.stop()
        } catch (e: Exception) {
            /* ignore */
        }
        webView.destroy()
        super.onDestroy()
    }

    /** Bridge exposed to the web app as window.CalledItAndroid. */
    inner class CalledItAndroid {
        @JavascriptInterface
        fun openLocationSettings() {
            runOnUiThread { ensureLocationServicesEnabled() }
        }
    }

    /** Tiny HTTP server for the bundled web app (assets/www). */
    class AssetServer(private val activity: MainActivity, port: Int) : NanoHTTPD("127.0.0.1", port) {

        private val mime = mapOf(
            "html" to "text/html; charset=utf-8",
            "js" to "text/javascript; charset=utf-8",
            "css" to "text/css; charset=utf-8",
            "json" to "application/json",
            "webmanifest" to "application/manifest+json",
            "png" to "image/png",
            "jpg" to "image/jpeg",
            "jpeg" to "image/jpeg",
            "svg" to "image/svg+xml",
            "ico" to "image/x-icon",
            "woff2" to "font/woff2"
        )

        override fun serve(session: IHTTPSession): Response {
            var path = session.uri.trimStart('/')
            if (path.isEmpty()) path = "index.html"
            if (path.contains("..")) {
                return newFixedLengthResponse(Response.Status.FORBIDDEN, "text/plain", "no")
            }
            return try {
                val bytes = activity.assets.open("www/$path").readBytes()
                val ext = path.substringAfterLast('.', "")
                newFixedLengthResponse(
                    Response.Status.OK,
                    mime[ext] ?: "application/octet-stream",
                    ByteArrayInputStream(bytes),
                    bytes.size.toLong()
                ).apply {
                    addHeader("Cache-Control", "no-cache")
                }
            } catch (e: Exception) {
                newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "Not found")
            }
        }
    }
}
