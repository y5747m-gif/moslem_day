package com.vocalpure.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.PowerManager;
import android.util.Base64;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.io.FileOutputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * VocalPure — native shell of the standalone Android music player.
 *
 * The player UI + audio engine ship inside the APK under assets/www and
 * run 100% offline. This activity makes them behave like a regular
 * Android app:
 *
 *  - Material-style system bars that follow the in-app theme
 *    ({@link AppBridge#setSystemBars})
 *  - hardware/gesture BACK is routed to the app first (closes the player,
 *    sheets, menus, goes back to the Library); on the Library it sends the
 *    app to the background instead of killing it, so music keeps playing
 *  - playback survives screen-off / app switching: while the app reports
 *    it is playing, the WebView is not paused and a partial wake lock is
 *    held ({@link AppBridge#setPlaying})
 *  - the system file picker for importing songs, and a chunked file writer
 *    for WAV exports (Android/data/com.vocalpure.app/files/Music)
 *  - no web-page behaviours: no long-press text selection, no zoom, no
 *    text auto-scaling, no browser dialogs.
 */
public class MainActivity extends Activity {

    private static final int FILE_CHOOSER_CODE = 41001;
    private static final String LIGHT_SURFACE = "#f8faf5";
    private static final String LIGHT_NAV = "#ecefe9";

    // View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR (API 23) / _LIGHT_NAVIGATION_BAR (API 26)
    private static final int FLAG_LIGHT_STATUS = 0x00002000;
    private static final int FLAG_LIGHT_NAV = 0x00000010;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private volatile boolean playing = false;
    private PowerManager.WakeLock wakeLock;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applySystemBars(LIGHT_SURFACE, LIGHT_NAV, true);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor(LIGHT_SURFACE));
        // A real app never shows the web long-press selection handles.
        web.setLongClickable(false);
        web.setHapticFeedbackEnabled(false);
        web.setOnLongClickListener(new View.OnLongClickListener() {
            @Override
            public boolean onLongClick(View v) { return true; }
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        // The app is our own bundled content; it needs fetch()/XHR access to
        // its asset files (app-info.json) from the file:// origin.
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        // Playback should keep working when re-entering the app.
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        // Fixed text scale keeps the Material layout intact.
        s.setTextZoom(100);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                // Replace the splash window background once the UI is up.
                getWindow().setBackgroundDrawable(new ColorDrawable(Color.parseColor(LIGHT_SURFACE)));
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("audio/*");
                // The player supports a full library: let users pick many songs at once.
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(
                            Intent.createChooser(intent, "Select songs"), FILE_CHOOSER_CODE);
                } catch (Exception e) {
                    fileCallback.onReceiveValue(null);
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        web.addJavascriptInterface(new AppBridge(), "VocalPureAndroid");
        setContentView(web);
        web.loadUrl("file:///android_asset/www/index.html");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_CODE) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null && data.getClipData().getItemCount() > 0) {
                    int n = data.getClipData().getItemCount();
                    result = new Uri[n];
                    for (int i = 0; i < n; i++) {
                        result[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    result = new Uri[]{ data.getData() };
                }
            }
            if (fileCallback != null) {
                fileCallback.onReceiveValue(result);
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /**
     * BACK goes to the app first (close player / sheet / menu / go to the
     * Library). When nothing is left to close, the app is sent to the
     * background — like every music player — instead of being destroyed.
     */
    @Override
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript(
                "(function(){try{return !!(window.VocalPureApp&&window.VocalPureApp.onBack())}catch(e){return false}})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (!"true".equals(value)) {
                            if (!moveTaskToBack(true)) {
                                finish();
                            }
                        }
                    }
                });
    }

    @Override
    protected void onPause() {
        // Keep the audio engine running in the background while playing.
        if (web != null && !playing) web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        releaseWakeLock();
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    private void applySystemBars(String statusHex, String navHex, boolean lightTheme) {
        try {
            getWindow().setStatusBarColor(Color.parseColor(statusHex));
            getWindow().setNavigationBarColor(Color.parseColor(navHex));
            View decor = getWindow().getDecorView();
            int flags = decor.getSystemUiVisibility();
            if (lightTheme) flags |= FLAG_LIGHT_STATUS | FLAG_LIGHT_NAV;
            else flags &= ~(FLAG_LIGHT_STATUS | FLAG_LIGHT_NAV);
            decor.setSystemUiVisibility(flags);
        } catch (Exception ignored) {
        }
    }

    @SuppressLint("WakelockTimeout")
    private void acquireWakeLock() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm == null) return;
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "VocalPure:playback");
                wakeLock.setReferenceCounted(false);
            }
            if (!wakeLock.isHeld()) wakeLock.acquire();
        } catch (Exception ignored) {
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) {
        }
    }

    /** Exposes app identity, system-bar theming, playback state and the WAV writer to the page. */
    private class AppBridge {

        @JavascriptInterface
        public String appInfo() {
            String versionName = "unknown";
            int versionCode = 0;
            try {
                PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
                versionName = pi.versionName;
                versionCode = pi.versionCode;
            } catch (Exception ignored) {
            }
            return "{\"inApp\":true,\"versionName\":\"" + versionName
                    + "\",\"versionCode\":" + versionCode + "}";
        }

        /** Status/navigation bar colors + icon brightness follow the in-app theme. */
        @JavascriptInterface
        public void setSystemBars(final String statusHex, final String navHex, final boolean lightTheme) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    applySystemBars(statusHex, navHex, lightTheme);
                    if (web != null) {
                        try { web.setBackgroundColor(Color.parseColor(statusHex)); } catch (Exception ignored) { }
                        getWindow().setBackgroundDrawable(new ColorDrawable(Color.parseColor(statusHex)));
                    }
                }
            });
        }

        /** Called by the player on every play/pause so the shell can keep the engine alive. */
        @JavascriptInterface
        public void setPlaying(final boolean isPlaying) {
            playing = isPlaying;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (isPlaying) {
                        acquireWakeLock();
                        if (web != null) web.onResume();
                    } else {
                        releaseWakeLock();
                    }
                }
            });
        }

        /**
         * Chunked base64 file writer for WAV exports. The JS side streams
         * ~1.5 MB base64 chunks; the native side appends them to a file in
         * the app's external Music dir (no permissions needed).
         *
         * @return "ok" while streaming, "ok:<absolute path>" on the final
         *         chunk, "error:<message>" on failure.
         */
        @JavascriptInterface
        public String writeFile(final String name, String base64Chunk, final boolean finalChunk) {
            synchronized (openWrites) {
                try {
                    String safe = sanitize(name);
                    File dir = getExternalFilesDir(Environment.DIRECTORY_MUSIC);
                    if (dir == null) dir = getFilesDir();
                    if (!dir.exists() && !dir.mkdirs()) {
                        return "error:could not create directory";
                    }
                    final File target = new File(dir, safe);
                    FileOutputStream fos = openWrites.get(safe);
                    if (fos == null) {
                        fos = new FileOutputStream(target);
                        openWrites.put(safe, fos);
                    }
                    if (base64Chunk != null && !base64Chunk.isEmpty()) {
                        fos.write(Base64.decode(base64Chunk, Base64.DEFAULT));
                    }
                    if (finalChunk) {
                        fos.close();
                        openWrites.remove(safe);
                        return "ok:" + target.getAbsolutePath();
                    }
                    return "ok";
                } catch (Exception e) {
                    return "error:" + (e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName());
                }
            }
        }

        private String sanitize(String name) {
            if (name == null) return "vocalpure-export.wav";
            String s = name.trim().replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_");
            if (s.length() > 180) s = s.substring(0, 180);
            if (s.isEmpty()) s = "vocalpure-export.wav";
            return s;
        }
    }

    /** Files currently being streamed from the JS bridge. */
    private static final Map<String, FileOutputStream> openWrites = new HashMap<String, FileOutputStream>();
}
