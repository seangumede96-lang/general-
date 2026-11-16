package app.roost

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat

/**
 * One account = one WebView bound to its own on-disk profile (cookies, localStorage, cache).
 * Sessions persist because nothing here ever clears them; cookies are flushed to disk whenever
 * the window leaves the foreground.
 */
class BrowserActivity : BaseActivity() {
    private lateinit var web: WebView
    private lateinit var cookies: CookieManager
    private lateinit var root: FrameLayout
    private lateinit var progress: ProgressBar
    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    private var pendingFiles: ValueCallback<Array<Uri>>? = null

    private val filePicker = registerForActivityResult(StartActivityForResult()) { result ->
        pendingFiles?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
        pendingFiles = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val acct = intent.data?.lastPathSegment?.let { Accounts.find(this, it) }
        if (acct == null) {
            Toast.makeText(this, "That account no longer exists", Toast.LENGTH_SHORT).show()
            finishAndRemoveTask()
            return
        }
        @Suppress("DEPRECATION") setTaskDescription(ActivityManager.TaskDescription(acct.name))

        web = WebView(this)
        // Must happen before the WebView is used for anything else.
        cookies = if (acct.id != Account.DEFAULT_ID && Accounts.multiProfileSupported) {
            val profile = ProfileStore.getInstance().getOrCreateProfile(acct.profile)
            WebViewCompat.setProfile(web, acct.profile)
            profile.cookieManager
        } else if (acct.id != Account.DEFAULT_ID) {
            // Without isolated profiles this would silently share account 1's login.
            Toast.makeText(this, "Update Android System WebView to use extra accounts", Toast.LENGTH_LONG).show()
            finishAndRemoveTask()
            return
        } else CookieManager.getInstance()
        cookies.setAcceptCookie(true)
        cookies.setAcceptThirdPartyCookies(web, true)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = true
            setSupportMultipleWindows(false)
            // The browser identity (user agent, client hints) is deliberately left untouched:
            // X refused sign-in when this WebView claimed to be Chrome.
        }
        web.webViewClient = Client()
        web.webChromeClient = Chrome()
        web.setDownloadListener { url, _, _, _, _ -> openExternally(Uri.parse(url)) }

        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100 }
        root = FrameLayout(this).apply {
            addView(web, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(progress, FrameLayout.LayoutParams(MATCH_PARENT, (3 * resources.displayMetrics.density).toInt()))
        }
        setContentView(root)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    fullscreenView != null -> exitFullscreen()
                    web.canGoBack() -> web.goBack()
                    else -> moveTaskToBack(true) // keep the session window alive
                }
            }
        })

        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) web.loadUrl(HOME)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::web.isInitialized) web.saveState(outState)
    }

    override fun onResume() { super.onResume(); if (::web.isInitialized) web.onResume() }

    override fun onPause() {
        super.onPause()
        if (::web.isInitialized) { web.onPause(); cookies.flush() }
    }

    override fun onDestroy() {
        if (::web.isInitialized) { cookies.flush(); root.removeView(web); web.destroy() }
        super.onDestroy()
    }

    private fun openExternally(uri: Uri) {
        try { startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)) }
        catch (e: ActivityNotFoundException) { Toast.makeText(this, "No app can open this link", Toast.LENGTH_SHORT).show() }
    }

    private fun exitFullscreen() {
        fullscreenView?.let(root::removeView)
        fullscreenView = null
        fullscreenCallback?.onCustomViewHidden()
        fullscreenCallback = null
        WindowCompat.getInsetsController(window, root).show(WindowInsetsCompat.Type.systemBars())
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            val scheme = uri.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") {
                // mailto:/tel: go out; intent:// and app links are dropped so the site can't
                // bounce this account into the official app.
                if (scheme == "mailto" || scheme == "tel") openExternally(uri)
                return true
            }
            if (!request.isForMainFrame || isInApp(uri.host.orEmpty())) return false
            openExternally(uri)
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) { progress.visibility = View.VISIBLE }
        override fun onPageFinished(view: WebView, url: String?) { progress.visibility = View.GONE; cookies.flush() }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            progress.progress = newProgress
            if (newProgress >= 100) progress.visibility = View.GONE
        }

        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            pendingFiles?.onReceiveValue(null)
            pendingFiles = callback
            return try {
                AppLock.skipNextBackground = true // coming back from the picker shouldn't re-lock
                filePicker.launch(params.createIntent())
                true
            } catch (e: ActivityNotFoundException) {
                AppLock.skipNextBackground = false
                pendingFiles = null
                false
            }
        }

        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            if (fullscreenView != null) { callback.onCustomViewHidden(); return }
            fullscreenView = view
            fullscreenCallback = callback
            view.setBackgroundColor(0xFF000000.toInt())
            root.addView(view, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            WindowCompat.getInsetsController(window, root).apply {
                systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                hide(WindowInsetsCompat.Type.systemBars())
            }
        }

        override fun onHideCustomView() = exitFullscreen()
    }

    companion object {
        private const val HOME = "https://x.com/home"

        // Hosts that stay inside the account window (the site itself plus its sign-in providers).
        private val inAppHosts = listOf("x.com", "twitter.com", "accounts.google.com", "appleid.apple.com")

        fun isInApp(host: String): Boolean {
            val h = host.lowercase()
            return inAppHosts.any { h == it || h.endsWith(".$it") }
        }

        fun uri(accountId: String): Uri = Uri.parse("roost://account/$accountId")

        fun intent(context: Context, accountId: String): Intent =
            Intent(Intent.ACTION_VIEW, uri(accountId), context, BrowserActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT)
    }
}
