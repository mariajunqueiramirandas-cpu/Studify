package com.studify.focus

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.Icon
import android.os.Build
import android.os.SystemClock
import android.widget.RemoteViews
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.max
import kotlin.math.min

/** What the focus notification shows: the session's phases, where it is and how long is left. */
data class FocusSnapshot(
  val kinds: List<String>,
  val phaseMs: List<Long>,
  val index: Int,
  val paused: Boolean,
  /** Epoch ms when the current phase ends (running only). */
  val phaseEndsAt: Long,
  /** Time left in the current phase. */
  val leftMs: Long,
) {
  val kind: String get() = kinds.getOrNull(index) ?: "focus"
  val isFocus: Boolean get() = kind == "focus"
  val currentMs: Long get() = phaseMs.getOrNull(index)?.coerceAtLeast(1) ?: 1
  val phaseFraction: Float get() = (1f - leftMs.toFloat() / currentMs).coerceIn(0f, 1f)
  val focusTotal: Int get() = kinds.count { it == "focus" }
  /** The focus block in progress, or the last finished one during a break (1-based). */
  val cycle: Int get() = kinds.take(index + 1).count { it == "focus" }.coerceAtLeast(1)
  val minutesLeft: Long get() = (leftMs + 59_999) / 60_000

  /** Changes when what the notification draws changes; the countdown itself is ticked by the system. */
  fun renderKey(night: Boolean): String = "$index|$paused|$minutesLeft|${if (paused) leftMs / 1000 else phaseEndsAt / 1000}|$night"
}

/**
 * The focus timer's notification in Studify's custom style (the same language as studify-notify's rich
 * notifications): a progress ring with the minutes left, the phase and cycle, a live countdown that the system
 * ticks, and in the expanded view the whole session as a timeline. On Android 16 it is a Live Update instead
 * (the platform's segmented progress, promoted to the status bar chip and the lock screen). Callers fall back to
 * [compat] and then to the plain notification when the system refuses one, so the timer is never invisible.
 */
class FocusNotification(private val context: Context, private val strings: FocusStrings) {
  private val density = min(context.resources.displayMetrics.density, 2f)
  val night =
    (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

  private val focusColor = if (night) 0xFFA5B4FC.toInt() else 0xFF4F46E5.toInt()
  private val breakColor = if (night) 0xFF5EEAD4.toInt() else 0xFF0D9488.toInt()
  private val textPrimary = if (night) 0xFFE5E7EB.toInt() else 0xFF111827.toInt()
  private val textSecondary = if (night) 0xFF9CA3AF.toInt() else 0xFF6B7280.toInt()
  private val track = if (night) 0x33FFFFFF else 0x1F000000

  class Action(val label: String, val intent: PendingIntent)

  fun title(s: FocusSnapshot): String = when (s.kind) {
    "break" -> strings.breakShort
    "long_break" -> strings.breakLong
    else -> strings.focus
  }

  fun text(s: FocusSnapshot): String {
    val cycle = strings.cycle.replace("{n}", "${s.cycle}").replace("{total}", "${s.focusTotal}")
    if (s.paused) return "${strings.paused} · $cycle"
    val at = SimpleDateFormat("HH:mm", Locale.forLanguageTag("pt-BR")).format(Date(s.phaseEndsAt))
    return "$cycle · ${strings.endsAt.replace("{time}", at)}"
  }

  private fun accent(s: FocusSnapshot): Int = if (s.isFocus) focusColor else breakColor

  /** Android 16 Live Update; null on older versions. */
  fun liveUpdate(channel: String, s: FocusSnapshot, open: PendingIntent?, actions: List<Action>): Notification? {
    if (Build.VERSION.SDK_INT < 36) return null
    return buildLiveUpdate(channel, s, open, actions)
  }

  @RequiresApi(36)
  private fun buildLiveUpdate(channel: String, s: FocusSnapshot, open: PendingIntent?, actions: List<Action>): Notification {
    // Segment lengths in seconds: the bar is the whole session, each phase in its color.
    val seconds = s.phaseMs.map { max(1, (it / 1000).toInt()) }
    val segments = s.kinds.mapIndexed { i, kind ->
      Notification.ProgressStyle.Segment(seconds[i]).setColor(if (kind == "focus") 0xFF6366F1.toInt() else 0xFF14B8A6.toInt())
    }
    val elapsed = seconds.take(s.index).sum() + ((s.currentMs - s.leftMs).coerceAtLeast(0) / 1000).toInt()
    val icon = Icon.createWithResource(context, R.drawable.studify_focus_ic)
    val style = Notification.ProgressStyle()
      .setStyledByProgress(true)
      .setProgressSegments(segments)
      .setProgress(elapsed.coerceIn(0, seconds.sum()))
      .setProgressTrackerIcon(icon)
    val b = Notification.Builder(context, channel)
      .setSmallIcon(R.drawable.studify_focus_ic)
      .setContentTitle(title(s))
      .setContentText(text(s))
      .setStyle(style)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setCategory(Notification.CATEGORY_PROGRESS)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setContentIntent(open)
      .setRequestPromotedOngoing(true)
    if (s.paused) {
      b.setShowWhen(false).setShortCriticalText(strings.paused)
    } else {
      // The status bar chip shows this countdown.
      b.setWhen(s.phaseEndsAt).setShowWhen(true).setUsesChronometer(true).setChronometerCountDown(true)
    }
    actions.forEach { b.addAction(Notification.Action.Builder(icon, it.label, it.intent).build()) }
    return b.build()
  }

  /** The custom layout (every Android version). */
  fun compat(channel: String, smallIcon: Int, s: FocusSnapshot, open: PendingIntent?, actions: List<Action>): Notification {
    val small = RemoteViews(context.packageName, R.layout.sf_collapsed)
    val big = RemoteViews(context.packageName, R.layout.sf_expanded)
    val color = accent(s)
    val center = if (s.minutesLeft >= 1) "${s.minutesLeft}" else "<1"
    // Paused: the countdown stands still and shows what is left.
    val base = SystemClock.elapsedRealtime() + s.leftMs
    for ((v, sizeDp) in listOf(small to 40f, big to 56f)) {
      v.setTextViewText(R.id.sf_title, title(s))
      v.setTextViewText(R.id.sf_text, text(s))
      v.setImageViewBitmap(R.id.sf_ring, ring(s.phaseFraction, if (s.paused) textSecondary else color, center, if (sizeDp > 40f) "min" else null, sizeDp))
      v.setChronometer(R.id.sf_chrono, base, null, !s.paused)
      v.setChronometerCountDown(R.id.sf_chrono, true)
    }
    big.setImageViewBitmap(R.id.sf_timeline, timeline(s))
    val b = NotificationCompat.Builder(context, channel)
      .setSmallIcon(smallIcon)
      .setContentTitle(title(s))
      .setContentText(text(s))
      .setColor(color)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setShowWhen(false)
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setContentIntent(open)
      .setStyle(NotificationCompat.DecoratedCustomViewStyle())
      .setCustomContentView(small)
      .setCustomBigContentView(big)
    actions.forEach { b.addAction(0, it.label, it.intent) }
    return b.build()
  }

  // ---------------------------------------------------------------- drawing

  private fun px(dp: Float): Float = dp * density

  private fun bitmap(wDp: Float, hDp: Float): Pair<Bitmap, Canvas> {
    val b = Bitmap.createBitmap(max(1, px(wDp).toInt()), max(1, px(hDp).toInt()), Bitmap.Config.ARGB_8888)
    return b to Canvas(b)
  }

  private fun paint(color: Int, sizeSp: Float = 0f, bold: Boolean = false): Paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    this.color = color
    if (sizeSp > 0) textSize = px(sizeSp)
    if (bold) typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
  }

  /** Progress ring with the minutes left in the middle. */
  private fun ring(fraction: Float, color: Int, center: String, sub: String?, sizeDp: Float): Bitmap {
    val (b, c) = bitmap(sizeDp, sizeDp)
    val s = px(sizeDp)
    val stroke = px(sizeDp / 9f)
    val r = RectF(stroke / 2, stroke / 2, s - stroke / 2, s - stroke / 2)
    val p = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeWidth = stroke
      strokeCap = Paint.Cap.ROUND
    }
    p.color = track
    c.drawArc(r, 0f, 360f, false, p)
    p.color = color
    val sweep = 360f * fraction.coerceIn(0f, 1f)
    if (sweep > 0f) c.drawArc(r, -90f, max(sweep, 4f), false, p)
    val t = paint(textPrimary, if (center.length > 2) sizeDp / 4.6f else sizeDp / 3.6f, true).apply { textAlign = Paint.Align.CENTER }
    val baseline = if (sub == null) s / 2 - (t.descent() + t.ascent()) / 2 else s / 2 + px(1f)
    c.drawText(center, s / 2, baseline, t)
    if (sub != null) {
      val u = paint(textSecondary, sizeDp / 7.5f).apply { textAlign = Paint.Align.CENTER }
      c.drawText(sub, s / 2, baseline + u.textSize + px(1f), u)
    }
    return b
  }

  /**
   * The session as one bar: a segment per phase sized by its length, focus in the accent and breaks in teal,
   * finished phases filled, the current one filled up to now with a marker.
   */
  private fun timeline(s: FocusSnapshot): Bitmap {
    val screenDp = context.resources.displayMetrics.widthPixels / context.resources.displayMetrics.density
    val wDp = (screenDp - 64f).coerceIn(220f, 380f)
    val (b, c) = bitmap(wDp, 34f)
    val w = px(wDp)
    val n = s.kinds.size
    val gap = px(3f)
    val minW = px(6f)
    val barTop = px(6f)
    val barH = px(8f)
    val total = s.phaseMs.sumOf { it.coerceAtLeast(1) }.toFloat()
    val usable = w - gap * (n - 1)
    // Proportional widths, but every phase stays visible.
    val raw = s.phaseMs.map { max(minW, usable * it.coerceAtLeast(1) / total) }
    val scale = usable / raw.sum()
    var left = 0f
    var marker: Pair<Float, Int>? = null
    s.kinds.forEachIndexed { i, kind ->
      val segW = raw[i] * scale
      val color = if (kind == "focus") focusColor else breakColor
      val rect = RectF(left, barTop, left + segW, barTop + barH)
      c.drawRoundRect(rect, barH / 2, barH / 2, paint(track))
      val fill = when {
        i < s.index -> 1f
        i == s.index -> s.phaseFraction
        else -> 0f
      }
      if (fill > 0f) c.drawRoundRect(RectF(left, barTop, left + max(segW * fill, barH), barTop + barH), barH / 2, barH / 2, paint(color))
      if (i == s.index) marker = (left + segW * fill) to color
      left += segW + gap
    }
    marker?.let { (x, color) ->
      val cx = x.coerceIn(px(6f), w - px(6f))
      c.drawCircle(cx, barTop + barH / 2, px(6f), paint(Color.WHITE))
      c.drawCircle(cx, barTop + barH / 2, px(4f), paint(color))
    }
    val label = paint(textSecondary, 11f)
    c.drawText(strings.cycle.replace("{n}", "${s.cycle}").replace("{total}", "${s.focusTotal}"), 0f, barTop + barH + px(16f), label)
    return b
  }
}
