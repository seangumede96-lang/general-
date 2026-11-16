package app.roost

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK

/**
 * App-private lock. Everything lives in this app's own storage:
 *  - the passcode is a salted hash in SharedPreferences
 *  - fingerprint is a plain BiometricPrompt check against fingerprints already on the phone
 *
 * Deliberately NOT used: DEVICE_CREDENTIAL, KeyguardManager, Keystore keys with
 * setUserAuthenticationRequired, DevicePolicyManager. Those are the things that tie an app
 * to the phone's screen lock; without them Android has no reason to demand one.
 */
object AppLock {
    private const val MAX_FREE_ATTEMPTS = 5

    private lateinit var prefs: SharedPreferences

    /** True while the UI must stay behind the lock screen. */
    @Volatile
    var locked = false
        private set

    /** Set before launching a picker we expect to return from, so it doesn't re-lock. */
    @Volatile
    var skipNextBackground = false

    fun init(context: Context) {
        prefs = context.getSharedPreferences("lock", Context.MODE_PRIVATE)
        locked = enabled
    }

    val enabled: Boolean get() = prefs.contains("hash")

    var biometricEnabled: Boolean
        get() = enabled && prefs.getBoolean("biometric", false)
        set(value) = prefs.edit().putBoolean("biometric", value).apply()

    fun setPin(pin: String) {
        require(PinHasher.isValidPin(pin))
        val salt = PinHasher.newSalt()
        prefs.edit()
            .putString("salt", b64(salt))
            .putString("hash", b64(PinHasher.hash(pin, salt)))
            .putInt("fails", 0).putLong("lockoutUntil", 0)
            .apply()
    }

    fun disable() {
        prefs.edit().clear().apply()
        locked = false
    }

    /** Milliseconds the user still has to wait after too many wrong passcodes, or 0. */
    fun lockoutRemainingMs(): Long =
        (prefs.getLong("lockoutUntil", 0) - System.currentTimeMillis()).coerceAtLeast(0)

    fun checkPin(pin: String): Boolean {
        if (lockoutRemainingMs() > 0) return false
        val salt = unb64(prefs.getString("salt", null) ?: return false)
        val hash = unb64(prefs.getString("hash", null) ?: return false)
        if (PinHasher.matches(pin, salt, hash)) {
            prefs.edit().putInt("fails", 0).putLong("lockoutUntil", 0).apply()
            return true
        }
        val fails = prefs.getInt("fails", 0) + 1
        val edit = prefs.edit().putInt("fails", fails)
        if (fails >= MAX_FREE_ATTEMPTS) {
            // 30s, 1m, 2m, 4m ... capped at 30 minutes
            val steps = (fails - MAX_FREE_ATTEMPTS).coerceAtMost(6)
            val wait = (30_000L shl steps).coerceAtMost(30 * 60_000L)
            edit.putLong("lockoutUntil", System.currentTimeMillis() + wait)
        }
        edit.apply()
        return false
    }

    fun unlock() { locked = false }

    fun onAppBackgrounded() {
        if (skipNextBackground) { skipNextBackground = false; return }
        if (enabled) locked = true
    }

    /** BIOMETRIC_SUCCESS only when a fingerprint/face is already enrolled on the phone. */
    fun biometricStatus(context: Context): Int =
        BiometricManager.from(context).canAuthenticate(BIOMETRIC_WEAK)

    fun biometricUsable(context: Context): Boolean =
        biometricEnabled && biometricStatus(context) == BiometricManager.BIOMETRIC_SUCCESS

    private fun b64(b: ByteArray) = Base64.encodeToString(b, Base64.NO_WRAP)
    private fun unb64(s: String) = Base64.decode(s, Base64.NO_WRAP)
}
