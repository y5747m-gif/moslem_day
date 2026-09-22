package com.vocalpure.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;

/**
 * VocalPure — foreground media service.
 *
 * Owns the PINNED notification in the system status bar so playback controls
 * keep working while the app is backgrounded. Playback itself still lives in
 * the WebView (the streamed audio element + AI engine); this service only
 * shows the media UI and forwards button presses back to the page through
 * {@link MainActivity#runJs(String)}.
 *
 * Notification contents:
 *   · a top-bar message the listener can use to change songs WITHOUT
 *     opening the app (the body tap skips forward; Previous / Next do
 *     the same). There is deliberately no activity content intent.
 *   · track title + artist as the secondary line
 *   · large icon: the cover art embedded in the file (sent as base64),
 *     falling back to the app icon
 *   · Previous / Play-Pause / Next transport actions
 *   · an "Output" action that cycles the audio output
 *   · position readout through MediaSession (MediaStyle)
 */
public class PlayerService extends Service {

    public static final String ACTION_META = "com.vocalpure.app.META";
    public static final String ACTION_STATE = "com.vocalpure.app.STATE";
    public static final String ACTION_CMD = "com.vocalpure.app.CMD";
    public static final String ACTION_STOP = "com.vocalpure.app.STOP";

    /* New id so an existing low-importance "vp_media" channel cannot pin
       this notification out of the top of the shade. */
    private static final String CHANNEL_ID = "vp_media_nav";
    private static final int NOTIFICATION_ID = 4101;

    private MediaSession session;
    private String title = "VocalPure";
    private String subtitle = "";
    private Bitmap art = null;
    private boolean playing = false;
    private long positionMs = 0;
    private long durationMs = 0;
    private float rate = 1.0f;
    /* True for the next build after the track title changes, so the
       heads-up appears once per song — not on every position tick. */
    private boolean alertNext = false;
    private Notification lastNotification = null;

    /* In-process handle: while the service is alive, the activity pushes
       state updates directly (no startService — that is forbidden for
       background apps and would crash on a position tick from the
       notification-triggered playback). */
    private static volatile PlayerService sInstance;

    public static boolean isRunning() { return sInstance != null; }

    public static void updateState(Intent intent) {
        PlayerService s = sInstance;
        if (s != null) s.applyState(intent);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        sInstance = this;
        createChannel();
        session = new MediaSession(this, "VocalPure");
        session.setActive(true);
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay()  { MainActivity.runJs("onNativeMediaAction('play')"); }
            @Override public void onPause() { MainActivity.runJs("onNativeMediaAction('pause')"); }
            @Override public void onSkipToNext()    { MainActivity.runJs("onNativeMediaAction('next')"); }
            @Override public void onSkipToPrevious(){ MainActivity.runJs("onNativeMediaAction('prev')"); }
            @Override public void onStop()  { stopForegroundSafely(); }
            @Override public void onSeekTo(long pos) {
                MainActivity.runJs("onNativeMediaAction('seek:" + pos + "')");
            }
        });
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;

        if (ACTION_STOP.equals(action)) {
            stopForegroundSafely();
            stopSelf();
            return START_NOT_STICKY;
        }

        if (ACTION_CMD.equals(action) && intent != null) {
            String cmd = intent.getStringExtra("cmd");
            if ("output".equals(cmd)) {
                /* cycle the audio output, then refresh the action label */
                MainActivity.cycleAudioOutput();
                updateNotification();
                return START_STICKY;
            }
            if (cmd != null) {
                final String c = cmd;
                MainActivity.runJs("onNativeMediaAction('" + c + "')");
            }
            return START_STICKY;
        }

        applyState(intent);
        startForegroundSafely();
        return START_STICKY;
    }

    /** Applies META / STATE extras to the shown notification. */
    private void applyState(Intent intent) {
        if (intent == null) return;
        String nextTitle = str(intent, "title", title);
        if (nextTitle != null && !nextTitle.equals(title)) alertNext = true;
        title = nextTitle;
        subtitle = str(intent, "subtitle", subtitle);
        String b64 = intent.getStringExtra("art");
        if (b64 != null) {
            art = b64.isEmpty() ? null : decodeArt(b64);
        }
        playing = intent.getBooleanExtra("playing", playing);
        positionMs = intent.getLongExtra("positionMs", positionMs);
        durationMs = intent.getLongExtra("durationMs", durationMs);
        rate = intent.getFloatExtra("rate", 1.0f);
        updateNotification();
    }

    /* ------------------------------------------------------------------ */

    private void createChannel() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel ch = nm.getNotificationChannel(CHANNEL_ID);
        if (ch == null) {
            ch = new NotificationChannel(CHANNEL_ID,
                    getString(R.string.notif_channel_nav), NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription(getString(R.string.notif_channel_desc));
            ch.setShowBadge(false);
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ch);
        }
    }

    private Notification buildNotification() {
        boolean alert = alertNext;
        alertNext = false;
        String hint = getString(R.string.notif_nav_hint);
        /* Body tap changes the song. It must NOT launch MainActivity —
           the listener stays in the notification shade. */
        Notification.Builder b = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_media_notify)
                .setContentTitle(title)
                .setContentText(hint)
                .setSubText(subtitle == null || subtitle.isEmpty() ? "VocalPure" : subtitle)
                .setTicker(hint)
                .setOngoing(true)
                .setOnlyAlertOnce(!alert)
                .setShowWhen(false)
                .setCategory(Notification.CATEGORY_TRANSPORT)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setPriority(Notification.PRIORITY_HIGH)
                .setContentIntent(cmdIntent("next"))
                .setStyle(new Notification.MediaStyle()
                        .setMediaSession(session.getSessionToken())
                        .setShowActionsInCompactView(0, 1, 2))
                .addAction(action(R.drawable.ic_media_prev, "Previous", "prev"))
                .addAction(action(playing ? R.drawable.ic_media_pause : R.drawable.ic_media_play,
                        playing ? "Pause" : "Play", playing ? "pause" : "play"))
                .addAction(action(R.drawable.ic_media_next, "Next", "next"))
                .addAction(action(R.drawable.ic_media_output,
                        "Output: " + MainActivity.currentOutputLabel(), "output"));
        if (art != null) {
            b.setLargeIcon(art);
        } else {
            b.setLargeIcon(appIcon());
        }
        return b.build();
    }

    private Notification.Action action(int iconRes, String label, String cmd) {
        Icon icon = iconFor(iconRes);
        return new Notification.Action.Builder(icon, label, cmdIntent(cmd)).build();
    }

    private Icon iconFor(int res) {
        try {
            return Icon.createWithResource(this, res);
        } catch (Throwable t) {
            return null;
        }
    }

    private PendingIntent cmdIntent(String cmd) {
        Intent i = new Intent(this, PlayerService.class);
        i.setAction(ACTION_CMD);
        i.putExtra("cmd", cmd);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getService(this, cmd.hashCode() & 0x7fffffff, i, flags);
    }

    private Bitmap appIcon() {
        try {
            return BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher);
        } catch (Throwable t) {
            return null;
        }
    }

    private void updateNotification() {
        lastNotification = buildNotification();
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            try { nm.notify(NOTIFICATION_ID, lastNotification); } catch (Throwable ignored) { }
        }
        try {
            int state = playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED;
            PlaybackState.Builder ps = new PlaybackState.Builder()
                    .setActions(PlaybackState.ACTION_PLAY
                            | PlaybackState.ACTION_PAUSE
                            | PlaybackState.ACTION_PLAY_PAUSE
                            | PlaybackState.ACTION_SKIP_TO_NEXT
                            | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                            | PlaybackState.ACTION_STOP
                            | PlaybackState.ACTION_SEEK_TO)
                    .setState(state, positionMs, rate);
            if (durationMs > 0) ps.setBufferedPosition(durationMs);
            session.setPlaybackState(ps.build());
            MediaMetadata.Builder md = new MediaMetadata.Builder()
                    .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                    .putString(MediaMetadata.METADATA_KEY_ARTIST, subtitle)
                    .putString(MediaMetadata.METADATA_KEY_DISPLAY_DESCRIPTION,
                            getString(R.string.notif_nav_hint));
            if (durationMs > 0) md.putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs);
            if (art != null) md.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, art);
            session.setMetadata(md.build());
        } catch (Throwable ignored) { }
    }

    private Bitmap decodeArt(String b64) {
        try {
            byte[] raw = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
            Bitmap bmp = BitmapFactory.decodeByteArray(raw, 0, raw.length);
            if (bmp == null) return null;
            /* downscale big embedded art so the notification stays light */
            int max = 512;
            if (bmp.getWidth() > max || bmp.getHeight() > max) {
                float scale = Math.min((float) max / bmp.getWidth(), (float) max / bmp.getHeight());
                Bitmap small = Bitmap.createScaledBitmap(bmp,
                        Math.max(1, Math.round(bmp.getWidth() * scale)),
                        Math.max(1, Math.round(bmp.getHeight() * scale)), true);
                if (small != bmp) bmp.recycle();
                bmp = small;
            }
            return bmp;
        } catch (Throwable t) {
            return null;
        }
    }

    private void startForegroundSafely() {
        Notification n = lastNotification != null ? lastNotification : buildNotification();
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, n,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
        } catch (Throwable t) {
            try { startForeground(NOTIFICATION_ID, n); } catch (Throwable ignored) { }
        }
    }

    private void stopForegroundSafely() {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
        } catch (Throwable t) {
            try { stopForeground(true); } catch (Throwable ignored) { }
        }
    }

    @Override
    public void onDestroy() {
        if (sInstance == this) sInstance = null;
        if (session != null) {
            try { session.release(); } catch (Throwable ignored) { }
            session = null;
        }
        if (art != null) {
            try { art.recycle(); } catch (Throwable ignored) { }
            art = null;
        }
        super.onDestroy();
    }

    private static String str(Intent i, String key, String def) {
        String v = i.getStringExtra(key);
        return v != null ? v : def;
    }
}
