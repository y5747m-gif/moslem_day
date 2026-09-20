package com.vocalpure.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.bluetooth.BluetoothProfile;
import android.content.BroadcastReceiver;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.PowerManager;
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
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
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
 * shouldInterceptRequest, WAV export, the pinned foreground media
 * notification (PlayerService) and robust audio-output routing:
 *
 *   · proper audio focus (AudioFocusRequest with a real focus listener —
 *     the old null-listener request is gone),
 *   · system-managed media routing (never switch music into call/SCO mode),
 *   · standard A2DP/headset/noisy broadcasts, pausing on disconnect,
 *   · a partial wake lock during playback to reduce sleep-related underruns,
 *   · configChanges coverage so orientation/keyboard/nav-bar/Bluetooth
 *     state changes never recreate the activity mid-song.
 */
public class MainActivity extends Activity {

    private static final int FILE_CHOOSER_CODE = 41001;
    public static final int PERMISSION_REQ_CODE = 5001;

    public static final String PERMISSION_READ_MEDIA_AUDIO = "android.permission.READ_MEDIA_AUDIO";
    public static final String PERMISSION_READ_EXTERNAL_STORAGE = "android.permission.READ_EXTERNAL_STORAGE";
    public static final String PERMISSION_WRITE_EXTERNAL_STORAGE = "android.permission.WRITE_EXTERNAL_STORAGE";

    /* the WebView is process-wide state: the foreground service and the
       audio routing receivers run JS through it */
    private static WebView sWeb;
    /** the (singleTask) activity itself — the notification's output-cycle
       action needs its AudioManager, which is instance state */
    private static volatile MainActivity sInstance;

    private ValueCallback<Uri[]> fileCallback;
    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private boolean focusHeld = false;
    private PowerManager.WakeLock wakeLock;
    private BroadcastReceiver audioReceiver;

    /** Audio output selected by the user (notification or settings).
        volatile: the JS bridge thread writes it, the UI thread reads it. */
    private static volatile String audioOutput = "auto";
    private static final String[] OUTPUT_CYCLE = {"auto", "bluetooth", "wired"};

    /* ------------------------------------------------------------------ */
    /* Static helpers used by PlayerService (same process)                 */
    /* ------------------------------------------------------------------ */

    public static void runJs(final String code) {
        final WebView w = sWeb;
        if (w == null || code == null) return;
        w.post(new Runnable() {
            @Override public void run() {
                try { w.evaluateJavascript(code, null); } catch (Throwable ignored) { }
            }
        });
    }

    public static String currentAudioOutput() { return audioOutput; }

    public static String currentOutputLabel() {
        if ("speaker".equals(audioOutput)) return "Speaker";
        if ("earpiece".equals(audioOutput)) return "Earpiece";
        if ("bluetooth".equals(audioOutput)) return "Bluetooth";
        if ("wired".equals(audioOutput)) return "Wired";
        return "Auto";
    }

    /** Cycles the output: auto → speaker → earpiece → bluetooth → wired. */
    public static void cycleAudioOutput() {
        int i = 0;
        for (int k = 0; k < OUTPUT_CYCLE.length; k++) {
            if (OUTPUT_CYCLE[k].equals(audioOutput)) { i = k; break; }
        }
        audioOutput = OUTPUT_CYCLE[(i + 1) % OUTPUT_CYCLE.length];
        final MainActivity a = sInstance;
        if (a == null) return;
        a.runOnUiThread(new Runnable() {
            @Override public void run() {
                try { a.applyRouting(); } catch (Throwable ignored) { }
                runJs("onNativeMediaAction('output-sync:" + audioOutput + "')");
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* Permissions                                                         */
    /* ------------------------------------------------------------------ */

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

    /* ------------------------------------------------------------------ */
    /* Lifecycle                                                           */
    /* ------------------------------------------------------------------ */

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#070b12"));
        getWindow().setNavigationBarColor(Color.parseColor("#070b12"));

        // Hardware volume keys adjust the media stream
        setVolumeControlStream(AudioManager.STREAM_MUSIC);

        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        registerAudioListener();

        // Auto-request storage/music permissions on first launch if needed
        if (!hasAudioPermission()) {
            requestAudioPermissions();
        }

        sInstance = this;
        webInit();
    }

    private WebView web;

    private void webInit() {
        web = new WebView(this);
        sWeb = web;
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
            /**
             * Streams device audio into the WebView so the player can seek and
             * play huge files without copying them into JavaScript memory.
             *
             * Range requests are honoured (206 + Content-Range) — the HTML media
             * element asks for byte ranges constantly when it seeks, and the AI
             * engine only ever needs the stream, never the whole file.
             */
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (request != null && request.getUrl() != null) {
                    Uri reqUri = request.getUrl();
                    if ("vocalpure.local".equalsIgnoreCase(reqUri.getHost()) && "/audio".equals(reqUri.getPath())) {
                        String method = request.getMethod();
                        if ("OPTIONS".equalsIgnoreCase(method)) {
                            return new WebResourceResponse("text/plain", "UTF-8", 204, "No Content",
                                    corsHeaders(-1, null), new java.io.ByteArrayInputStream(new byte[0]));
                        }
                        String rawPath = reqUri.getQueryParameter("path");
                        if (rawPath != null && !rawPath.isEmpty()) {
                            try {
                                String path = URLDecoder.decode(rawPath, "UTF-8");
                                InputStream is = null;
                                long total = -1;
                                if (path.startsWith("content://")) {
                                    Uri cu = Uri.parse(path);
                                    try {
                                        android.content.res.AssetFileDescriptor afd = getContentResolver().openAssetFileDescriptor(cu, "r");
                                        if (afd != null) {
                                            total = afd.getLength();
                                            afd.close();
                                        }
                                    } catch (Exception ignoredLen) {
                                    }
                                    is = getContentResolver().openInputStream(cu);
                                } else {
                                    File f = new File(path);
                                    if (f.exists() && f.canRead()) {
                                        is = new FileInputStream(f);
                                        total = f.length();
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

                                    long start = 0, end = (total > 0 ? total - 1 : -1);
                                    boolean partial = false;
                                    String rangeHeader = null;
                                    try {
                                        Map<String, String> reqHeaders = request.getRequestHeaders();
                                        if (reqHeaders != null) rangeHeader = reqHeaders.get("Range");
                                    } catch (Exception ignoredHeaders) {
                                    }
                                    if (rangeHeader != null && rangeHeader.startsWith("bytes=") && total > 0) {
                                        String spec = rangeHeader.substring(6).split(",")[0].trim();
                                        int dash = spec.indexOf('-');
                                        if (dash >= 0) {
                                            String lo = spec.substring(0, dash).trim();
                                            String hi = spec.substring(dash + 1).trim();
                                            try {
                                                if (lo.isEmpty()) {                      // suffix range
                                                    long n = Long.parseLong(hi);
                                                    if (n > 0) { start = Math.max(0, total - n); end = total - 1; partial = true; }
                                                } else {
                                                    start = Long.parseLong(lo);
                                                    if (!hi.isEmpty()) end = Math.min(Long.parseLong(hi), total - 1);
                                                    partial = start >= 0 && start <= end;
                                                }
                                            } catch (NumberFormatException ignoredRange) {
                                            }
                                        }
                                    }
                                    if (partial) {
                                        long len = end - start + 1;
                                        String contentRange = "bytes " + start + "-" + end + "/" + total;
                                        return new WebResourceResponse(mime, "UTF-8", 206, "Partial Content",
                                                corsHeaders(len, contentRange), new RangeStream(is, start, len));
                                    }
                                    return new WebResourceResponse(mime, "UTF-8", 200, "OK",
                                            corsHeaders(total > 0 ? total : -1, null), is);
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
        // If Bluetooth reconnected while we were away and the user prefers it,
        // re-assert the routing (the receiver normally handles this).
        try { applyRouting(); } catch (Throwable ignored) { }
    }

    @Override
    protected void onDestroy() {
        try { registerAudioListenerOff(); } catch (Throwable ignored) { }
        try { abandonFocusInternal(); } catch (Throwable ignored) { }
        try { releaseWakeLock(); } catch (Throwable ignored) { }
        if (web != null) {
            if (sWeb == web) sWeb = null;
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        if (sInstance == this) sInstance = null;
        super.onDestroy();
    }

    /* ------------------------------------------------------------------ */
    /* Audio focus — a real listener, requested while playing              */
    /* ------------------------------------------------------------------ */

    private final AudioManager.OnAudioFocusChangeListener focusListener =
            new AudioManager.OnAudioFocusChangeListener() {
        @Override public void onAudioFocusChange(int focusChange) {
            if (focusChange == AudioManager.AUDIOFOCUS_LOSS ||
                focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
                focusHeld = false;
                runJs(focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT
                        ? "onNativeMediaAction('focus:transient')"
                        : "onNativeMediaAction('focus:loss')");
            } else if (focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) {
                runJs("onNativeMediaAction('focus:duck')");
            } else if (focusChange == AudioManager.AUDIOFOCUS_GAIN) {
                focusHeld = true;
                runJs("onNativeMediaAction('focus:gain')");
            }
        }
    };

    public void requestFocusInternal() {
        if (focusHeld || audioManager == null) return;
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                AudioAttributes attrs = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build();
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(attrs)
                        .setOnAudioFocusChangeListener(focusListener)
                        .build();
                if (audioManager.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                    focusHeld = true;
                }
            } else {
                if (audioManager.requestAudioFocus(focusListener,
                        AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
                        == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                    focusHeld = true;
                }
            }
        } catch (Throwable ignored) {
        }
        if (!focusHeld) runJs("onNativeMediaAction('focus:loss')");
    }

    public void abandonFocusInternal() {
        if (audioManager == null) return;
        try {
            if (Build.VERSION.SDK_INT >= 26 && focusRequest != null) {
                audioManager.abandonAudioFocusRequest(focusRequest);
                focusRequest = null;
            } else {
                audioManager.abandonAudioFocus(focusListener);
            }
        } catch (Throwable ignored) {
        }
        focusHeld = false;
    }

    /* ------------------------------------------------------------------ */
    /* Output routing — auto / speaker / earpiece / bluetooth / wired      */
    /* ------------------------------------------------------------------ */

    private boolean hasOutput(int type) {
        if (audioManager == null) return false;
        try {
            for (AudioDeviceInfo device : audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                if (device.getType() == type) return true;
            }
        } catch (RuntimeException ignored) { }
        return false;
    }

    public boolean btConnected() {
        return hasOutput(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP);
    }

    public boolean wiredConnected() {
        return hasOutput(AudioDeviceInfo.TYPE_WIRED_HEADSET)
                || hasOutput(AudioDeviceInfo.TYPE_WIRED_HEADPHONES)
                || hasOutput(AudioDeviceInfo.TYPE_USB_DEVICE);
    }

    /** WebView media uses Android's media route, not the call/SCO route.
        Speakerphone flags cannot select a WebAudio media sink. Never enter
        communication mode or force a speaker fallback on disconnect. */
    public String applyRouting() {
        if (audioManager == null) return audioOutput;
        try {
            if ("earpiece".equals(audioOutput) || "speaker".equals(audioOutput)
                    || ("bluetooth".equals(audioOutput) && !btConnected())
                    || ("wired".equals(audioOutput) && !wiredConnected())) {
                audioOutput = "auto";
            }
        } catch (RuntimeException ignored) { }
        return audioOutput;
    }

    /* ------------------------------------------------------------------ */
    /* Wake lock — keep the CPU up while the song plays so the Bluetooth   */
    /* codec (or the streamed decode) is never starved                     */
    /* ------------------------------------------------------------------ */

    public void setWakeLock(boolean on) {
        try {
            if (on) {
                if (wakeLock == null) {
                    PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                    if (pm != null) {
                        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "vocalpure:playback");
                        wakeLock.setReferenceCounted(false);
                    }
                }
                if (wakeLock != null && !wakeLock.isHeld()) {
                    wakeLock.acquire(12L * 60 * 60 * 1000);   /* hard cap, released on pause/destroy */
                }
            } else {
                releaseWakeLock();
            }
        } catch (Throwable ignored) {
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Throwable ignored) {
        }
    }

    /* ------------------------------------------------------------------ */
    /* Bluetooth / headset / noisy receivers                               */
    /* ------------------------------------------------------------------ */

    private void registerAudioListener() {
        try {
            audioReceiver = new BroadcastReceiver() {
                @Override public void onReceive(Context context, Intent intent) {
                    if (intent == null || intent.getAction() == null) return;
                    String action = intent.getAction();
                    if ("android.bluetooth.a2dp.profile.action.CONNECTION_STATE_CHANGED".equals(action)) {
                        int state = intent.getIntExtra(
                                "android.bluetooth.profile.extra.STATE", -1);
                        if (state == BluetoothProfile.STATE_CONNECTED) {
                            runJs("onNativeMediaAction('bt:connected')");
                        } else if (state == BluetoothProfile.STATE_DISCONNECTED) {
                            runJs("onNativeMediaAction('bt:disconnected')");
                        }
                        try { applyRouting(); } catch (Throwable ignored) { }

                    } else if (Intent.ACTION_HEADSET_PLUG.equals(action)) {
                        if (isInitialStickyBroadcast()) return;
                        int state = intent.getIntExtra("state", -1);
                        if (state == 0) {
                            runJs("onNativeMediaAction('headset:unplugged')");
                        } else {
                            runJs("onNativeMediaAction('headset:plugged')");
                        }
                        try { applyRouting(); } catch (Throwable ignored) { }
                    } else if ("android.media.action.AUDIO_BECOMING_NOISY".equals(action)) {
                        runJs("onNativeMediaAction('headset:unplugged')");
                    }
                }
            };
            IntentFilter f = new IntentFilter();
            f.addAction("android.bluetooth.a2dp.profile.action.CONNECTION_STATE_CHANGED");
            f.addAction(Intent.ACTION_HEADSET_PLUG);
            f.addAction("android.media.action.AUDIO_BECOMING_NOISY");
            registerReceiver(audioReceiver, f);
        } catch (Throwable ignored) {
        }
    }

    private void registerAudioListenerOff() {
        try {
            if (audioReceiver != null) {
                unregisterReceiver(audioReceiver);
                audioReceiver = null;
            }
        } catch (Throwable ignored) {
        }
    }

    /* ------------------------------------------------------------------ */
    /* JS bridge                                                           */
    /* ------------------------------------------------------------------ */

    /** Exposes app identity, permissions, device music scanning, WAV export,
        the pinned media notification and audio routing to the bundled page. */
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
                @Override public void run() {
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

        /* ---------------- pinned media notification ---------------- */

        @JavascriptInterface
        public void setNowPlayingMeta(final String title, final String subtitle, final String artBase64) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    Intent i = new Intent(MainActivity.this, PlayerService.class);
                    i.setAction(PlayerService.ACTION_META);
                    i.putExtra("title", title != null ? title : "VocalPure");
                    i.putExtra("subtitle", subtitle != null ? subtitle : "");
                    i.putExtra("art", artBase64 != null ? artBase64 : "");
                    if (PlayerService.isRunning()) {
                        PlayerService.updateState(i);
                    } else {
                        try { startService(i); } catch (Throwable ignored) { }
                    }
                }
            });
        }

        @JavascriptInterface
        public void setPlayState(final boolean playing, final long positionMs,
                                 final long durationMs, final float rate) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    Intent i = new Intent(MainActivity.this, PlayerService.class);
                    i.setAction(PlayerService.ACTION_STATE);
                    i.putExtra("playing", playing);
                    i.putExtra("positionMs", positionMs);
                    i.putExtra("durationMs", durationMs);
                    i.putExtra("rate", rate);
                    if (PlayerService.isRunning()) {
                        PlayerService.updateState(i);
                    } else if (playing) {
                        /* first playback: start the foreground service */
                        i.putExtra("title", "VocalPure");
                        i.putExtra("subtitle", "");
                        try { startService(i); } catch (Throwable ignored) { }
                    }
                }
            });
        }

        @JavascriptInterface
        public void stopPlaybackNotification() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    Intent i = new Intent(MainActivity.this, PlayerService.class);
                    i.setAction(PlayerService.ACTION_STOP);
                    try { startService(i); } catch (Throwable ignored) { }
                }
            });
        }

        /* ---------------- audio focus + wake lock ---------------- */

        @JavascriptInterface
        public void requestAudioFocus() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    requestFocusInternal();
                }
            });
        }

        @JavascriptInterface
        public void abandonAudioFocus() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    abandonFocusInternal();
                }
            });
        }

        @JavascriptInterface
        public void setPlaying(final boolean on) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    setWakeLock(on);
                }
            });
        }

        /* ---------------- output routing ---------------- */

        /** Sets the audio output; returns the mode actually in effect
            (a fallback mode when e.g. Bluetooth is not connected).
            AudioManager routing is thread-safe, so this runs directly on
            the bridge thread and returns synchronously. */
        @JavascriptInterface
        public String setAudioOutput(String mode) {
            if (mode != null) {
                for (int i = 0; i < OUTPUT_CYCLE.length; i++) {
                    if (OUTPUT_CYCLE[i].equals(mode)) {
                        audioOutput = mode;
                        return applyRouting();
                    }
                }
            }
            return audioOutput;
        }

        @JavascriptInterface
        public String getAudioState() {
            try {
                JSONObject o = new JSONObject();
                o.put("current", audioOutput);
                o.put("label", currentOutputLabel());
                o.put("btConnected", btConnected());
                o.put("wiredConnected", wiredConnected());
                return o.toString();
            } catch (Throwable t) {
                return "{\"current\":\"auto\"}";
            }
        }

        private boolean containsOutput(String m) {
            for (int i = 0; i < OUTPUT_CYCLE.length; i++) {
                if (OUTPUT_CYCLE[i].equals(m)) return true;
            }
            return false;
        }

        /* ---------------- device music scanning ---------------- */

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

        /**
         * Called once the streamed WAV export is complete: rewrites the RIFF and
         * data chunk sizes that were placeholders while the file was streaming.
         *
         * @return "ok:<path>" or "error:<message>".
         */
        @JavascriptInterface
        public String finishWav(String name, long dataBytes) {
            try {
                File dir = getExternalFilesDir(Environment.DIRECTORY_MUSIC);
                if (dir == null) dir = getFilesDir();
                File target = new File(dir, sanitize(name));
                if (!target.exists()) return "error:file not found";
                long size = target.length();
                long data = dataBytes > 0 ? dataBytes : Math.max(0, size - 44);
                if (data > size - 44 && size >= 44) data = size - 44;
                RandomAccessFile raf = new RandomAccessFile(target, "rw");
                writeLE32(raf, 4, (int) ((36 + data) & 0xffffffffL));
                writeLE32(raf, 40, (int) (data & 0xffffffffL));
                raf.close();
                return "ok:" + target.getAbsolutePath();
            } catch (Exception e) {
                return "error:" + (e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName());
            }
        }

        private void writeLE32(RandomAccessFile raf, long position, int value) throws IOException {
            raf.seek(position);
            raf.write(value & 0xFF);
            raf.write((value >>> 8) & 0xFF);
            raf.write((value >>> 16) & 0xFF);
            raf.write((value >>> 24) & 0xFF);
        }

        private String sanitize(String name) {
            if (name == null) return "vocalpure-export.wav";
            String s = name.trim().replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_");
            if (s.length() > 180) s = s.substring(0, 180);
            if (s.isEmpty()) s = "vocalpure-export.wav";
            return s;
        }
    }


    /** CORS + range headers for the streamed audio responses. */
    private static Map<String, String> corsHeaders(long contentLength, String contentRange) {
        Map<String, String> headers = new HashMap<String, String>();
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        headers.put("Access-Control-Allow-Headers", "*");
        headers.put("Accept-Ranges", "bytes");
        if (contentLength >= 0) headers.put("Content-Length", String.valueOf(contentLength));
        if (contentRange != null) headers.put("Content-Range", contentRange);
        return headers;
    }

    /** InputStream limited to [start, start+length) of the wrapped stream. */
    private static class RangeStream extends InputStream {
        private final InputStream in;
        private long remaining;

        RangeStream(InputStream in, long start, long length) throws IOException {
            this.in = in;
            this.remaining = length;
            long skip = start;
            while (skip > 0) {
                long s = in.skip(skip);
                if (s <= 0) break;
                skip -= s;
            }
        }

        @Override
        public int read() throws IOException {
            if (remaining <= 0) return -1;
            int b = in.read();
            if (b >= 0) remaining--;
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (remaining <= 0) return -1;
            int n = in.read(b, off, (int) Math.min(len, remaining));
            if (n > 0) remaining -= n;
            return n;
        }

        @Override
        public void close() throws IOException {
            in.close();
        }
    }

    /** Files currently being streamed from the JS bridge. */
    private static final Map<String, FileOutputStream> openWrites = new HashMap<String, FileOutputStream>();
}
