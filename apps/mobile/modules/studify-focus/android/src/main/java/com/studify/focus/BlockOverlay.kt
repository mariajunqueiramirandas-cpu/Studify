package com.studify.focus

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * WEL-02.3 Bloqueio overlay: a full-screen Studify window over a blocked app with "Voltar pro Studify",
 * "Desbloquear por 5 min" (press and hold for 10 s) and "Encerrar foco". Built in code so the module has no
 * layout resources; every control is a regular view with a text label for TalkBack.
 */
class BlockOverlay(
  private val context: Context,
  private val onBack: () -> Unit,
  private val onUnlock: () -> Unit,
  private val onEnd: () -> Unit,
) {
  private val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
  private val main = Handler(Looper.getMainLooper())
  private var root: View? = null
  private var holdRunnable: Runnable? = null

  val isShowing: Boolean
    get() = root != null

  fun canShow(): Boolean = Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context)

  private fun dp(v: Int): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), context.resources.displayMetrics).toInt()

  private fun button(label: String, filled: Boolean): Button {
    val b = Button(context)
    b.text = label
    b.setAllCaps(false)
    b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
    b.setTextColor(if (filled) Color.WHITE else Color.parseColor("#E5E7EB"))
    b.minHeight = dp(52)
    val bg = GradientDrawable()
    bg.cornerRadius = dp(26).toFloat()
    if (filled) bg.setColor(Color.parseColor("#4F46E5")) else bg.setStroke(dp(1), Color.parseColor("#6B7280"))
    b.background = bg
    val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    lp.topMargin = dp(12)
    b.layoutParams = lp
    return b
  }

  @SuppressLint("ClickableViewAccessibility")
  fun show(strings: FocusStrings, endsAtLabel: String) {
    if (root != null || !canShow()) return
    val layout = LinearLayout(context)
    layout.orientation = LinearLayout.VERTICAL
    layout.gravity = Gravity.CENTER
    layout.setBackgroundColor(Color.parseColor("#F2111827"))
    layout.setPadding(dp(32), dp(48), dp(32), dp(48))

    val title = TextView(context)
    title.text = strings.overlayTitle.replace("{time}", endsAtLabel)
    title.setTextColor(Color.WHITE)
    title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24f)
    title.gravity = Gravity.CENTER
    layout.addView(title)

    val body = TextView(context)
    body.text = strings.overlayBody
    body.setTextColor(Color.parseColor("#D1D5DB"))
    body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    body.gravity = Gravity.CENTER
    body.setPadding(0, dp(12), 0, dp(24))
    layout.addView(body)

    val back = button(strings.overlayBack, true)
    back.setOnClickListener { onBack() }
    layout.addView(back)

    val unlock = button(strings.overlayUnlock, false)
    unlock.contentDescription = "${strings.overlayUnlock}. ${strings.overlayHold.replace("{n}", "10")}"
    unlock.setOnTouchListener { v, event ->
      when (event.action) {
        MotionEvent.ACTION_DOWN -> startHold(unlock, strings)
        MotionEvent.ACTION_UP -> {
          cancelHold(unlock, strings)
          v.performClick()
        }
        MotionEvent.ACTION_CANCEL -> cancelHold(unlock, strings)
      }
      true
    }
    layout.addView(unlock)

    val end = button(strings.overlayEnd, false)
    end.setOnClickListener { onEnd() }
    layout.addView(end)

    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
    } else {
      @Suppress("DEPRECATION")
      WindowManager.LayoutParams.TYPE_PHONE
    }
    val params = WindowManager.LayoutParams(
      WindowManager.LayoutParams.MATCH_PARENT,
      WindowManager.LayoutParams.MATCH_PARENT,
      type,
      WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
      PixelFormat.TRANSLUCENT,
    )
    try {
      wm.addView(layout, params)
      root = layout
    } catch (_: Exception) {
      // Permission revoked between the check and the call: blocking degrades to soft focus (WEL-02.6).
      root = null
    }
  }

  private fun startHold(button: Button, strings: FocusStrings) {
    cancelHold(button, strings)
    var left = 10
    val tick = object : Runnable {
      override fun run() {
        if (left <= 0) {
          holdRunnable = null
          onUnlock()
          return
        }
        button.text = strings.overlayHold.replace("{n}", left.toString())
        left -= 1
        main.postDelayed(this, 1000)
      }
    }
    holdRunnable = tick
    main.post(tick)
  }

  private fun cancelHold(button: Button, strings: FocusStrings) {
    holdRunnable?.let { main.removeCallbacks(it) }
    holdRunnable = null
    button.text = strings.overlayUnlock
  }

  fun hide() {
    holdRunnable?.let { main.removeCallbacks(it) }
    holdRunnable = null
    val v = root ?: return
    root = null
    try {
      wm.removeView(v)
    } catch (_: Exception) {
      // Already detached.
    }
  }
}
