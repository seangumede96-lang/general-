package com.xbookmarks.gallery;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Set;

/**
 * X (x.com) in a full-screen web view, with the Bookmarks Gallery built in.
 * The gallery is the same code as the browser extension: its scripts are
 * copied into this app's assets at build time and run on every x.com page.
 */
public class MainActivity extends Activity {

    private static final String START_URL = "https://x.com/i/bookmarks";
    private static final Set<String> X_ORIGINS = Collections.unmodifiableSet(
            new java.util.HashSet<>(java.util.Arrays.asList("https://x.com", "https://twitter.com")));
    private static final int PICK_FILE = 1;

    private WebView webView;
    private FrameLayout root;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private ValueCallback<Uri[]> fileCallback;
    private String galleryScript;
    private boolean documentStartSupported;

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
        // Look like the phone's normal Chrome so X treats this as a regular browser.
        s.setUserAgentString(s.getUserAgentString().replace("; wv", "").replaceAll("Version/\\S+ ", ""));

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new Bridge(this), "XbgAndroid");
        galleryScript = buildGalleryScript();

        // Run the gallery before X's own scripts, so it can see the bookmarks X loads.
        documentStartSupported = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
        if (documentStartSupported) {
            WebViewCompat.addDocumentStartJavaScript(webView, galleryScript, X_ORIGINS);
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isInApp(uri)) return false;
                openOutside(uri);
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                // Older Android System WebView: inject as early as we can instead.
                if (!documentStartSupported && isX(Uri.parse(url))) view.evaluateJavascript(galleryScript, null);
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

            // "Restore from backup" and any other file pickers.
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(pick, "Choose a file"), PICK_FILE);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            Uri link = getIntent() != null ? getIntent().getData() : null;
            webView.loadUrl(link != null && isX(link) ? link.toString() : START_URL);
        }
    }

    /** The extension's scripts, joined into one, with the app's storage in place of the extension's. */
    private String buildGalleryScript() {
        String inject = readAsset("inject.js");
        String content = readAsset("content.js");
        String styles = readAsset("styles.css");
        String shim = readAsset("app-shim.js");
        return "(function () {\n"
                + "if (window.top !== window || window.__xbgApp) return;\n"
                + "window.__xbgApp = true;\n"
                + inject + "\n"
                + shim + "\n"
                // Styles: add them as soon as the page has a root element.
                + "(function addStyles() {\n"
                + "  var css = " + jsString(styles) + ";\n"
                + "  var put = function () { var st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).appendChild(st); };\n"
                + "  if (document.documentElement) put(); else document.addEventListener('readystatechange', put, { once: true });\n"
                + "})();\n"
                // The gallery reads `chrome` for the extension API: hand it the app's version.
                + "(function (chrome) {\n" + content + "\n}).call(window, window.__xbgExt);\n"
                + "})();";
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (IOException e) {
            throw new IllegalStateException("Missing asset " + name, e);
        }
    }

    private static String jsString(String text) {
        StringBuilder sb = new StringBuilder("\"");
        for (char c : text.toCharArray()) {
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': break;
                case '<': sb.append("\\u003c"); break;
                default: sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    private static boolean isX(Uri uri) {
        String host = uri.getHost();
        return host != null && (host.equals("x.com") || host.endsWith(".x.com")
                || host.equals("twitter.com") || host.endsWith(".twitter.com"));
    }

    /** X itself, its media, and sign-in pages stay in the app; anything else opens outside. */
    private static boolean isInApp(Uri uri) {
        String host = uri.getHost();
        if (host == null) return false;
        return isX(uri) || host.endsWith("twimg.com") || host.equals("accounts.google.com")
                || host.equals("appleid.apple.com");
    }

    private void openOutside(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No app can open that link", Toast.LENGTH_SHORT).show();
        }
    }

    private void exitFullscreen() {
        if (fullscreenView == null) return;
        root.removeView(fullscreenView);
        fullscreenView = null;
        webView.setVisibility(View.VISIBLE);
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
        fullscreenCallback = null;
    }

    /** Back: leave full-screen video, else step back in the page (the gallery uses this to close the feed or selection), else leave the app. */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (fullscreenView != null) {
            exitFullscreen();
        } else if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Uri link = intent.getData();
        if (link != null && isX(link)) webView.loadUrl(link.toString());
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_FILE || fileCallback == null) return;
        Uri picked = resultCode == RESULT_OK && data != null ? data.getData() : null;
        fileCallback.onReceiveValue(picked != null ? new Uri[]{picked} : null);
        fileCallback = null;
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    /** What the gallery's scripts can call: storage for collections/settings, and saving backup files. */
    static final class Bridge {
        private final Context context;
        private final SharedPreferences prefs;

        Bridge(Context context) {
            this.context = context.getApplicationContext();
            this.prefs = context.getSharedPreferences("gallery", MODE_PRIVATE);
        }

        @JavascriptInterface
        public String get(String key) {
            return prefs.getString(key, null);
        }

        @JavascriptInterface
        public void set(String key, String json) {
            prefs.edit().putString(key, json).apply();
        }

        /** Save a text file (the collections backup) to the phone's Downloads folder. */
        @JavascriptInterface
        public boolean saveFile(String name, String text) {
            byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                    values.put(MediaStore.Downloads.MIME_TYPE, "application/json");
                    Uri uri = context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri == null) return false;
                    try (OutputStream out = context.getContentResolver().openOutputStream(uri)) {
                        if (out == null) return false;
                        out.write(bytes);
                    }
                } else {
                    File dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (dir == null) return false;
                    try (FileOutputStream out = new FileOutputStream(new File(dir, name))) {
                        out.write(bytes);
                    }
                }
                return true;
            } catch (IOException | SecurityException e) {
                return false;
            }
        }
    }
}
