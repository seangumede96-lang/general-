package app.roost

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult
import androidx.biometric.BiometricManager
import com.google.android.material.materialswitch.MaterialSwitch

class LockSettingsActivity : BaseActivity() {
    private lateinit var lockSwitch: MaterialSwitch
    private lateinit var fpSwitch: MaterialSwitch
    private lateinit var change: Button
    private lateinit var fpNote: TextView
    private var afterVerify: (() -> Unit)? = null

    private val setup = registerForActivityResult(StartActivityForResult()) { refresh() }
    private val verify = registerForActivityResult(StartActivityForResult()) {
        if (it.resultCode == RESULT_OK) afterVerify?.invoke()
        afterVerify = null
        refresh()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val d = resources.displayMetrics.density
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding((20 * d).toInt(), (12 * d).toInt(), (20 * d).toInt(), (12 * d).toInt())
        }
        lockSwitch = MaterialSwitch(this).apply { text = "Lock app with a 4-digit passcode"; minHeight = (56 * d).toInt() }
        change = Button(this).apply { text = "Change passcode" }
        fpSwitch = MaterialSwitch(this).apply { text = "Unlock with fingerprint"; minHeight = (56 * d).toInt() }
        fpNote = TextView(this)
        val about = TextView(this).apply {
            setPadding(0, (20 * d).toInt(), 0, 0)
            text = "The lock belongs to this app only. Your passcode is stored (hashed) inside the app " +
                "and is separate from your phone's screen lock. Roost never asks Android to set up, " +
                "change or require a screen lock."
        }
        listOf(lockSwitch, change, fpSwitch, fpNote, about).forEach(root::addView)
        setContentView(root)

        lockSwitch.setOnClickListener {
            if (lockSwitch.isChecked) setup.launch(pad(LockActivity.MODE_SETUP))
            else verified { AppLock.disable() }
        }
        change.setOnClickListener { verified { setup.launch(pad(LockActivity.MODE_SETUP)) } }
        fpSwitch.setOnClickListener { AppLock.biometricEnabled = fpSwitch.isChecked; refresh() }
    }

    override fun onResume() { super.onResume(); refresh() }

    private fun pad(mode: Int) = Intent(this, LockActivity::class.java).putExtra(LockActivity.EXTRA_MODE, mode)

    private fun verified(then: () -> Unit) {
        afterVerify = then
        verify.launch(pad(LockActivity.MODE_VERIFY))
    }

    private fun refresh() {
        val on = AppLock.enabled
        lockSwitch.isChecked = on
        change.isEnabled = on
        val status = AppLock.biometricStatus(this)
        val available = status == BiometricManager.BIOMETRIC_SUCCESS
        fpSwitch.isEnabled = on && available
        fpSwitch.isChecked = on && available && AppLock.biometricEnabled
        fpNote.text = when {
            available && !on -> "Turn on the passcode first; it is the fallback when the sensor can't read your finger."
            available -> ""
            status == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED ->
                "No fingerprint is saved on this phone, so only the passcode is available. " +
                    "Roost will not ask you to add one."
            else -> "This phone has no usable fingerprint sensor. The passcode still works."
        }
    }
}
