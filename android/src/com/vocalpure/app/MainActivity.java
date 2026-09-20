package com.vocalpure.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.URLDecoder;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * VocalPure — host for the standalone VocalPure player app.
 *
 * Supports offline vocal isolation playback, full audio permissions
 * (READ_MEDIA_AUDIO / READ_EXTERNAL_STORAGE), scanning all music files
 * across the device storage, native audio streaming into WebView via
 * shouldInterceptRequest, and WAV export.
 */
public class MainActivity extends Activity {

    private static final int FILE_CHOOSER_CODE = 41001;
    public static final int PERMISSION_REQ_CODE = 5001;

    public static final String PERMISSION_READ_MEDIA_AUDIO = "android.permission.READ_MEDIA_AUDIO";
    public static final String PERMISSION_READ_EXTERNAL_STORAGE = "android.permission.READ_EXTERNAL_STORAGE";
    public static final String PERMISSION_WRITE_EXTERNAL_STORAGE = "android.permission.WRITE_EXTERNAL_STORAGE";

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    public boolean hasAudioPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            return checkSelfPermission(PERMISSION_READ_MEDIA_AUDIO) == PackageManager.PERMISSION_GRANTED;
        } else if (Build.VERSION.SDK_INT >= 23) {
            return checkSelfPermission(PERMISSION_READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
        }
        return true;
    }

    public void requestAudioPermissions() {
        if (Build.VERSION.SDK_INT >= 23) {
            List<String> list = new ArrayList<String>();
            if (Build.VERSION.SDK_INT >= 33) {
                if (checkSelfPermission(PERMISSION_READ_MEDIA_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                    list.add(PERMISSION_READ_MEDIA_AUDIO);
                }
            } else {
                if (checkSelfPermission(PERMISSION_READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                    list.add(PERMISSION_READ_EXTERNAL_STORAGE);
                }
                if (Build.VERSION.SDK_INT <= 29 && checkSelfPermission(PERMISSION_WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                    list.add(PERMISSION_WRITE_EXTERNAL_STORAGE);
                }
            }
            if (!list.isEmpty()) {
                requestPermissions(list.toArray(new String[0]), PERMISSION_REQ_CODE);
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#070b12"));
        getWindow().setNavigationBarColor(Color.parseColor("#070b12"));

        // Ensure hardware volume controls adjust media stream
        setVolumeControlStream(AudioManager.STREAM_MUSIC);

        // Request audio focus for proper sound output
        try {
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (am != null) {
                am.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
            }
        } catch (Exception ignored) {
        }

        // Auto-request storage/music permissions on first launch if needed
        if (!hasAudioPermission()) {
            requestAudioPermissions();
        }

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#070b12"));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        // The app is our own bundled content; it needs fetch()/XHR access to
        // its asset files (app-info.json) and local audio files from the file:// origin.
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        // Playback should work without blocking user gestures
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (request != null && request.getUrl() != null) {
                    Uri reqUri = request.getUrl();
                    if ("vocalpure.local".equalsIgnoreCase(reqUri.getHost()) && "/audio".equals(reqUri.getPath())) {
                        String rawPath = reqUri.getQueryParameter("path");
                        if (rawPath != null && !rawPath.isEmpty()) {
                            try {
                                String path = URLDecoder.decode(rawPath, "UTF-8");
                                InputStream is = null;
                                long fileLen = -1;
                                if (path.startsWith("content://")) {
                                    Uri cu = Uri.parse(path);
                                    is = getContentResolver().openInputStream(cu);
                                } else {
                                    File f = new File(path);
                                    if (f.exists() && f.canRead()) {
                                        is = new FileInputStream(f);
                                        fileLen = f.length();
                                    }
                                }
                                if (is != null) {
                                    String lower = path.toLowerCase();
                                    String mime = "audio/mpeg";
                                    if (lower.endsWith(".wav")) mime = "audio/wav";
                                    else if (lower.endsWith(".ogg") || lower.endsWith(".oga")) mime = "audio/ogg";
                                    else if (lower.endsWith(".m4a") || lower.endsWith(".aac") || lower.endsWith(".mp4")) mime = "audio/mp4";
                                    else if (lower.endsWith(".flac")) mime = "audio/flac";
                                    else if (lower.endsWith(".opus")) mime = "audio/opus";

                                    Map<String, String> headers = new HashMap<String, String>();
                                    headers.put("Access-Control-Allow-Origin", "*");
                                    headers.put("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
                                    headers.put("Access-Control-Allow-Headers", "*");
                                    if (fileLen > 0) {
                                        headers.put("Content-Length", String.valueOf(fileLen));
                                    }
                                    headers.put("Accept-Ranges", "bytes");

                                    return new WebResourceResponse(mime, "UTF-8", 200, "OK", headers, is);
                                }
                            } catch (Exception ignored) {
                            }
                        }
                    }
                }
                return super.shouldInterceptRequest(view, request);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (!hasAudioPermission()) {
                    requestAudioPermissions();
                }
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
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == PERMISSION_REQ_CODE) {
            boolean granted = false;
            for (int r : grantResults) {
                if (r == PackageManager.PERMISSION_GRANTED) {
                    granted = true;
                    break;
                }
            }
            final boolean isGranted = granted;
            if (web != null) {
                web.post(new Runnable() {
                    @Override
                    public void run() {
                        web.evaluateJavascript(
                            "if (typeof window.onDevicePermissionResult === 'function') { window.onDevicePermissionResult(" + isGranted + "); }",
                            null
                        );
                    }
                });
            }
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
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
        // Keep webview alive during pause so audio keeps playing in background / screen-off
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

    /** Exposes app identity, permissions, device music scanning, and WAV export to the bundled page. */
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
                    + "\",\"versionCode\":" + versionCode
                    + ",\"hasPermission\":" + hasAudioPermission() + "}";
        }

        @JavascriptInterface
        public boolean hasStoragePermission() {
            return hasAudioPermission();
        }

        @JavascriptInterface
        public void requestStoragePermission() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    requestAudioPermissions();
                }
            });
        }

        @JavascriptInterface
        public void openAppSettings() {
            try {
                Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                intent.setData(Uri.parse("package:" + getPackageName()));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
            } catch (Exception ignored) {
            }
        }

        /**
         * Opens the update/download page in the system browser so users can
         * install new releases. Called by the in-app update checker.
         */
        @JavascriptInterface
        public void openUpdatePage(final String url) {
            try {
                String u = (url == null || url.trim().isEmpty())
                        ? "https://github.com/y5747m-gif/moslem_day"
                        : url.trim();
                if (!u.startsWith("http://") && !u.startsWith("https://")) {
                    u = "https://" + u;
                }
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(u));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
            } catch (Exception ignored) {
            }
        }

        /**
         * Scans the phone for all music files using MediaStore and public music folders.
         * Returns a JSON array of audio tracks with title, artist, duration, path, size.
         */
        @JavascriptInterface
        public String scanDeviceAudio() {
            JSONArray arr = new JSONArray();
            Set<String> seenPaths = new HashSet<String>();
            try {
                ContentResolver cr = getContentResolver();
                Uri uri = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
                String[] projection = new String[] {
                    MediaStore.Audio.Media._ID,
                    MediaStore.Audio.Media.TITLE,
                    MediaStore.Audio.Media.ARTIST,
                    MediaStore.Audio.Media.DURATION,
                    MediaStore.Audio.Media.DATA,
                    MediaStore.Audio.Media.SIZE,
                    MediaStore.Audio.Media.DISPLAY_NAME
                };
                String selection = MediaStore.Audio.Media.IS_MUSIC + " != 0";
                Cursor c = null;
                try {
                    c = cr.query(uri, projection, selection, null, MediaStore.Audio.Media.TITLE + " ASC");
                } catch (Exception e) {
                    c = null;
                }
                if (c == null) {
                    try {
                        c = cr.query(uri, projection, null, null, MediaStore.Audio.Media.TITLE + " ASC");
                    } catch (Exception ignored) {
                    }
                }
                if (c != null) {
                    int colId = c.getColumnIndex(MediaStore.Audio.Media._ID);
                    int colTitle = c.getColumnIndex(MediaStore.Audio.Media.TITLE);
                    int colArtist = c.getColumnIndex(MediaStore.Audio.Media.ARTIST);
                    int colDur = c.getColumnIndex(MediaStore.Audio.Media.DURATION);
                    int colData = c.getColumnIndex(MediaStore.Audio.Media.DATA);
                    int colSize = c.getColumnIndex(MediaStore.Audio.Media.SIZE);
                    int colName = c.getColumnIndex(MediaStore.Audio.Media.DISPLAY_NAME);

                    while (c.moveToNext()) {
                        long id = colId >= 0 ? c.getLong(colId) : 0;
                        String title = colTitle >= 0 ? c.getString(colTitle) : null;
                        String artist = colArtist >= 0 ? c.getString(colArtist) : null;
                        long durMs = colDur >= 0 ? c.getLong(colDur) : 0;
                        String data = colData >= 0 ? c.getString(colData) : null;
                        long size = colSize >= 0 ? c.getLong(colSize) : 0;
                        String name = colName >= 0 ? c.getString(colName) : null;

                        if (data != null && !data.isEmpty()) {
                            seenPaths.add(data);
                        }
                        if (name == null && data != null) {
                            name = new File(data).getName();
                        }
                        if (title == null || title.isEmpty()) {
                            title = name != null ? name : ("Track " + id);
                        }
                        if (artist == null || "<unknown>".equalsIgnoreCase(artist) || artist.trim().isEmpty()) {
                            artist = "Unknown artist";
                        }
                        // Skip short system sounds / ringtones under 3 seconds
                        if (durMs > 0 && durMs < 3000) continue;

                        JSONObject obj = new JSONObject();
                        obj.put("id", "dev_" + id);
                        obj.put("title", title);
                        obj.put("artist", artist);
                        obj.put("duration", durMs / 1000.0);
                        obj.put("path", data != null ? data : "");
                        obj.put("size", size);
                        obj.put("name", name != null ? name : title);
                        arr.put(obj);
                    }
                    c.close();
                }

                // Scan common music storage directories for any files missed by MediaStore indexer
                scanFolder(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), arr, seenPaths, 0);
                scanFolder(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), arr, seenPaths, 0);
                File ext = Environment.getExternalStorageDirectory();
                if (ext != null && ext.exists()) {
                    scanFolder(new File(ext, "Music"), arr, seenPaths, 0);
                    scanFolder(new File(ext, "Audio"), arr, seenPaths, 0);
                }
            } catch (Exception ignored) {
            }
            return arr.toString();
        }

        private void scanFolder(File dir, JSONArray arr, Set<String> seen, int depth) {
            if (dir == null || !dir.exists() || !dir.canRead() || depth > 3) return;
            File[] files = dir.listFiles();
            if (files == null) return;
            for (File f : files) {
                if (f.isDirectory()) {
                    if (!f.getName().startsWith(".")) {
                        scanFolder(f, arr, seen, depth + 1);
                    }
                } else if (f.isFile() && f.length() > 50000) {
                    String p = f.getAbsolutePath();
                    if (seen.contains(p)) continue;
                    String lower = p.toLowerCase();
                    if (lower.endsWith(".mp3") || lower.endsWith(".wav") || lower.endsWith(".m4a")
                            || lower.endsWith(".aac") || lower.endsWith(".ogg") || lower.endsWith(".flac")
                            || lower.endsWith(".opus")) {
                        seen.add(p);
                        try {
                            JSONObject obj = new JSONObject();
                            obj.put("id", "dev_f_" + Math.abs(p.hashCode()));
                            String name = f.getName();
                            String title = name.replaceFirst("\\.[a-zA-Z0-9]+$", "");
                            obj.put("title", title);
                            obj.put("artist", "Device audio");
                            obj.put("duration", 0);
                            obj.put("path", p);
                            obj.put("size", f.length());
                            obj.put("name", name);
                            arr.put(obj);
                        } catch (Exception ignored) {
                        }
                    }
                }
            }
        }

        /** Fallback reader: returns base64 content of an audio file if needed. */
        @JavascriptInterface
        public String readAudioBase64(String path) {
            try {
                InputStream is = null;
                long len = 0;
                if (path.startsWith("content://")) {
                    is = getContentResolver().openInputStream(Uri.parse(path));
                } else {
                    File f = new File(path);
                    if (f.exists() && f.canRead()) {
                        is = new FileInputStream(f);
                        len = f.length();
                    }
                }
                if (is == null) return "";
                int maxBytes = 40 * 1024 * 1024;
                if (len > maxBytes) {
                    is.close();
                    return "";
                }
                byte[] buf = new byte[len > 0 ? (int)len : 1024 * 1024];
                ByteArrayOutputStream baos = new ByteArrayOutputStream();
                int r;
                while ((r = is.read(buf)) != -1) {
                    baos.write(buf, 0, r);
                    if (baos.size() > maxBytes) break;
                }
                is.close();
                return Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP);
            } catch (Exception e) {
                return "";
            }
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
