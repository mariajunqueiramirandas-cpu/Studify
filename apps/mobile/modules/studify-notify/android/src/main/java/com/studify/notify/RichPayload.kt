package com.studify.notify

import android.graphics.Color
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Locale

/**
 * Kotlin mirror of `RichNotificationSchema` (packages/shared/src/core/schemas/notifications.ts). Parsing is
 * lenient on purpose: the server validates before sending, and on the phone a block that does not parse is
 * dropped so the notification still shows as a plain one instead of disappearing.
 */
data class RichAction(val id: String, val label: String, val kind: String, val deepLink: String?, val snoozeMin: Int)

data class ProgressStep(val label: String, val state: String)

data class ProgressBlock(val steps: List<ProgressStep>, val fraction: Float, val state: String, val etaS: Int?)

data class CountdownBlock(val targetAt: Long, val label: String, val readiness: Float?, val chips: List<String>)

data class GoalBlock(val doneMin: Int, val goalMin: Int, val streak: Int, val shields: Int)

data class DuelSide(val name: String, val score: Int?)

data class DuelBlock(val me: DuelSide, val them: DuelSide, val state: String, val subject: String?)

data class ScoreBlock(val value: Double, val max: Double, val label: String, val delta: Double?, val breakdown: List<Pair<String, Float>>)

data class CardBlock(val cardId: String, val front: String, val back: String?, val due: Int, val subject: String?)

data class AchievementBlock(val name: String, val criterion: String, val emoji: String)

data class RetroBlock(val headline: String, val stats: List<Pair<String, String>>)

data class MediaBlock(val kind: String, val durationS: Int)

data class MessageBlock(val sender: String, val text: String, val conversation: String?)

data class RichPayload(
  val key: String,
  val template: String,
  val channel: String,
  val title: String,
  val body: String,
  val sub: String?,
  val glyph: String,
  val accent: Int,
  val deepLink: String?,
  val group: String?,
  val actions: List<RichAction>,
  val progress: ProgressBlock?,
  val countdown: CountdownBlock?,
  val goal: GoalBlock?,
  val duel: DuelBlock?,
  val score: ScoreBlock?,
  val card: CardBlock?,
  val achievement: AchievementBlock?,
  val retro: RetroBlock?,
  val media: MediaBlock?,
  val digest: List<String>?,
  val message: MessageBlock?,
  /** The JSON this payload came from, kept for snooze, reveal and scheduled delivery. */
  val raw: JSONObject,
) {
  companion object {
    const val DEFAULT_ACCENT = 0xFF4F46E5.toInt()
    private val CHANNELS = setOf("reviews", "plan", "class", "processing", "live")

    /** Null when the JSON is not a rich notification at all (no key, title or template). */
    fun parse(o: JSONObject): RichPayload? {
      val key = o.optString("key").takeIf { it.isNotBlank() } ?: return null
      val title = o.optString("title").takeIf { it.isNotBlank() } ?: return null
      val template = o.optString("template", "basic").ifBlank { "basic" }
      val channel = o.optString("channel", "plan").takeIf { it in CHANNELS } ?: "plan"
      val accent = runCatching { Color.parseColor(o.optString("accent")) }.getOrDefault(DEFAULT_ACCENT)
      return RichPayload(
        key = key.take(80),
        template = template,
        channel = channel,
        title = title.take(80),
        body = o.optString("body").take(240),
        sub = o.optString("sub").takeIf { it.isNotBlank() }?.take(60),
        glyph = o.optString("glyph", "sparkles").ifBlank { "sparkles" },
        accent = accent,
        deepLink = o.optString("deep_link").takeIf { it.startsWith("studify://") },
        group = o.optString("group").takeIf { it.isNotBlank() },
        actions = actions(o.optJSONArray("actions")),
        progress = safe { progress(o.optJSONObject("progress")) },
        countdown = safe { countdown(o.optJSONObject("countdown")) },
        goal = safe { goal(o.optJSONObject("goal")) },
        duel = safe { duel(o.optJSONObject("duel")) },
        score = safe { score(o.optJSONObject("score")) },
        card = safe { card(o.optJSONObject("card")) },
        achievement = safe { achievement(o.optJSONObject("achievement")) },
        retro = safe { retro(o.optJSONObject("retro")) },
        media = safe { media(o.optJSONObject("media")) },
        digest = safe { o.optJSONObject("digest")?.optJSONArray("lines")?.let { strings(it) }?.takeIf { it.isNotEmpty() } },
        message = safe { message(o.optJSONObject("message")) },
        raw = o,
      )
    }

    /** ISO 8601 with offset, with or without milliseconds (java.time needs API 26; minSdk is 24). */
    fun parseIso(input: String): Long? {
      // Microseconds (Postgres) are cut to milliseconds; SimpleDateFormat reads exactly three digits.
      val s = input.replace(Regex("\\.(\\d{3})\\d+"), ".$1")
      for (pattern in listOf("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", "yyyy-MM-dd'T'HH:mm:ssXXX")) {
        try {
          val f = SimpleDateFormat(pattern, Locale.US)
          f.isLenient = false
          return f.parse(s)?.time
        } catch (_: Exception) {
          // next pattern
        }
      }
      return null
    }

    private inline fun <T> safe(block: () -> T?): T? = try {
      block()
    } catch (_: Exception) {
      null
    }

    private fun strings(a: JSONArray): List<String> = (0 until a.length()).mapNotNull { a.optString(it).takeIf { s -> s.isNotBlank() } }

    private fun actions(a: JSONArray?): List<RichAction> {
      if (a == null) return emptyList()
      return (0 until a.length()).mapNotNull { i ->
        val x = a.optJSONObject(i) ?: return@mapNotNull null
        val id = x.optString("id").takeIf { it.isNotBlank() } ?: return@mapNotNull null
        val label = x.optString("label").takeIf { it.isNotBlank() } ?: return@mapNotNull null
        val kind = x.optString("kind")
        val link = x.optString("deep_link").takeIf { it.startsWith("studify://") }
        if (kind == "open" && link == null) return@mapNotNull null
        RichAction(id, label.take(28), kind, link, x.optInt("snooze_min", 60).coerceIn(5, 240))
      }.distinctBy { it.id }.take(3)
    }

    private fun progress(o: JSONObject?): ProgressBlock? {
      o ?: return null
      val a = o.optJSONArray("steps") ?: return null
      val steps = (0 until a.length()).mapNotNull { i ->
        val s = a.optJSONObject(i) ?: return@mapNotNull null
        ProgressStep(s.optString("label").take(24), s.optString("state", "pending"))
      }.take(6)
      if (steps.isEmpty()) return null
      val eta = if (o.has("eta_s")) o.optInt("eta_s") else null
      return ProgressBlock(steps, o.optDouble("fraction", 0.0).toFloat().coerceIn(0f, 1f), o.optString("state", "running"), eta)
    }

    private fun countdown(o: JSONObject?): CountdownBlock? {
      o ?: return null
      val at = parseIso(o.getString("target_at")) ?: return null
      val readiness = if (o.has("readiness")) o.optDouble("readiness").toFloat().coerceIn(0f, 1f) else null
      return CountdownBlock(at, o.optString("label").take(40), readiness, o.optJSONArray("chips")?.let { strings(it) }?.take(4) ?: emptyList())
    }

    private fun goal(o: JSONObject?): GoalBlock? {
      o ?: return null
      return GoalBlock(o.getInt("done_min"), o.getInt("goal_min").coerceAtLeast(1), o.optInt("streak"), o.optInt("shields").coerceIn(0, 2))
    }

    private fun side(o: JSONObject): DuelSide = DuelSide(o.getString("name").take(40), if (o.has("score")) o.optInt("score") else null)

    private fun duel(o: JSONObject?): DuelBlock? {
      o ?: return null
      return DuelBlock(side(o.getJSONObject("me")), side(o.getJSONObject("them")), o.optString("state", "challenge"), o.optString("subject").takeIf { it.isNotBlank() })
    }

    private fun score(o: JSONObject?): ScoreBlock? {
      o ?: return null
      val b = o.optJSONArray("breakdown")
      val breakdown = if (b == null) emptyList() else (0 until b.length()).mapNotNull { i ->
        val x = b.optJSONObject(i) ?: return@mapNotNull null
        x.optString("label").take(20) to x.optDouble("value", 0.0).toFloat().coerceIn(0f, 1f)
      }.take(5)
      val delta = if (o.has("delta")) o.optDouble("delta") else null
      return ScoreBlock(o.getDouble("value"), o.getDouble("max").coerceAtLeast(1.0), o.optString("label").take(40), delta, breakdown)
    }

    private fun card(o: JSONObject?): CardBlock? {
      o ?: return null
      return CardBlock(o.getString("card_id"), o.getString("front").take(200), o.optString("back").takeIf { it.isNotBlank() }?.take(300), o.optInt("due"), o.optString("subject").takeIf { it.isNotBlank() })
    }

    private fun achievement(o: JSONObject?): AchievementBlock? {
      o ?: return null
      return AchievementBlock(o.getString("name").take(40), o.optString("criterion").take(120), o.optString("emoji", "🏆").ifBlank { "🏆" })
    }

    private fun retro(o: JSONObject?): RetroBlock? {
      o ?: return null
      val a = o.optJSONArray("stats") ?: return null
      val stats = (0 until a.length()).mapNotNull { i ->
        val x = a.optJSONObject(i) ?: return@mapNotNull null
        x.optString("label").take(24) to x.optString("value").take(16)
      }.take(3)
      return RetroBlock(o.getString("headline").take(60), stats)
    }

    private fun media(o: JSONObject?): MediaBlock? {
      o ?: return null
      return MediaBlock(o.optString("kind", "podcast"), o.getInt("duration_s").coerceAtLeast(1))
    }

    private fun message(o: JSONObject?): MessageBlock? {
      o ?: return null
      return MessageBlock(o.getString("sender").take(40), o.getString("text").take(240), o.optString("conversation").takeIf { it.isNotBlank() })
    }
  }
}
