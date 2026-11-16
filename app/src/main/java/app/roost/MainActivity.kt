package app.roost

import android.app.ActivityManager
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.LayoutInflater
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.PopupMenu
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.webkit.ProfileStore
import com.google.android.material.dialog.MaterialAlertDialogBuilder

/** The account switcher: every row is an independent, permanently signed-in instance. */
class MainActivity : BaseActivity() {
    private val adapter = Adapter()
    private var accounts: List<Account> = emptyList()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        findViewById<RecyclerView>(R.id.list).apply {
            layoutManager = LinearLayoutManager(this@MainActivity)
            adapter = this@MainActivity.adapter
        }
        findViewById<View>(R.id.add).setOnClickListener { addAccount() }
    }

    override fun onResume() { super.onResume(); reload() }

    override fun onCreateOptionsMenu(menu: Menu): Boolean { menuInflater.inflate(R.menu.main, menu); return true }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        if (item.itemId == R.id.menu_lock) { startActivity(Intent(this, LockSettingsActivity::class.java)); return true }
        return super.onOptionsItemSelected(item)
    }

    private fun reload() { accounts = Accounts.all(this); adapter.notifyDataSetChanged() }

    private fun addAccount() {
        if (accounts.isNotEmpty() && !Accounts.multiProfileSupported) {
            MaterialAlertDialogBuilder(this)
                .setTitle("Update needed")
                .setMessage("Extra accounts need a newer \"Android System WebView\". Update it in the Play Store, then try again.")
                .setPositiveButton(android.R.string.ok, null).show()
            return
        }
        askName("New account", "Account ${accounts.size + 1}") { name ->
            val acct = Accounts.add(this, name)
            reload()
            open(acct)
        }
    }

    private fun open(acct: Account) = startActivity(BrowserActivity.intent(this, acct.id))

    private fun askName(title: String, initial: String, done: (String) -> Unit) {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS
            setText(initial); selectAll()
        }
        val pad = (20 * resources.displayMetrics.density).toInt()
        val box = FrameLayout(this).apply { setPadding(pad, pad / 2, pad, 0); addView(input) }
        MaterialAlertDialogBuilder(this).setTitle(title).setView(box)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                done(input.text.toString().trim().ifEmpty { initial })
            }
            .setNegativeButton(android.R.string.cancel, null).show()
    }

    private fun pinShortcut(acct: Account) {
        if (!ShortcutManagerCompat.isRequestPinShortcutSupported(this)) {
            Toast.makeText(this, "Your home screen doesn't support pinned shortcuts", Toast.LENGTH_LONG).show()
            return
        }
        val info = ShortcutInfoCompat.Builder(this, "acct_${acct.id}")
            .setShortLabel(acct.name)
            .setIcon(IconCompat.createWithBitmap(avatar(acct, 192)))
            .setIntent(BrowserActivity.intent(this, acct.id))
            .build()
        ShortcutManagerCompat.requestPinShortcut(this, info, null)
    }

    private fun confirmDelete(acct: Account) {
        MaterialAlertDialogBuilder(this)
            .setTitle("Delete \"${acct.name}\"?")
            .setMessage("This signs the account out and erases its saved session from this app.")
            .setPositiveButton("Delete") { _, _ -> delete(acct) }
            .setNegativeButton(android.R.string.cancel, null).show()
    }

    private fun delete(acct: Account) {
        // Close the account's window first; a profile can't be wiped while a WebView uses it.
        val target = BrowserActivity.uri(acct.id)
        getSystemService(ActivityManager::class.java).appTasks
            .filter { it.taskInfo.baseIntent.data == target }
            .forEach { it.finishAndRemoveTask() }
        Accounts.remove(this, acct.id)
        ShortcutManagerCompat.disableShortcuts(this, listOf("acct_${acct.id}"), "Account deleted")
        reload()
        Handler(Looper.getMainLooper()).postDelayed({ wipe(acct, retries = 5) }, 500)
    }

    private fun wipe(acct: Account, retries: Int) {
        try {
            if (acct.id == Account.DEFAULT_ID) {
                CookieManager.getInstance().apply { removeAllCookies(null); flush() }
                WebStorage.getInstance().deleteAllData()
            } else if (Accounts.multiProfileSupported) {
                ProfileStore.getInstance().deleteProfile(acct.profile)
            }
        } catch (e: IllegalStateException) {
            // Window still shutting down.
            if (retries > 0) Handler(Looper.getMainLooper()).postDelayed({ wipe(acct, retries - 1) }, 700)
        }
    }

    private fun avatar(acct: Account, size: Int): Bitmap {
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val p = Paint(Paint.ANTI_ALIAS_FLAG)
        p.color = acct.color
        c.drawCircle(size / 2f, size / 2f, size / 2f, p)
        p.color = Color.BLACK
        p.textSize = size * 0.5f
        p.textAlign = Paint.Align.CENTER
        p.isFakeBoldText = true
        val letter = acct.name.trim().take(1).uppercase().ifEmpty { "?" }
        c.drawText(letter, size / 2f, size / 2f - (p.descent() + p.ascent()) / 2, p)
        return bmp
    }

    private inner class Adapter : RecyclerView.Adapter<Holder>() {
        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
            Holder(LayoutInflater.from(parent.context).inflate(R.layout.item_account, parent, false))

        override fun getItemCount() = accounts.size

        override fun onBindViewHolder(h: Holder, position: Int) {
            val acct = accounts[position]
            h.name.text = acct.name
            h.avatar.setImageBitmap(avatar(acct, 132))
            h.itemView.setOnClickListener { open(acct) }
            h.more.setOnClickListener { v ->
                PopupMenu(this@MainActivity, v).apply {
                    inflate(R.menu.account)
                    setOnMenuItemClickListener {
                        when (it.itemId) {
                            R.id.acc_rename -> askName("Rename", acct.name) { n -> Accounts.rename(this@MainActivity, acct.id, n); reload() }
                            R.id.acc_shortcut -> pinShortcut(acct)
                            R.id.acc_delete -> confirmDelete(acct)
                        }
                        true
                    }
                }.show()
            }
        }
    }

    private class Holder(v: View) : RecyclerView.ViewHolder(v) {
        val avatar: ImageView = v.findViewById(R.id.avatar)
        val name: TextView = v.findViewById(R.id.name)
        val more: View = v.findViewById(R.id.more)
    }
}
