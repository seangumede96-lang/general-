package app.roost

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity

/** Any screen that must sit behind the app lock. */
abstract class BaseActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applyRecentsPrivacy()
    }

    override fun onResume() {
        super.onResume()
        applyRecentsPrivacy()
        val content = findViewById<View>(android.R.id.content)
        if (AppLock.locked) {
            content.visibility = View.INVISIBLE
            startActivity(Intent(this, LockActivity::class.java).putExtra(LockActivity.EXTRA_MODE, LockActivity.MODE_UNLOCK))
            @Suppress("DEPRECATION") overridePendingTransition(0, 0)
        } else {
            content.visibility = View.VISIBLE
        }
    }

    /** Keep the timeline out of the Recents thumbnail while a lock is set (Android 13+). */
    private fun applyRecentsPrivacy() {
        if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(!AppLock.enabled)
    }
}
