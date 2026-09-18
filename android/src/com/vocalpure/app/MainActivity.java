package com.vocalpure.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/**
 * VocalPure — WebView host for the bundled standalone music player.
 *
 * The app UI (assets/www, synced from /app in the repo) is a complete
 * music player: library, playlists, favorites, queue, EQ, sleep timer
 * and the live two-stem vocal/music isolation engine. It runs 100%
 * offline and shares no code with the marketing/download website.
 *
 * The JS bridge (window.VocalPureAndroid) exposes:
 *   appInfo()                 — in-app identity + version name
 *   setKeepScreenOn(boolean)  — screen-on while playing
 *   saveFileBegin/Chunk/End() — chunked base64 writer used for WAV
 *                               exports, saved to app-visible Music
 *                               storage (no permissions required)
 */
public class MainActivity extends Activity {

    private static final int FILE_CHOOSER_CODE = 41001;
    private static final int SAVE_CHUNK_MAX = 2 * 1024 * 1024; // 2 MB of raw bytes per call

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    /** accumulator for the chunked export writer */
    private String saveName;
    private ByteArrayOutputStream saveBuffer;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#0B0D10"));
        getWindow().setNavigationBarColor(Color.parseColor("#0B0D10"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0B0D10"));
        web.setKeepScreenOn(false);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        // The bundled app reads its own asset files from the file:// origin.
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        // Playback should be able to start/continue without a user gesture.
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);

        web.setWebViewClient(new WebViewClient());
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
                // Full library: users pick many songs at once.
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                startActivityForResult(
                        Intent.createChooser(intent, "Select songs"), FILE_CHOOSER_CODE);
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

    @Override
    public void onBackPressed() {
        // The app UI drives history via location.hash, so overlays/screens
        // close one by one before the activity finishes.
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /** JS bridge — see class comment. */
    private class AppBridge {

        @JavascriptInterface
        public String appInfo() {
            String versionName = "unknown";
            try {
                versionName = getPackageManager()
                        .getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception ignored) {
            }
            return "{\"inApp\":true,\"versionName\":\"" + versionName + "\"}";
        }

        @JavascriptInterface
        public void setKeepScreenOn(final boolean on) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (web != null) web.setKeepScreenOn(on);
                }
            });
        }

        @JavascriptInterface
        public void saveFileBegin(String name) {
            saveName = sanitize(name);
            saveBuffer = new ByteArrayOutputStream(64 * 1024);
        }

        @JavascriptInterface
        public boolean saveFileChunk(String base64) {
            if (saveBuffer == null || base64 == null) return false;
            try {
                byte[] chunk = Base64.decode(base64, Base64.NO_WRAP);
                if (chunk.length > SAVE_CHUNK_MAX) return false;
                saveBuffer.write(chunk);
                return true;
            } catch (IllegalArgumentException e) {
                return false;
            } catch (IOException e) {
                return false;
            }
        }

        /** Finishes the write; returns the absolute path, or "" on failure. */
        @JavascriptInterface
        public String saveFileEnd() {
            if (saveBuffer == null || saveName == null) return "";
            try {
                File dir = getExternalFilesDir(Environment.DIRECTORY_MUSIC);
                if (dir == null) dir = getFilesDir();
                if (!dir.exists() && !dir.mkdirs()) return "";
                File out = new File(dir, saveName);
                FileOutputStream fos = new FileOutputStream(out);
                try {
                    saveBuffer.writeTo(fos);
                } finally {
                    try { fos.close(); } catch (IOException ignored) { }
                }
                return out.getAbsolutePath();
            } catch (Exception e) {
                return "";
            } finally {
                saveName = null;
                saveBuffer = null;
            }
        }

        private String sanitize(String name) {
            String s = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|]+", "_").trim();
            if (s.length() == 0) s = "export.wav";
            if (s.length() > 90) s = s.substring(s.length() - 90);
            return s;
        }
    }
}
