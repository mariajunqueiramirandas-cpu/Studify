package com.studify.notify

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * SharedPreferences behind the module. Holds the payload of each shown notification that has buttons
 * needing it later (reveal, snooze), the scheduled notifications (re-armed after a reboot), and the actions
 * taken outside the app, which the app replays (ratings become reviews; the app owns SQLite).
 */
object NotifyStore {
  private const val PREFS = "studify_notify"
  private const val SHOWN = "shown:"
  private const val SCHED = "sched:"
  private const val ACTIONS = "actions"
  private const val MAX_ACTIONS = 200

  /** Set by the module while the JS runtime is alive. */
  @Volatile
  var listener: ((type: String, key: String) -> Unit)? = null

  private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun saveShown(c: Context, key: String, raw: JSONObject) {
    prefs(c).edit().putString(SHOWN + key, raw.toString()).apply()
  }

  fun shown(c: Context, key: String): JSONObject? = prefs(c).getString(SHOWN + key, null)?.let { runCatching { JSONObject(it) }.getOrNull() }

  fun forgetShown(c: Context, key: String) {
    prefs(c).edit().remove(SHOWN + key).apply()
  }

  // ---------- scheduled ----------

  fun saveScheduled(c: Context, id: String, at: Long, raw: JSONObject) {
    prefs(c).edit().putString(SCHED + id, JSONObject().put("at", at).put("payload", raw).toString()).apply()
  }

  fun scheduled(c: Context, id: String): Pair<Long, JSONObject>? {
    val s = prefs(c).getString(SCHED + id, null) ?: return null
    return runCatching {
      val o = JSONObject(s)
      o.getLong("at") to o.getJSONObject("payload")
    }.getOrNull()
  }

  fun scheduledIds(c: Context): List<String> = prefs(c).all.keys.filter { it.startsWith(SCHED) }.map { it.removePrefix(SCHED) }.sorted()

  fun removeScheduled(c: Context, id: String) {
    prefs(c).edit().remove(SCHED + id).apply()
  }

  // ---------- actions taken outside the app ----------

  @Synchronized
  fun recordAction(c: Context, kind: String, key: String, data: JSONObject = JSONObject()) {
    val p = prefs(c)
    val list = runCatching { JSONArray(p.getString(ACTIONS, "[]")) }.getOrDefault(JSONArray())
    list.put(JSONObject().put("kind", kind).put("key", key).put("at", System.currentTimeMillis()).put("data", data))
    // A phone that never opens the app again must not grow this forever.
    val trimmed = JSONArray()
    val from = maxOf(0, list.length() - MAX_ACTIONS)
    for (i in from until list.length()) trimmed.put(list.get(i))
    p.edit().putString(ACTIONS, trimmed.toString()).apply()
    listener?.invoke("action", key)
  }

  @Synchronized
  fun consumeActions(c: Context): List<Map<String, Any?>> {
    val p = prefs(c)
    val list = runCatching { JSONArray(p.getString(ACTIONS, "[]")) }.getOrDefault(JSONArray())
    p.edit().putString(ACTIONS, "[]").apply()
    return (0 until list.length()).mapNotNull { i ->
      val o = list.optJSONObject(i) ?: return@mapNotNull null
      val data = o.optJSONObject("data") ?: JSONObject()
      mapOf(
        "kind" to o.optString("kind"),
        "key" to o.optString("key"),
        "at" to o.optLong("at").toDouble(),
        "cardId" to data.optString("card_id").takeIf { it.isNotBlank() },
      )
    }
  }
}
