package com.studify.focus

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Shared state between the foreground service and the JS module. Actions the student takes outside the app
 * (notification buttons, the blocking overlay) are queued here with their time, so the JS focus store can replay
 * them even when the JS runtime was not alive when they happened. Only aggregate counts are kept (WEL-02.5).
 */
object FocusBridge {
  private const val PREFS = "studify_focus"
  private const val KEY_ACTIONS = "actions"
  private const val KEY_BLOCKED = "blocked_attempts"
  private const val KEY_SESSION = "session_id"
  private const val KEY_DND_PREVIOUS = "dnd_previous"

  /** Set by the module while the JS runtime is alive; tells JS to call consumeActions(). */
  @Volatile
  var listener: (() -> Unit)? = null

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  @Synchronized
  fun record(context: Context, action: String, at: Long) {
    val p = prefs(context)
    val list = JSONArray(p.getString(KEY_ACTIONS, "[]"))
    list.put(JSONObject().put("action", action).put("at", at))
    p.edit().putString(KEY_ACTIONS, list.toString()).apply()
    listener?.invoke()
  }

  @Synchronized
  fun consume(context: Context): List<Map<String, Any>> {
    val p = prefs(context)
    val list = JSONArray(p.getString(KEY_ACTIONS, "[]"))
    p.edit().putString(KEY_ACTIONS, "[]").apply()
    val out = ArrayList<Map<String, Any>>(list.length())
    for (i in 0 until list.length()) {
      val o = list.getJSONObject(i)
      out.add(mapOf("action" to o.getString("action"), "at" to o.getLong("at").toDouble()))
    }
    return out
  }

  /** A new session id resets the blocked-attempt counter and drops actions of an older session. */
  @Synchronized
  fun beginSession(context: Context, sessionId: String) {
    val p = prefs(context)
    if (p.getString(KEY_SESSION, null) == sessionId) return
    p.edit().putString(KEY_SESSION, sessionId).putInt(KEY_BLOCKED, 0).putString(KEY_ACTIONS, "[]").apply()
  }

  @Synchronized
  fun incrementBlocked(context: Context) {
    val p = prefs(context)
    p.edit().putInt(KEY_BLOCKED, p.getInt(KEY_BLOCKED, 0) + 1).apply()
  }

  fun blockedAttempts(context: Context): Int = prefs(context).getInt(KEY_BLOCKED, 0)

  /** The interruption filter in place before Studify turned on Não perturbe (-1 = nothing to restore). */
  fun saveDndPrevious(context: Context, filter: Int) {
    prefs(context).edit().putInt(KEY_DND_PREVIOUS, filter).apply()
  }

  fun takeDndPrevious(context: Context): Int {
    val p = prefs(context)
    val v = p.getInt(KEY_DND_PREVIOUS, -1)
    p.edit().remove(KEY_DND_PREVIOUS).apply()
    return v
  }
}
