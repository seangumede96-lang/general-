package app.roost

import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import com.google.android.material.color.MaterialColors

/**
 * Passcode pad used three ways:
 *  UNLOCK - gate in front of the app (fingerprint offered if enabled)
 *  SETUP  - enter a new passcode twice
 *  VERIFY - confirm the current passcode before a settings change (RESULT_OK on success)
 */
class LockActivity : AppCompatActivity() {
    private var mode = MODE_UNLOCK
    private var entry = ""
    private var firstEntry: String? = null
    private lateinit var title: TextView
    private lateinit var message: TextView
    private lateinit var dots: List<View>
    private val handler = Handler(Looper.getMainLooper())
    private var promptShown = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        mode = intent.getIntExtra(EXTRA_MODE, MODE_UNLOCK)
        if (android.os.Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false)
        setContentView(buildUi())
        render()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Back must never dismiss the gate; leave the app instead.
                if (mode == MODE_UNLOCK) moveTaskToBack(true) else finish()
            }
        })
    }

    override fun onResume() {
        super.onResume()
        if (mode == MODE_UNLOCK) {
            if (!AppLock.locked) { finish(); return } // unlocked from another window
            if (!promptShown && AppLock.biometricUsable(this)) { promptShown = true; showBiometric() }
        }
        tickLockout()
    }

    override fun onPause() {
        super.onPause()
        handler.removeCallbacksAndMessages(null)
    }

    private fun showBiometric() {
        val prompt = BiometricPrompt(this, ContextCompat.getMainExecutor(this),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = success()
                // Errors/cancel just leave the passcode pad showing.
            })
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Unlock Roost")
            // Biometric only + our own fallback button. No DEVICE_CREDENTIAL, so the phone's
            // PIN/pattern/password is never involved.
            .setAllowedAuthenticators(BIOMETRIC_WEAK)
            .setNegativeButtonText(getString(R.string.use_passcode))
            .setConfirmationRequired(false)
            .build()
        prompt.authenticate(info)
    }

    private fun onDigit(d: Char) {
        if (AppLock.lockoutRemainingMs() > 0 && mode != MODE_SETUP) return
        if (entry.length >= 4) return
        entry += d
        render()
        if (entry.length == 4) handler.postDelayed({ submit() }, 120)
    }

    private fun submit() {
        val pin = entry
        entry = ""
        when (mode) {
            MODE_SETUP -> {
                val first = firstEntry
                if (first == null) {
                    firstEntry = pin
                    message.text = ""
                } else if (first == pin) {
                    AppLock.setPin(pin)
                    setResult(RESULT_OK)
                    finish()
                    return
                } else {
                    firstEntry = null
                    message.text = "Passcodes didn't match. Try again."
                }
            }
            else -> {
                // PBKDF2 is intentionally slow; keep it off the UI thread.
                Thread {
                    val ok = AppLock.checkPin(pin)
                    runOnUiThread {
                        if (isFinishing || isDestroyed) return@runOnUiThread
                        if (ok) success() else { message.text = "Wrong passcode"; tickLockout() }
                    }
                }.start()
            }
        }
        render()
    }

    private fun success() {
        if (mode == MODE_UNLOCK) AppLock.unlock()
        setResult(RESULT_OK)
        finish()
        @Suppress("DEPRECATION") overridePendingTransition(0, 0)
    }

    private fun tickLockout() {
        if (mode == MODE_SETUP) return
        val left = AppLock.lockoutRemainingMs()
        if (left > 0) {
            message.text = "Too many attempts. Try again in ${(left + 999) / 1000}s"
            handler.postDelayed({ tickLockout() }, 1000)
        } else if (message.text.startsWith("Too many")) {
            message.text = ""
        }
    }

    private fun render() {
        title.text = when {
            mode == MODE_SETUP && firstEntry == null -> "Choose a 4-digit passcode"
            mode == MODE_SETUP -> "Confirm passcode"
            mode == MODE_VERIFY -> "Enter current passcode"
            else -> "Enter passcode"
        }
        val on = MaterialColors.getColor(title, com.google.android.material.R.attr.colorPrimary)
        val off = MaterialColors.getColor(title, com.google.android.material.R.attr.colorOutline)
        dots.forEachIndexed { i, v ->
            (v.background as GradientDrawable).setColor(if (i < entry.length) on else Color.TRANSPARENT)
            (v.background as GradientDrawable).setStroke(dp(2), if (i < entry.length) on else off)
        }
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(24), dp(24), dp(24), dp(24))
        }
        title = TextView(this).apply { textSize = 20f; gravity = Gravity.CENTER }
        root.addView(title)

        val dotRow = LinearLayout(this).apply { gravity = Gravity.CENTER }
        dots = List(4) {
            View(this).apply {
                background = GradientDrawable().apply { shape = GradientDrawable.OVAL }
                layoutParams = LinearLayout.LayoutParams(dp(16), dp(16)).apply { setMargins(dp(10), dp(28), dp(10), dp(12)) }
            }.also(dotRow::addView)
        }
        root.addView(dotRow)

        message = TextView(this).apply { gravity = Gravity.CENTER; minHeight = dp(40) }
        root.addView(message)

        val grid = GridLayout(this).apply { columnCount = 3 }
        fun key(label: String, desc: String? = null, action: () -> Unit) = Button(
            this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle
        ).apply {
            text = label
            textSize = 22f
            contentDescription = desc ?: label
            layoutParams = GridLayout.LayoutParams().apply {
                width = dp(76); height = dp(76); setMargins(dp(8), dp(8), dp(8), dp(8))
            }
            setOnClickListener { action() }
        }
        "123456789".forEach { c -> grid.addView(key(c.toString()) { onDigit(c) }) }
        val showFp = mode == MODE_UNLOCK && AppLock.biometricUsable(this)
        grid.addView(key(if (showFp) "☝" else "", "Use fingerprint") { if (showFp) showBiometric() }.apply {
            if (!showFp) visibility = View.INVISIBLE
        })
        grid.addView(key("0") { onDigit('0') })
        grid.addView(key("⌫", "Delete") { entry = entry.dropLast(1); render() })
        root.addView(grid, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
        return root
    }

    companion object {
        const val EXTRA_MODE = "mode"
        const val MODE_UNLOCK = 0
        const val MODE_SETUP = 1
        const val MODE_VERIFY = 2
    }
}
