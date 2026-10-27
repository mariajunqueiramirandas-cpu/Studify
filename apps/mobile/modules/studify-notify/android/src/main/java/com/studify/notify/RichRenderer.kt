package com.studify.notify

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.widget.RemoteViews
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.graphics.drawable.IconCompat
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import kotlin.math.roundToInt

/**
 * Builds and posts rich notifications (PLT-05, api.md §9.1). Every notification uses tag = key and one fixed
 * id, so a newer payload with the same key replaces the older one in place (live updates) without hash
 * collisions between keys. Templates with drawn parts use DecoratedCustomViewStyle: the system keeps its
 * header, actions and dark mode, and the content area is ours.
 */
object RichRenderer {
  const val ID = 0x57D1
  private const val SUMMARY_ID = 0x57D2
  const val ACTION = "com.studify.notify.ACTION"
  const val EXTRA_KEY = "key"
  const val EXTRA_ACTION_ID = "action_id"
  const val EXTRA_KIND = "kind"

  private val CHANNELS = mapOf(
    "reviews" to ("Revisões" to NotificationManager.IMPORTANCE_DEFAULT),
    "plan" to ("Plano de estudos" to NotificationManager.IMPORTANCE_DEFAULT),
    "class" to ("Turma" to NotificationManager.IMPORTANCE_DEFAULT),
    "processing" to ("Processamento" to NotificationManager.IMPORTANCE_LOW),
    "live" to ("Ao vivo" to NotificationManager.IMPORTANCE_LOW),
  )

  private fun nm(c: Context) = c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  /** Creates a channel the app has not created yet. Never changes an existing one: the student owns it. */
  fun ensureChannel(c: Context, id: String) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = nm(c)
    if (nm.getNotificationChannel(id) != null) return
    val (name, importance) = CHANNELS[id] ?: ("Studify" to NotificationManager.IMPORTANCE_DEFAULT)
    val channel = NotificationChannel(id, name, importance)
    if (id == "live") {
      channel.setSound(null, null)
      channel.enableVibration(false)
      channel.setShowBadge(false)
      channel.description = "Progresso de materiais, podcasts e correções enquanto acontecem."
    }
    nm.createNotificationChannel(channel)
  }

  /** Posts the payload. False when it is not a rich notification or notifications are off. */
  @SuppressLint("MissingPermission")
  fun show(c: Context, raw: JSONObject): Boolean {
    val p = RichPayload.parse(raw) ?: return false
    if (!NotificationManagerCompat.from(c).areNotificationsEnabled()) return false
    ensureChannel(c, p.channel)
    val notification = try {
      build(c, p)
    } catch (_: Exception) {
      // A drawing or style failure falls back to the plain notification: never lose the message.
      plain(c, p).build()
    }
    try {
      nm(c).notify(p.key, ID, notification)
    } catch (_: SecurityException) {
      return false
    }
    if (p.actions.any { it.kind == "snooze" || it.kind == "reveal" } || raw.optBoolean("revealed")) NotifyStore.saveShown(c, p.key, raw)
    p.group?.let { updateSummary(c, it, p.channel) }
    NotifyStore.listener?.invoke("shown", p.key)
    return true
  }

  fun cancel(c: Context, key: String) {
    val group = nm(c).activeNotifications.firstOrNull { it.tag == key && it.id == ID }?.notification?.group
    nm(c).cancel(key, ID)
    NotifyStore.forgetShown(c, key)
    group?.let { updateSummary(c, it, null) }
  }

  fun activeKeys(c: Context): List<String> = nm(c).activeNotifications.filter { it.id == ID && it.tag != null }.map { it.tag }

  // ---------------------------------------------------------------- building

  private fun build(c: Context, p: RichPayload): Notification {
    val progress = p.progress
    if (p.template == "progress" && progress != null && progress.state == "running" && Build.VERSION.SDK_INT >= 36) {
      return buildLiveUpdate(c, p, progress)
    }
    val b = base(c, p)
    when (p.template) {
      "digest" -> {
        val style = NotificationCompat.InboxStyle().setBigContentTitle(p.title)
        p.digest?.forEach { style.addLine(it) }
        if (p.body.isNotBlank()) style.setSummaryText(p.body)
        b.setStyle(style)
      }
      "message" -> {
        val m = p.message
        if (m != null) {
          val me = Person.Builder().setName("Você").build()
          val sender = Person.Builder().setName(m.sender).setIcon(IconCompat.createWithBitmap(Graphics(c).avatar(m.sender))).build()
          val style = NotificationCompat.MessagingStyle(me)
            .addMessage(m.text, System.currentTimeMillis(), sender)
          m.conversation?.let { style.setConversationTitle(it).setGroupConversation(true) }
          b.setStyle(style)
        } else {
          b.setStyle(NotificationCompat.BigTextStyle().bigText(p.body))
        }
      }
      "basic" -> b.setStyle(NotificationCompat.BigTextStyle().bigText(p.body))
      else -> custom(c, p, b)
    }
    return b.build()
  }

  private fun plain(c: Context, p: RichPayload): NotificationCompat.Builder =
    base(c, p).setStyle(NotificationCompat.BigTextStyle().bigText(p.body))

  private fun base(c: Context, p: RichPayload): NotificationCompat.Builder {
    val running = p.progress?.state == "running"
    val b = NotificationCompat.Builder(c, p.channel)
      .setSmallIcon(Glyphs.res(p.glyph))
      .setContentTitle(p.title)
      .setContentText(p.body)
      .setColor(p.accent)
      .setOnlyAlertOnce(true)
      .setAutoCancel(!running)
      .setOngoing(running)
      .setShowWhen(!running)
      .setContentIntent(openIntent(c, p.deepLink, p.key))
      .setCategory(category(p))
      .setPriority(if (p.channel == "live" || p.channel == "processing") NotificationCompat.PRIORITY_LOW else NotificationCompat.PRIORITY_DEFAULT)
    p.sub?.let { b.setSubText(it) }
    p.group?.let { b.setGroup(it) }
    p.actions.forEach { a -> b.addAction(0, a.label, actionIntent(c, p, a)) }
    return b
  }

  private fun category(p: RichPayload): String = when (p.template) {
    "progress" -> NotificationCompat.CATEGORY_PROGRESS
    "countdown", "goal", "card" -> NotificationCompat.CATEGORY_REMINDER
    "message", "duel" -> NotificationCompat.CATEGORY_SOCIAL
    else -> NotificationCompat.CATEGORY_RECOMMENDATION
  }

  /** Templates with drawn content: same collapsed/expanded layouts, filled per template. */
  private fun custom(c: Context, p: RichPayload, b: NotificationCompat.Builder) {
    val g = Graphics(c)
    val small = RemoteViews(c.packageName, R.layout.sn_collapsed)
    val big = RemoteViews(c.packageName, R.layout.sn_expanded)
    for (v in listOf(small, big)) {
      v.setTextViewText(R.id.sn_title, p.title)
      v.setTextViewText(R.id.sn_text, p.body)
    }
    var smallGraphic = g.badge(p.glyph, p.accent, 40f)
    var bigGraphic = g.badge(p.glyph, p.accent, 56f)

    when (p.template) {
      "progress" -> p.progress?.let { pr ->
        val pct = "${(pr.fraction * 100).roundToInt()}%"
        when (pr.state) {
          "done" -> {
            smallGraphic = g.badge("check", g.success, 40f)
            bigGraphic = g.badge("check", g.success, 56f)
          }
          "failed" -> {
            smallGraphic = g.badge("alert", g.danger, 40f)
            bigGraphic = g.badge("alert", g.danger, 56f)
          }
          else -> {
            smallGraphic = g.ring(pr.fraction, p.accent, pct, sizeDp = 40f)
            bigGraphic = g.ring(pr.fraction, p.accent, pct, sizeDp = 56f)
          }
        }
        big.setImageViewBitmap(R.id.sn_wide, g.segments(pr.steps, pr.fraction, p.accent))
        big.setViewVisibility(R.id.sn_wide, View.VISIBLE)
        eta(pr.etaS)?.let { e ->
          big.setTextViewText(R.id.sn_chips, e)
          big.setViewVisibility(R.id.sn_chips, View.VISIBLE)
        }
      }
      "countdown" -> p.countdown?.let { cd ->
        val now = System.currentTimeMillis()
        val (bigNum, unit) = tileParts(cd.targetAt, now)
        smallGraphic = g.tile(bigNum, unit, p.accent, 40f)
        bigGraphic = cd.readiness?.let { g.ring(it, p.accent, "${(it * 100).roundToInt()}%", "pronto", 56f) } ?: g.tile(bigNum, unit, p.accent, 56f)
        val chips = listOf(relative(cd.targetAt, now)) + cd.chips
        big.setTextViewText(R.id.sn_chips, chips.joinToString("  ·  "))
        big.setViewVisibility(R.id.sn_chips, View.VISIBLE)
        val left = cd.targetAt - now
        if (left in 1 until 24 * 3600_000L) {
          // A live countdown that the system ticks; no wakeups from us.
          val base = SystemClock.elapsedRealtime() + left
          small.setChronometer(R.id.sn_chrono, base, null, true)
          small.setChronometerCountDown(R.id.sn_chrono, true)
          small.setViewVisibility(R.id.sn_chrono, View.VISIBLE)
          big.setTextViewText(R.id.sn_chrono_label, cd.label)
          big.setChronometer(R.id.sn_chrono_big, base, null, true)
          big.setChronometerCountDown(R.id.sn_chrono_big, true)
          big.setViewVisibility(R.id.sn_chrono_row, View.VISIBLE)
        }
        // A countdown is stale shortly after its moment.
        b.setTimeoutAfter((cd.targetAt - now + 2 * 3600_000L).coerceAtLeast(60_000L))
      }
      "goal" -> p.goal?.let { gl ->
        val f = gl.doneMin.toFloat() / gl.goalMin
        smallGraphic = g.ring(f, p.accent, "${gl.doneMin}", sizeDp = 40f)
        bigGraphic = g.ring(f, p.accent, "${gl.doneMin}", "de ${gl.goalMin} min", 56f)
        trailing(small, "🔥 ${gl.streak}")
        val chips = mutableListOf("🔥 Sequência: ${gl.streak} ${if (gl.streak == 1) "dia" else "dias"}")
        if (gl.shields > 0) chips.add("🛡️ ${gl.shields} ${if (gl.shields == 1) "escudo" else "escudos"}")
        big.setTextViewText(R.id.sn_chips, chips.joinToString("  ·  "))
        big.setViewVisibility(R.id.sn_chips, View.VISIBLE)
      }
      "duel" -> p.duel?.let { d ->
        smallGraphic = g.avatar(d.them.name, 40f)
        bigGraphic = g.avatar(d.them.name, 56f)
        if (d.me.score != null && d.them.score != null) trailing(small, "${d.me.score} × ${d.them.score}")
        val center = when (d.state) {
          "your_turn" -> "Sua vez"
          "waiting" -> "Aguardando"
          "won" -> "Você venceu!"
          "lost" -> "Quase!"
          "draw" -> "Empate"
          else -> "VS"
        }
        big.setImageViewBitmap(R.id.sn_wide, g.duel(d.me, d.them, center, p.accent))
        big.setViewVisibility(R.id.sn_wide, View.VISIBLE)
        d.subject?.let {
          big.setTextViewText(R.id.sn_chips, it)
          big.setViewVisibility(R.id.sn_chips, View.VISIBLE)
        }
      }
      "score" -> p.score?.let { s ->
        val f = (s.value / s.max).toFloat()
        val value = fmt(s.value)
        smallGraphic = g.ring(f, p.accent, value, sizeDp = 40f)
        bigGraphic = g.ring(f, p.accent, value, "de ${fmt(s.max)}", 56f)
        s.delta?.let { d ->
          val text = (if (d > 0) "+" else "") + fmt(d)
          trailing(small, text, if (d >= 0) g.success else g.danger)
          trailing(big, text, if (d >= 0) g.success else g.danger)
        }
        if (s.breakdown.isNotEmpty()) {
          big.setImageViewBitmap(R.id.sn_wide, g.bars(s.breakdown, p.accent))
          big.setViewVisibility(R.id.sn_wide, View.VISIBLE)
        }
      }
      "card" -> p.card?.let { cd ->
        val revealed = p.raw.optBoolean("revealed")
        small.setTextViewText(R.id.sn_text, cd.front)
        val text = if (revealed && cd.back != null) "${cd.front}\n\n${cd.back}" else cd.front
        big.setTextViewText(R.id.sn_card, text)
        big.setViewVisibility(R.id.sn_card, View.VISIBLE)
        if (cd.due > 1) trailing(small, "${cd.due}")
      }
      "achievement" -> p.achievement?.let { a ->
        smallGraphic = g.medal(a.emoji, p.accent, 40f)
        bigGraphic = g.medal(a.emoji, p.accent, 56f)
        big.setTextViewText(R.id.sn_chips, a.criterion)
        big.setViewVisibility(R.id.sn_chips, View.VISIBLE)
      }
      "retro" -> p.retro?.let { r ->
        big.setImageViewBitmap(R.id.sn_wide, g.banner(r.headline, r.stats, p.accent))
        big.setViewVisibility(R.id.sn_wide, View.VISIBLE)
      }
      "media" -> p.media?.let { m ->
        val minutes = (m.durationS + 59) / 60
        trailing(small, "$minutes min")
        big.setImageViewBitmap(R.id.sn_wide, g.waveform(p.key.hashCode(), "$minutes min", p.accent))
        big.setViewVisibility(R.id.sn_wide, View.VISIBLE)
      }
    }
    small.setImageViewBitmap(R.id.sn_graphic, smallGraphic)
    big.setImageViewBitmap(R.id.sn_graphic, bigGraphic)
    b.setStyle(NotificationCompat.DecoratedCustomViewStyle())
      .setCustomContentView(small)
      .setCustomBigContentView(big)
  }

  private fun trailing(v: RemoteViews, text: String, color: Int? = null) {
    v.setTextViewText(R.id.sn_trailing, text)
    color?.let { v.setTextColor(R.id.sn_trailing, it) }
    v.setViewVisibility(R.id.sn_trailing, View.VISIBLE)
  }

  /**
   * Android 16 Live Update: the platform's progress tracker (segments per step, a point at each boundary,
   * the glyph riding the bar) promoted to the status bar chip and the lock screen, like a ride or delivery.
   */
  @RequiresApi(36)
  private fun buildLiveUpdate(c: Context, p: RichPayload, pr: ProgressBlock): Notification {
    val n = pr.steps.size
    val segment = 100 / n
    val g = Graphics(c)
    val segments = pr.steps.mapIndexed { i, s ->
      val length = if (i == n - 1) 100 - segment * (n - 1) else segment
      Notification.ProgressStyle.Segment(length).setColor(if (s.state == "failed") g.danger else p.accent)
    }
    val points = (1 until n).map { i -> Notification.ProgressStyle.Point(segment * i).setColor(p.accent) }
    val style = Notification.ProgressStyle()
      .setStyledByProgress(true)
      .setProgressSegments(segments)
      .setProgressPoints(points)
      .setProgress((pr.fraction * 100).roundToInt().coerceIn(0, 100))
      .setProgressTrackerIcon(Icon.createWithResource(c, Glyphs.res(p.glyph)))
    val b = Notification.Builder(c, "live")
      .setSmallIcon(Glyphs.res(p.glyph))
      .setContentTitle(p.title)
      .setContentText(p.body)
      .setStyle(style)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setCategory(Notification.CATEGORY_PROGRESS)
      .setContentIntent(openIntent(c, p.deepLink, p.key))
      .setRequestPromotedOngoing(true)
      .setShortCriticalText(eta(pr.etaS, short = true) ?: "${(pr.fraction * 100).roundToInt()}%")
    p.sub?.let { b.setSubText(it) }
    p.actions.forEach { a ->
      b.addAction(Notification.Action.Builder(Icon.createWithResource(c, Glyphs.res(p.glyph)), a.label, actionIntent(c, p, a)).build())
    }
    return b.build()
  }

  // ---------------------------------------------------------------- groups

  @SuppressLint("MissingPermission")
  private fun updateSummary(c: Context, group: String, channel: String?) {
    val nm = nm(c)
    val members = nm.activeNotifications.filter { it.id == ID && it.notification.group == group }
    val tag = "group:$group"
    if (members.size < 2) {
      nm.cancel(tag, SUMMARY_ID)
      return
    }
    val ch = channel ?: members.first().notification.channelId ?: "plan"
    val style = NotificationCompat.InboxStyle()
    members.take(6).forEach { m ->
      val title = m.notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: return@forEach
      style.addLine(title)
    }
    style.setSummaryText("${members.size} novidades")
    val summary = NotificationCompat.Builder(c, ch)
      .setSmallIcon(R.drawable.sn_glyph_sparkles)
      .setContentTitle("Studify")
      .setContentText("${members.size} novidades")
      .setStyle(style)
      .setGroup(group)
      .setGroupSummary(true)
      .setAutoCancel(true)
      .setOnlyAlertOnce(true)
      .build()
    try {
      nm.notify(tag, SUMMARY_ID, summary)
    } catch (_: SecurityException) {
      // notifications turned off meanwhile
    }
  }

  // ---------------------------------------------------------------- intents

  /** Opens the deep link (or the app), tagging it so the app can mark the inbox item as read. */
  fun openIntent(c: Context, deepLink: String?, key: String, requestSalt: String = "content"): PendingIntent? {
    val intent = if (deepLink != null) {
      val sep = if (deepLink.contains('?')) "&" else "?"
      Intent(Intent.ACTION_VIEW, Uri.parse("$deepLink${sep}notif=${Uri.encode(key)}")).setPackage(c.packageName)
    } else {
      c.packageManager.getLaunchIntentForPackage(c.packageName)
    } ?: return null
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return PendingIntent.getActivity(c, (key + requestSalt).hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun actionIntent(c: Context, p: RichPayload, a: RichAction): PendingIntent? {
    if (a.kind == "open") return openIntent(c, a.deepLink, p.key, a.id)
    val intent = Intent(c, NotifyActionReceiver::class.java)
      .setAction(ACTION)
      // The data URI keeps each action's PendingIntent distinct whatever the request codes are.
      .setData(Uri.parse("studify-notify://action/${Uri.encode(p.key)}/${Uri.encode(a.id)}"))
      .putExtra(EXTRA_KEY, p.key)
      .putExtra(EXTRA_ACTION_ID, a.id)
      .putExtra(EXTRA_KIND, a.kind)
    return PendingIntent.getBroadcast(c, (p.key + a.id).hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  // ---------------------------------------------------------------- text helpers (PT-BR)

  private fun fmt(v: Double): String = if (v == Math.floor(v)) v.toLong().toString() else String.format(Locale.forLanguageTag("pt-BR"), "%.1f", v)

  private fun eta(seconds: Int?, short: Boolean = false): String? {
    seconds ?: return null
    val min = (seconds + 59) / 60
    return when {
      seconds < 60 -> if (short) "<1 min" else "Falta menos de 1 minuto"
      min < 60 -> if (short) "$min min" else "Faltam cerca de $min min"
      else -> if (short) "${min / 60} h" else "Faltam cerca de ${min / 60} h"
    }
  }

  private fun dayDiff(target: Long, now: Long): Int {
    val a = Calendar.getInstance().apply { timeInMillis = now; set(Calendar.HOUR_OF_DAY, 12); set(Calendar.MINUTE, 0) }
    val b = Calendar.getInstance().apply { timeInMillis = target; set(Calendar.HOUR_OF_DAY, 12); set(Calendar.MINUTE, 0) }
    return ((b.timeInMillis - a.timeInMillis) / 86_400_000.0).roundToInt()
  }

  /** "amanhã às 08:00", "em 3 dias", "hoje às 14:30", "em 20 min". */
  fun relative(target: Long, now: Long): String {
    val left = target - now
    if (left <= 0) return "agora"
    if (left < 3600_000L) return "em ${(left / 60_000L).coerceAtLeast(1)} min"
    val hm = SimpleDateFormat("HH:mm", Locale.forLanguageTag("pt-BR")).format(Date(target))
    return when (val d = dayDiff(target, now)) {
      0 -> "hoje às $hm"
      1 -> "amanhã às $hm"
      else -> "em $d dias"
    }
  }

  /** Big number and unit for the countdown tile. */
  fun tileParts(target: Long, now: Long): Pair<String, String> {
    val left = target - now
    if (left <= 0) return "!" to "agora"
    val d = dayDiff(target, now)
    return when {
      d >= 1 -> "$d" to if (d == 1) "dia" else "dias"
      left >= 3600_000L -> "${left / 3600_000L}" to "h"
      else -> "${(left / 60_000L).coerceAtLeast(1)}" to "min"
    }
  }

  /** The card's back with the two rating buttons, after "Ver resposta" (MEM-02, like the widget). */
  fun revealed(raw: JSONObject): JSONObject {
    val copy = JSONObject(raw.toString())
    copy.put("revealed", true)
    copy.put(
      "actions",
      JSONArray()
        .put(JSONObject().put("id", "again").put("label", "Errei").put("kind", "rate_again"))
        .put(JSONObject().put("id", "good").put("label", "Acertei").put("kind", "rate_good")),
    )
    return copy
  }
}
