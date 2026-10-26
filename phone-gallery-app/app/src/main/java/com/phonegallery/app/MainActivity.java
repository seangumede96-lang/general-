package com.phonegallery.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Intent;
import android.content.IntentSender;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.ImageDecoder;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Size;
import android.view.View;
import android.view.WindowInsetsController;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Phone Gallery: the photos and videos on this phone, shown by a web page
 * (assets/web) in a full-screen WebView. This activity supplies that page with
 * the media list, thumbnails and files, storage for albums, sharing, and the
 * back button.
 *
 * The page and the media share one made-up https origin that never leaves the
 * phone: /assets/... are files from the app, /thumb/{key} and /media/{key} are
 * photos and videos read from the phone (key = "i" + image id or "v" + video id).
 */
public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/assets/web/index.html";
    private static final int PICK_FILE = 1;
    private static final int ASK_ACCESS = 2;
    private static final int TRASH = 3;
    private static final int RESTORE = 4;
    private static final int DELETE = 5;
    private static final int THUMB_SIZE = 360;
    private static final int MAX_CONVERTED_SIZE = 2048;
    private static final Pattern RANGE = Pattern.compile("bytes=(\\d*)-(\\d*)");

    private WebView webView;
    private FrameLayout root;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private ValueCallback<Uri[]> fileCallback;
    private WebViewAssetLoader assetLoader;
    private boolean pageLoaded;
    private int pendingCount; // how many items the current delete/restore request covers

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        root = new FrameLayout(this);
        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // muted videos play while on screen
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView.addJavascriptInterface(new Bridge(), "Android");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (!HOST.equals(url.getHost())) return null;
                String path = url.getPath() == null ? "" : url.getPath();
                if (path.startsWith("/thumb/")) return thumbnail(path.substring(7));
                if (path.startsWith("/media/")) return media(path.substring(7), request.getRequestHeaders());
                return assetLoader.shouldInterceptRequest(url);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !HOST.equals(request.getUrl().getHost()); // the page never navigates away
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageLoaded = true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            // Full-screen video.
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullscreenView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                fullscreenView = view;
                fullscreenCallback = callback;
                root.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                webView.setVisibility(View.GONE);
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
            }

            @Override
            public void onHideCustomView() {
                exitFullscreen();
            }

            // "Restore from backup".
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(pick, "Choose a backup file"), PICK_FILE);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        if (!hasAccess()) requestAccess();
        webView.loadUrl(START_URL);
    }

    // --- Permission ----------------------------------------------------------

    private String[] accessPermissions() {
        if (Build.VERSION.SDK_INT >= 34) {
            return new String[]{Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO,
                    Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED};
        }
        if (Build.VERSION.SDK_INT >= 33) {
            return new String[]{Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO};
        }
        return new String[]{Manifest.permission.READ_EXTERNAL_STORAGE};
    }

    /** True with full access, or (Android 14+) when you picked "Allow limited access". */
    boolean hasAccess() {
        if (Build.VERSION.SDK_INT >= 34
                && checkSelfPermission(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) == PackageManager.PERMISSION_GRANTED) {
            return true;
        }
        if (Build.VERSION.SDK_INT >= 33) {
            return checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED
                    || checkSelfPermission(Manifest.permission.READ_MEDIA_VIDEO) == PackageManager.PERMISSION_GRANTED;
        }
        return checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    void requestAccess() {
        requestPermissions(accessPermissions(), ASK_ACCESS);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == ASK_ACCESS) reloadGallery();
    }

    private void reloadGallery() {
        webView.evaluateJavascript("window.galleryReload && window.galleryReload()", null);
    }

    // --- Media list ----------------------------------------------------------

    /** Every photo and video as JSON, newest first. */
    String mediaJson() {
        return mediaJson(false);
    }

    /** With `trashed`, only what's in the phone's recycle bin (with when it expires). */
    String mediaJson(boolean trashed) {
        Uri files = MediaStore.Files.getContentUri("external");
        String[] cols = {
                MediaStore.Files.FileColumns._ID,
                MediaStore.Files.FileColumns.MEDIA_TYPE,
                MediaStore.MediaColumns.DATE_TAKEN,
                MediaStore.MediaColumns.DATE_ADDED,
                MediaStore.MediaColumns.WIDTH,
                MediaStore.MediaColumns.HEIGHT,
                MediaStore.MediaColumns.ORIENTATION,
                MediaStore.MediaColumns.DURATION,
                MediaStore.MediaColumns.BUCKET_DISPLAY_NAME,
                MediaStore.MediaColumns.DATE_EXPIRES,
                MediaStore.MediaColumns.DISPLAY_NAME,
                MediaStore.MediaColumns.SIZE,
                MediaStore.MediaColumns.MIME_TYPE,
        };
        String where = MediaStore.Files.FileColumns.MEDIA_TYPE + " IN ("
                + MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE + ","
                + MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO + ")";
        String order = MediaStore.MediaColumns.DATE_TAKEN + " DESC, " + MediaStore.MediaColumns.DATE_ADDED + " DESC";
        StringBuilder json = new StringBuilder("[");
        Bundle args = new Bundle();
        args.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, where);
        args.putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, order);
        args.putInt(MediaStore.QUERY_ARG_MATCH_TRASHED, trashed ? MediaStore.MATCH_ONLY : MediaStore.MATCH_EXCLUDE);
        try (Cursor c = getContentResolver().query(files, cols, args, null)) {
            if (c == null) return "[]";
            boolean first = true;
            while (c.moveToNext()) {
                long id = c.getLong(0);
                boolean video = c.getInt(1) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO;
                long added = c.getLong(3) * 1000L;
                long taken = c.isNull(2) ? 0 : c.getLong(2);
                int w = c.getInt(4);
                int h = c.getInt(5);
                if (c.getInt(6) % 180 == 90) { // stored sideways: swap so the shape is right
                    int t = w;
                    w = h;
                    h = t;
                }
                String key = (video ? "v" : "i") + id;
                if (!first) json.append(',');
                first = false;
                json.append("{\"key\":\"").append(key)
                        .append("\",\"type\":\"").append(video ? "video" : "photo").append('"');
                json.append(",\"saved\":").append(taken > 0 ? taken : added)
                        .append(",\"posted\":").append(added)
                        .append(",\"w\":").append(w)
                        .append(",\"h\":").append(h)
                        .append(",\"duration\":").append(c.getLong(7))
                        .append(",\"folder\":").append(jsonString(c.getString(8)));
                if (trashed && !c.isNull(9)) json.append(",\"expires\":").append(c.getLong(9) * 1000L);
                json.append(",\"name\":").append(jsonString(c.getString(10)))
                        .append(",\"size\":").append(c.getLong(11));
                if ("image/gif".equals(c.getString(12))) json.append(",\"gif\":true");
                json.append('}');
            }
        } catch (SecurityException e) {
            return "[]";
        }
        return json.append(']').toString();
    }

    private static String jsonString(String text) {
        if (text == null) return "\"\"";
        StringBuilder sb = new StringBuilder("\"");
        for (char ch : text.toCharArray()) {
            if (ch == '"' || ch == '\\') sb.append('\\').append(ch);
            else if (ch < 0x20) sb.append(String.format("\\u%04x", (int) ch));
            else sb.append(ch);
        }
        return sb.append('"').toString();
    }

    /** "i123" -> the photo's content address; "v45" -> the video's; anything else -> null. */
    private static Uri uriFor(String key) {
        if (key == null || key.length() < 2) return null;
        long id;
        try {
            id = Long.parseLong(key.substring(1));
        } catch (NumberFormatException e) {
            return null;
        }
        if (key.charAt(0) == 'i') return ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id);
        if (key.charAt(0) == 'v') return ContentUris.withAppendedId(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, id);
        return null;
    }

    // --- Serving thumbnails and files ---------------------------------------

    private WebResourceResponse thumbnail(String key) {
        Uri uri = uriFor(key);
        if (uri == null) return notFound();
        try {
            Bitmap bmp = getContentResolver().loadThumbnail(uri, new Size(THUMB_SIZE, THUMB_SIZE), null);
            return jpeg(bmp, 82);
        } catch (IOException | RuntimeException e) {
            // Android couldn't make one: try decoding the file ourselves.
            Bitmap bmp = key.charAt(0) == 'v' ? videoFrame(uri) : decodeSmall(uri);
            return bmp != null ? jpeg(bmp, 82) : notFound();
        }
    }

    private Bitmap decodeSmall(Uri uri) {
        try {
            return ImageDecoder.decodeBitmap(ImageDecoder.createSource(getContentResolver(), uri), (decoder, info, src) -> {
                Size size = info.getSize();
                int longest = Math.max(size.getWidth(), size.getHeight());
                if (longest > THUMB_SIZE) {
                    float scale = (float) THUMB_SIZE / longest;
                    decoder.setTargetSize(Math.max(1, Math.round(size.getWidth() * scale)), Math.max(1, Math.round(size.getHeight() * scale)));
                }
                decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
            });
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }

    private Bitmap videoFrame(Uri uri) {
        MediaMetadataRetriever r = new MediaMetadataRetriever();
        try {
            r.setDataSource(this, uri);
            return r.getScaledFrameAtTime(-1, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, THUMB_SIZE, THUMB_SIZE);
        } catch (RuntimeException e) {
            return null;
        } finally {
            try {
                r.release();
            } catch (IOException | RuntimeException ignored) {
                /* nothing to release */
            }
        }
    }

    private WebResourceResponse media(String key, Map<String, String> requestHeaders) {
        Uri uri = uriFor(key);
        if (uri == null) return notFound();
        ContentResolver resolver = getContentResolver();
        String mime = resolver.getType(uri);
        if (mime == null) mime = key.charAt(0) == 'v' ? "video/mp4" : "image/jpeg";
        try {
            // Photos the web view can't show (HEIC/HEIF, RAW…): convert to JPEG.
            if (mime.startsWith("image/") && !isWebImage(mime)) {
                Bitmap bmp = ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri), (decoder, info, src) -> {
                    Size size = info.getSize();
                    int longest = Math.max(size.getWidth(), size.getHeight());
                    if (longest > MAX_CONVERTED_SIZE) {
                        float scale = (float) MAX_CONVERTED_SIZE / longest;
                        decoder.setTargetSize(Math.round(size.getWidth() * scale), Math.round(size.getHeight() * scale));
                    }
                });
                return jpeg(bmp, 88);
            }
            // Everything else is sent as-is. Videos are asked for in pieces
            // ("Range" requests) so you can skip around in them.
            AssetFileDescriptor afd = resolver.openAssetFileDescriptor(uri, "r");
            if (afd == null) return notFound();
            long total = afd.getLength() >= 0 ? afd.getLength() : afd.getParcelFileDescriptor().getStatSize();
            FileInputStream in = afd.createInputStream();
            Map<String, String> headers = new HashMap<>();
            headers.put("Accept-Ranges", "bytes");
            headers.put("Cache-Control", "no-cache");
            String range = header(requestHeaders, "Range");
            Matcher m = range == null || total <= 0 ? null : RANGE.matcher(range);
            if (m != null && m.matches() && !(m.group(1).isEmpty() && m.group(2).isEmpty())) {
                long start;
                long end;
                if (m.group(1).isEmpty()) { // "bytes=-500": the last 500 bytes
                    start = Math.max(0, total - Long.parseLong(m.group(2)));
                    end = total - 1;
                } else {
                    start = Long.parseLong(m.group(1));
                    end = m.group(2).isEmpty() ? total - 1 : Math.min(Long.parseLong(m.group(2)), total - 1);
                }
                if (start >= total || start > end) {
                    in.close();
                    headers.put("Content-Range", "bytes */" + total);
                    return new WebResourceResponse(mime, null, 416, "Range Not Satisfiable", headers, new ByteArrayInputStream(new byte[0]));
                }
                in.getChannel().position(in.getChannel().position() + start);
                long length = end - start + 1;
                headers.put("Content-Range", "bytes " + start + "-" + end + "/" + total);
                headers.put("Content-Length", String.valueOf(length));
                return new WebResourceResponse(mime, null, 206, "Partial Content", headers, new LimitedStream(in, length));
            }
            if (total > 0) headers.put("Content-Length", String.valueOf(total));
            return new WebResourceResponse(mime, null, 200, "OK", headers, in);
        } catch (IOException | SecurityException | NumberFormatException e) {
            return notFound();
        }
    }

    private static boolean isWebImage(String mime) {
        return mime.equals("image/jpeg") || mime.equals("image/png") || mime.equals("image/gif")
                || mime.equals("image/webp") || mime.equals("image/bmp") || mime.equals("image/avif");
    }

    private static String header(Map<String, String> headers, String name) {
        if (headers == null) return null;
        for (Map.Entry<String, String> e : headers.entrySet()) {
            if (e.getKey() != null && e.getKey().equalsIgnoreCase(name)) return e.getValue();
        }
        return null;
    }

    private static WebResourceResponse jpeg(Bitmap bmp, int quality) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        bmp.compress(Bitmap.CompressFormat.JPEG, quality, out);
        bmp.recycle();
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "max-age=86400");
        return new WebResourceResponse("image/jpeg", null, 200, "OK", headers, new ByteArrayInputStream(out.toByteArray()));
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }

    /** Reads at most `left` bytes from the underlying stream. */
    private static final class LimitedStream extends InputStream {
        private final InputStream in;
        private long left;

        LimitedStream(InputStream in, long left) {
            this.in = in;
            this.left = left;
        }

        @Override
        public int read() throws IOException {
            if (left <= 0) return -1;
            int b = in.read();
            if (b >= 0) left--;
            return b;
        }

        @Override
        public int read(byte[] buf, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = in.read(buf, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }

        @Override
        public void close() throws IOException {
            in.close();
        }
    }

    // --- Delete, restore, share -------------------------------------------------

    private static List<Uri> urisFor(String keys) {
        List<Uri> uris = new ArrayList<>();
        if (keys == null) return uris;
        for (String key : keys.split(",")) {
            Uri uri = uriFor(key.trim());
            if (uri != null) uris.add(uri);
        }
        return uris;
    }

    /**
     * Ask Android to move items to (or out of) the recycle bin, or delete them
     * for good. Android shows its own confirmation unless the app has "media
     * management" access; the answer arrives in onActivityResult.
     */
    void changeMedia(int what, String keys) {
        List<Uri> uris = urisFor(keys);
        if (uris.isEmpty()) return;
        ContentResolver resolver = getContentResolver();
        PendingIntent request = what == TRASH ? MediaStore.createTrashRequest(resolver, uris, true)
                : what == RESTORE ? MediaStore.createTrashRequest(resolver, uris, false)
                : MediaStore.createDeleteRequest(resolver, uris);
        pendingCount = uris.size();
        try {
            startIntentSenderForResult(request.getIntentSender(), what, null, 0, 0, 0);
        } catch (IntentSender.SendIntentException e) {
            actionDone(what, false);
        }
    }

    private void actionDone(int what, boolean ok) {
        String kind = what == TRASH ? "trash" : what == RESTORE ? "restore" : "delete";
        webView.evaluateJavascript("window.galleryActionDone && window.galleryActionDone('" + kind + "', " + ok + ", " + pendingCount + ")", null);
    }

    void shareItems(String keys) {
        List<Uri> uris = urisFor(keys);
        if (uris.isEmpty()) return;
        boolean allVideos = keys.matches("(v\\d+,?)+");
        boolean allPhotos = keys.matches("(i\\d+,?)+");
        String type = allVideos ? "video/*" : allPhotos ? "image/*" : "*/*";
        Intent send;
        if (uris.size() == 1) {
            send = new Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uris.get(0));
        } else {
            send = new Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, new ArrayList<>(uris));
        }
        send.setType(type);
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivity(Intent.createChooser(send, "Share"));
        } catch (ActivityNotFoundException e) {
            /* nothing to share with */
        }
    }

    // --- Phone features --------------------------------------------------------

    private void exitFullscreen() {
        if (fullscreenView == null) return;
        root.removeView(fullscreenView);
        fullscreenView = null;
        webView.setVisibility(View.VISIBLE);
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
        fullscreenCallback = null;
    }

    /** Back: leave full-screen video, else let the gallery close what's open, else leave the app. */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (fullscreenView != null) {
            exitFullscreen();
            return;
        }
        webView.evaluateJavascript("!!(window.galleryBack && window.galleryBack())", handled -> {
            if (!"true".equals(handled)) finish();
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Pick up photos taken or deleted while the app was in the background.
        if (pageLoaded) reloadGallery();
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == TRASH || requestCode == RESTORE || requestCode == DELETE) {
            actionDone(requestCode, resultCode == RESULT_OK);
            return;
        }
        if (requestCode != PICK_FILE || fileCallback == null) return;
        Uri picked = resultCode == RESULT_OK && data != null ? data.getData() : null;
        fileCallback.onReceiveValue(picked != null ? new Uri[]{picked} : null);
        fileCallback = null;
    }

    /** What the gallery page can call, as `window.Android`. */
    final class Bridge {
        private final SharedPreferences prefs = getSharedPreferences("gallery", MODE_PRIVATE);

        @JavascriptInterface
        public boolean hasAccess() {
            return MainActivity.this.hasAccess();
        }

        @JavascriptInterface
        public void requestAccess() {
            runOnUiThread(MainActivity.this::requestAccess);
        }

        @JavascriptInterface
        public String getMedia() {
            return mediaJson();
        }

        @JavascriptInterface
        public String get(String key) {
            return prefs.getString(key, null);
        }

        @JavascriptInterface
        public void set(String key, String json) {
            prefs.edit().putString(key, json).apply();
        }

        /** Changes whenever photos/videos are added, edited or deleted on the phone. */
        @JavascriptInterface
        public String changeStamp() {
            return MediaStore.getVersion(MainActivity.this) + ":" + MediaStore.getGeneration(MainActivity.this, MediaStore.VOLUME_EXTERNAL_PRIMARY)
                    + ":" + MainActivity.this.hasAccess();
        }

        @JavascriptInterface
        public String getTrash() {
            return mediaJson(true);
        }

        /** Share one or more photos/videos (comma-separated keys). */
        @JavascriptInterface
        public void share(String keys) {
            runOnUiThread(() -> shareItems(keys));
        }

        @JavascriptInterface
        public void trash(String keys) {
            runOnUiThread(() -> changeMedia(TRASH, keys));
        }

        @JavascriptInterface
        public void restore(String keys) {
            runOnUiThread(() -> changeMedia(RESTORE, keys));
        }

        @JavascriptInterface
        public void deleteForever(String keys) {
            runOnUiThread(() -> changeMedia(DELETE, keys));
        }

        /** Open the photo/video in another app (choose which). */
        @JavascriptInterface
        public void openWith(String key) {
            Uri uri = uriFor(key);
            if (uri == null) return;
            Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, key.charAt(0) == 'v' ? "video/*" : "image/*")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            runOnUiThread(() -> {
                try {
                    startActivity(Intent.createChooser(view, "Open with"));
                } catch (ActivityNotFoundException e) {
                    /* nothing to open it with */
                }
            });
        }

        /** Light or dark status and navigation bars, to match the gallery's theme. */
        @JavascriptInterface
        public void setLightBars(boolean light) {
            runOnUiThread(() -> {
                int bg = light ? 0xFFF2F3F5 : 0xFF000000;
                getWindow().setStatusBarColor(bg);
                getWindow().setNavigationBarColor(bg);
                WindowInsetsController bars = getWindow().getInsetsController();
                if (bars != null) {
                    int flags = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                    bars.setSystemBarsAppearance(light ? flags : 0, flags);
                }
            });
        }

        /** True when Android lets the app delete without asking each time. */
        @JavascriptInterface
        public boolean canSkipConfirm() {
            return Build.VERSION.SDK_INT < 31 || MediaStore.canManageMedia(MainActivity.this);
        }

        /** Open the setting that lets the app delete without asking each time. */
        @JavascriptInterface
        public void openManageMedia() {
            if (Build.VERSION.SDK_INT < 31) return;
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Settings.ACTION_REQUEST_MANAGE_MEDIA, Uri.parse("package:" + getPackageName())));
                } catch (ActivityNotFoundException e) {
                    /* not available on this phone */
                }
            });
        }

        /** Save the albums backup to the phone's Downloads folder. */
        @JavascriptInterface
        public boolean saveFile(String name, String text) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, "application/json");
            try {
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) return false;
                try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                    if (out == null) return false;
                    out.write(text.getBytes(StandardCharsets.UTF_8));
                }
                return true;
            } catch (IOException | SecurityException e) {
                return false;
            }
        }
    }
}
