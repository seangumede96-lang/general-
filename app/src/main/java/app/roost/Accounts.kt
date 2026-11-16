package app.roost

import android.content.Context
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** One signed-in identity. [profile] names the isolated WebView profile holding its cookies. */
data class Account(val id: String, val name: String, val color: Int) {
    val profile: String get() = if (id == DEFAULT_ID) "Default" else "acct_$id"

    companion object { const val DEFAULT_ID = "default" }
}

object Accounts {
    private val palette = intArrayOf(
        0xFF4DA3FF.toInt(), 0xFFFF7A59.toInt(), 0xFF3DDC97.toInt(),
        0xFFB388FF.toInt(), 0xFFFFC857.toInt(), 0xFFFF5C8D.toInt(),
    )

    /** Isolated profiles need a reasonably recent Android System WebView. */
    val multiProfileSupported: Boolean
        get() = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)

    private fun prefs(c: Context) = c.getSharedPreferences("accounts", Context.MODE_PRIVATE)

    fun all(c: Context): List<Account> {
        val raw = prefs(c).getString("list", null)
            ?: return listOf(Account(Account.DEFAULT_ID, "Account 1", palette[0])).also { save(c, it) }
        val arr = JSONArray(raw)
        return List(arr.length()) { i ->
            arr.getJSONObject(i).let { Account(it.getString("id"), it.getString("name"), it.getInt("color")) }
        }
    }

    fun find(c: Context, id: String): Account? = all(c).firstOrNull { it.id == id }

    fun add(c: Context, name: String): Account {
        val list = all(c)
        // Reuse the built-in default profile if its slot was deleted earlier.
        val id = if (list.none { it.id == Account.DEFAULT_ID }) Account.DEFAULT_ID
        else UUID.randomUUID().toString().take(8)
        val acct = Account(id, name, palette[list.size % palette.size])
        save(c, list + acct)
        return acct
    }

    fun rename(c: Context, id: String, name: String) =
        save(c, all(c).map { if (it.id == id) it.copy(name = name) else it })

    fun remove(c: Context, id: String) = save(c, all(c).filter { it.id != id })

    private fun save(c: Context, list: List<Account>) {
        val arr = JSONArray()
        list.forEach { arr.put(JSONObject().put("id", it.id).put("name", it.name).put("color", it.color)) }
        prefs(c).edit().putString("list", arr.toString()).apply()
    }
}
