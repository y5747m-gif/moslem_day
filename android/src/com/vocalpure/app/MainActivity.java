package com.vocalpure.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
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

import java.io.File;
import java.io.FileOutputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * VocalPure — host for the standalone VocalPure player app.
 *
 * The app UI + player engine + adaptive vocal-isolation engine ship inside
 * the APK under assets/www and run 100% offline. A small JS bridge exposes
 * the app identity (version) and a chunked base64 file writer used by the
 * WAV export (files land in Android/data/com.vocalpure.app/files/Music).
 */
public class MainActivity extends Activity {

    private static final int FILE_CHOOSER_CODE = 41001;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#0b0b0e"));
        getWindow().setNavigationBarColor(Color.parseColor("#0b0b0e"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0b0b0e"));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
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
                // The player supports a full library: let users pick many songs at once.
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

    /** Exposes app identity + the WAV-export file writer to the bundled page. */
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
