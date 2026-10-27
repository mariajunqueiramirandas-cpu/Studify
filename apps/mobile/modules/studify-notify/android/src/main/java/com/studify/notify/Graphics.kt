package com.studify.notify

import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import androidx.core.content.ContextCompat
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * The drawn parts of the custom notifications: rings, the segmented live tracker, the duel card, score bars,
 * the podcast waveform and the Retrospectiva banner. RemoteViews cannot draw shapes, so these are bitmaps.
 * They are rendered at most at 2× density: every bitmap travels inside the notification parcel, and a
 * full-density wide bitmap would push it toward the binder size limit.
 */
class Graphics(private val context: Context) {
  private val density = min(context.resources.displayMetrics.density, 2f)
  private val night =
    (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

  val textPrimary = if (night) 0xFFE5E7EB.toInt() else 0xFF111827.toInt()
  val textSecondary = if (night) 0xFF9CA3AF.toInt() else 0xFF6B7280.toInt()
  private val track = if (night) 0x33FFFFFF else 0x1F000000
  val danger = if (night) 0xFFF87171.toInt() else 0xFFDC2626.toInt()
  val success = if (night) 0xFF4ADE80.toInt() else 0xFF16A34A.toInt()

  fun px(dp: Float): Float = dp * density

  private fun bitmap(wDp: Float, hDp: Float): Pair<Bitmap, Canvas> {
    val b = Bitmap.createBitmap(max(1, px(wDp).toInt()), max(1, px(hDp).toInt()), Bitmap.Config.ARGB_8888)
    return b to Canvas(b)
  }

  /** Width of the wide graphics: the notification content width, capped so tablets do not get huge bitmaps. */
  fun wideDp(): Float {
    val screenDp = context.resources.displayMetrics.widthPixels / context.resources.displayMetrics.density
    return (screenDp - 64f).coerceIn(220f, 380f)
  }

  private fun paint(color: Int, sizeSp: Float = 0f, bold: Boolean = false): Paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    this.color = color
    if (sizeSp > 0) textSize = px(sizeSp)
    if (bold) typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
  }

  private fun fitText(text: String, p: Paint, maxWidth: Float): String {
    if (p.measureText(text) <= maxWidth) return text
    var end = text.length
    while (end > 1 && p.measureText(text.substring(0, end) + "…") > maxWidth) end--
    return text.substring(0, end) + "…"
  }

  /** Accent-colored circle with a white glyph: the default graphic of every template. */
  fun badge(glyph: String, accent: Int, sizeDp: Float = 40f): Bitmap {
    val (b, c) = bitmap(sizeDp, sizeDp)
    val s = px(sizeDp)
    c.drawCircle(s / 2, s / 2, s / 2, paint(accent))
    ContextCompat.getDrawable(context, Glyphs.res(glyph))?.mutate()?.let { d ->
      d.setTint(Color.WHITE)
      val inset = (s * 0.24f).toInt()
      d.setBounds(inset, inset, s.toInt() - inset, s.toInt() - inset)
      d.draw(c)
    }
    return b
  }

  /** Progress ring with a center label ("12/20", "68%", "840"). */
  fun ring(fraction: Float, color: Int, center: String, sub: String? = null, sizeDp: Float = 56f): Bitmap {
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
    val t = paint(textPrimary, if (center.length > 4) sizeDp / 5.2f else sizeDp / 4.2f, true).apply { textAlign = Paint.Align.CENTER }
    val baseline = if (sub == null) s / 2 - (t.descent() + t.ascent()) / 2 else s / 2 - px(1f)
    c.drawText(center, s / 2, baseline, t)
    if (sub != null) {
      val u = paint(textSecondary, sizeDp / 8f).apply { textAlign = Paint.Align.CENTER }
      c.drawText(sub, s / 2, baseline + u.textSize + px(1f), u)
    }
    return b
  }

  /** Calendar-like tile for countdowns: a big number over its unit ("2" / "dias"). */
  fun tile(big: String, unit: String, accent: Int, sizeDp: Float = 56f): Bitmap {
    val (b, c) = bitmap(sizeDp, sizeDp)
    val s = px(sizeDp)
    val r = px(12f)
    c.drawRoundRect(RectF(0f, 0f, s, s), r, r, paint(accent))
    c.drawRoundRect(RectF(0f, 0f, s, s * 0.28f), r, r, paint(0x33000000))
    c.drawRect(RectF(0f, s * 0.14f, s, s * 0.28f), paint(accent))
    val t = paint(Color.WHITE, sizeDp / (if (big.length > 2) 3.4f else 2.6f), true).apply { textAlign = Paint.Align.CENTER }
    c.drawText(big, s / 2, s * 0.66f, t)
    val u = paint(Color.WHITE, sizeDp / 7.5f, true).apply { textAlign = Paint.Align.CENTER }
    c.drawText(unit.uppercase(), s / 2, s * 0.88f, u)
    return b
  }

  /** Initials in a colored circle (duels, Turma messages). The color is stable per name. */
  fun avatar(name: String, sizeDp: Float = 40f, color: Int? = null): Bitmap {
    val (b, c) = bitmap(sizeDp, sizeDp)
    val s = px(sizeDp)
    val palette = intArrayOf(0xFF4F46E5.toInt(), 0xFF0E7490.toInt(), 0xFFBE185D.toInt(), 0xFFC2410C.toInt(), 0xFF15803D.toInt(), 0xFF6D28D9.toInt())
    c.drawCircle(s / 2, s / 2, s / 2, paint(color ?: palette[Math.floorMod(name.hashCode(), palette.size)]))
    val initials = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.take(2).joinToString("") { it.first().uppercase() }.ifEmpty { "?" }
    val t = paint(Color.WHITE, sizeDp / 2.6f, true).apply { textAlign = Paint.Align.CENTER }
    c.drawText(initials, s / 2, s / 2 - (t.descent() + t.ascent()) / 2, t)
    return b
  }

  /** Medal for achievements: accent disc, white rim and the emoji. */
  fun medal(emoji: String, accent: Int, sizeDp: Float = 56f): Bitmap {
    val (b, c) = bitmap(sizeDp, sizeDp)
    val s = px(sizeDp)
    val g = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      shader = LinearGradient(0f, 0f, s, s, lighten(accent, 0.25f), accent, Shader.TileMode.CLAMP)
    }
    c.drawCircle(s / 2, s / 2, s / 2, g)
    val rim = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeWidth = px(2.5f)
      color = 0xCCFFFFFF.toInt()
    }
    c.drawCircle(s / 2, s / 2, s / 2 - px(4f), rim)
    val t = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      textSize = px(sizeDp / 2.4f)
      textAlign = Paint.Align.CENTER
    }
    c.drawText(emoji, s / 2, s / 2 - (t.descent() + t.ascent()) / 2, t)
    return b
  }

  /**
   * The live tracker (Uber-style): one segment per step, the active one filled up to the overall fraction,
   * a dot at each step boundary and the step labels underneath. A failed step turns red.
   */
  fun segments(steps: List<ProgressStep>, fraction: Float, accent: Int): Bitmap {
    val wDp = wideDp()
    val (b, c) = bitmap(wDp, 46f)
    val w = px(wDp)
    val n = steps.size
    val gap = px(4f)
    val barTop = px(8f)
    val barH = px(6f)
    val segW = (w - gap * (n - 1)) / n
    val labelPaint = paint(textSecondary, 11f)
    val activeLabel = paint(textPrimary, 11f, true)
    steps.forEachIndexed { i, step ->
      val left = i * (segW + gap)
      val rect = RectF(left, barTop, left + segW, barTop + barH)
      c.drawRoundRect(rect, barH / 2, barH / 2, paint(track))
      val color = if (step.state == "failed") danger else accent
      val fill = when (step.state) {
        "done", "failed" -> 1f
        "active" -> ((fraction * n) - i).coerceIn(0.08f, 1f)
        else -> 0f
      }
      if (fill > 0f) c.drawRoundRect(RectF(left, barTop, left + segW * fill, barTop + barH), barH / 2, barH / 2, paint(color))
      // A ring marks where the student is now.
      if (step.state == "active") {
        val cx = left + segW * fill
        c.drawCircle(cx, barTop + barH / 2, px(6f), paint(Color.WHITE))
        c.drawCircle(cx, barTop + barH / 2, px(4f), paint(color))
      }
      val p = if (step.state == "active" || step.state == "failed") activeLabel else labelPaint
      p.textAlign = Paint.Align.LEFT
      c.drawText(fitText(step.label, p, segW), left, barTop + barH + px(18f), p)
    }
    return b
  }

  /** Duel card: both players with initials, names and scores, "VS" or the result in the middle. */
  fun duel(me: DuelSide, them: DuelSide, center: String, accent: Int): Bitmap {
    val wDp = wideDp()
    val (b, c) = bitmap(wDp, 92f)
    val w = px(wDp)
    val avatarDp = 44f
    val a = px(avatarDp)
    // The student in the accent color, the opponent in neutral gray (as in the app's Central de notificações).
    fun side(x: Float, s: DuelSide, color: Int) {
      c.drawBitmap(avatar(s.name, avatarDp, color), x - a / 2, px(4f), null)
      val name = paint(textPrimary, 12f, true).apply { textAlign = Paint.Align.CENTER }
      c.drawText(fitText(s.name, name, w * 0.34f), x, a + px(20f), name)
      if (s.score != null) {
        val sc = paint(textSecondary, 12f).apply { textAlign = Paint.Align.CENTER }
        c.drawText("${s.score} pts", x, a + px(36f), sc)
      }
    }
    side(w * 0.2f, me, accent)
    side(w * 0.8f, them, 0xFF6B7280.toInt())
    val pill = paint(accent)
    val label = paint(Color.WHITE, 13f, true).apply { textAlign = Paint.Align.CENTER }
    val tw = label.measureText(center) + px(20f)
    val cy = px(4f) + a / 2
    c.drawRoundRect(RectF(w / 2 - tw / 2, cy - px(13f), w / 2 + tw / 2, cy + px(13f)), px(13f), px(13f), pill)
    c.drawText(center, w / 2, cy - (label.descent() + label.ascent()) / 2, label)
    return b
  }

  /** Horizontal bars with labels and percentages (redação competências, simulado areas). */
  fun bars(items: List<Pair<String, Float>>, accent: Int): Bitmap {
    val wDp = wideDp()
    val rowDp = 22f
    val (b, c) = bitmap(wDp, rowDp * items.size + 4f)
    val w = px(wDp)
    val labelW = w * 0.32f
    val valueW = px(40f)
    val barH = px(8f)
    val lp = paint(textSecondary, 11f)
    val vp = paint(textPrimary, 11f, true).apply { textAlign = Paint.Align.RIGHT }
    items.forEachIndexed { i, (label, value) ->
      val cy = px(rowDp * i + rowDp / 2 + 2f)
      c.drawText(fitText(label, lp, labelW - px(6f)), 0f, cy - (lp.descent() + lp.ascent()) / 2, lp)
      val left = labelW
      val right = w - valueW
      val rect = RectF(left, cy - barH / 2, right, cy + barH / 2)
      c.drawRoundRect(rect, barH / 2, barH / 2, paint(track))
      c.drawRoundRect(RectF(left, cy - barH / 2, left + (right - left) * value.coerceIn(0f, 1f), cy + barH / 2), barH / 2, barH / 2, paint(accent))
      c.drawText("${Math.round(value * 100)}%", w, cy - (vp.descent() + vp.ascent()) / 2, vp)
    }
    return b
  }

  /** Podcast waveform with the duration (a fixed pattern per episode key, so it does not jump on updates). */
  fun waveform(seed: Int, durationLabel: String, accent: Int): Bitmap {
    val wDp = wideDp()
    val (b, c) = bitmap(wDp, 40f)
    val w = px(wDp)
    val h = px(40f)
    val tp = paint(textSecondary, 12f, true).apply { textAlign = Paint.Align.RIGHT }
    val textW = tp.measureText(durationLabel) + px(10f)
    val barW = px(3f)
    val step = px(5f)
    val count = ((w - textW) / step).toInt()
    val p = paint(accent)
    for (i in 0 until count) {
      val v = 0.25f + 0.75f * ((sin((i + seed % 97) * 0.55) * sin((i + seed % 31) * 0.21) + 1) / 2).toFloat()
      val bh = h * 0.8f * v
      c.drawRoundRect(RectF(i * step, (h - bh) / 2, i * step + barW, (h + bh) / 2), barW / 2, barW / 2, p)
    }
    c.drawText(durationLabel, w, h / 2 - (tp.descent() + tp.ascent()) / 2, tp)
    return b
  }

  /** Retrospectiva banner: gradient card with the headline and up to three big numbers. */
  fun banner(headline: String, stats: List<Pair<String, String>>, accent: Int): Bitmap {
    val wDp = wideDp()
    val (b, c) = bitmap(wDp, 104f)
    val w = px(wDp)
    val h = px(104f)
    val g = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      shader = LinearGradient(0f, 0f, w, h, accent, darken(accent, 0.35f), Shader.TileMode.CLAMP)
    }
    c.drawRoundRect(RectF(0f, 0f, w, h), px(14f), px(14f), g)
    val hp = paint(Color.WHITE, 15f, true)
    c.drawText(fitText(headline, hp, w - px(24f)), px(12f), px(26f), hp)
    if (stats.isNotEmpty()) {
      val colW = (w - px(24f)) / stats.size
      stats.forEachIndexed { i, (label, value) ->
        val x = px(12f) + colW * i
        val vp = paint(Color.WHITE, 22f, true)
        c.drawText(fitText(value, vp, colW - px(6f)), x, px(66f), vp)
        val lp = paint(0xDDFFFFFF.toInt(), 11f)
        c.drawText(fitText(label, lp, colW - px(6f)), x, px(86f), lp)
      }
    }
    return b
  }

  private fun lighten(color: Int, f: Float): Int = Color.rgb(
    (Color.red(color) + (255 - Color.red(color)) * f).toInt(),
    (Color.green(color) + (255 - Color.green(color)) * f).toInt(),
    (Color.blue(color) + (255 - Color.blue(color)) * f).toInt(),
  )

  private fun darken(color: Int, f: Float): Int = Color.rgb(
    (Color.red(color) * (1 - f)).toInt(),
    (Color.green(color) * (1 - f)).toInt(),
    (Color.blue(color) * (1 - f)).toInt(),
  )
}

/** Glyph name → vector drawable (the same names as RICH_GLYPHS in packages/shared). */
object Glyphs {
  fun res(name: String): Int = when (name) {
    "book" -> R.drawable.sn_glyph_book
    "cards" -> R.drawable.sn_glyph_cards
    "quiz" -> R.drawable.sn_glyph_quiz
    "trophy" -> R.drawable.sn_glyph_trophy
    "flame" -> R.drawable.sn_glyph_flame
    "calendar" -> R.drawable.sn_glyph_calendar
    "podcast" -> R.drawable.sn_glyph_podcast
    "pen" -> R.drawable.sn_glyph_pen
    "camera" -> R.drawable.sn_glyph_camera
    "people" -> R.drawable.sn_glyph_people
    "timer" -> R.drawable.sn_glyph_timer
    "alert" -> R.drawable.sn_glyph_alert
    "check" -> R.drawable.sn_glyph_check
    "map" -> R.drawable.sn_glyph_map
    "news" -> R.drawable.sn_glyph_news
    else -> R.drawable.sn_glyph_sparkles
  }
}
