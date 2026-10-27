package com.studify.focus

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** PT-BR strings come from the app's i18n so the native side holds no copy of its own. */
data class FocusStrings(
  val focus: String,
  val breakShort: String,
  val breakLong: String,
  val pause: String,
  val resume: String,
  val skip: String,
  val stop: String,
  val paused: String,
  val toBreak: String,
  val toFocus: String,
  val done: String,
  val overlayTitle: String,
  val overlayBody: String,
  val overlayBack: String,
  val overlayUnlock: String,
  val overlayHold: String,
  val overlayEnd: String,
) {
  companion object {
    fun from(o: JSONObject) = FocusStrings(
      focus = o.optString("focus", "Foco"),
      breakShort = o.optString("break", "Pausa"),
      breakLong = o.optString("long_break", "Pausa longa"),
      pause = o.optString("pause", "Pausar"),
      resume = o.optString("resume", "Retomar"),
      skip = o.optString("skip", "Pular"),
      stop = o.optString("stop", "Encerrar"),
      paused = o.optString("paused", "Pausado"),
      toBreak = o.optString("to_break", "Pausa! Levanta, bebe água, alonga."),
      toFocus = o.optString("to_focus", "Bora voltar pro foco?"),
      done = o.optString("done", "Foco concluído!"),
      overlayTitle = o.optString("overlay_title", "Foco até {time}. Bora voltar?"),
      overlayBody = o.optString("overlay_body", ""),
      overlayBack = o.optString("overlay_back", "Voltar pro Studify"),
      overlayUnlock = o.optString("overlay_unlock", "Desbloquear por 5 min"),
      overlayHold = o.optString("overlay_hold", "Segure… {n} s"),
      overlayEnd = o.optString("overlay_end", "Encerrar foco"),
    )
  }
}

/**
 * WEL-01/02 focus session (spec 13 §8.8–8.9). Runs the phase timeline on its own so the countdown, the
 * end-of-phase alert, Não perturbe and app blocking keep working while the app is in the background or killed.
 * The JS focus store stays the source of truth: every action taken here is queued in [FocusBridge] with its time
 * and replayed there.
 */
class FocusService : Service() {
  companion object {
    const val ACTION_START = "com.studify.focus.START"
    const val ACTION_PAUSE = "com.studify.focus.PAUSE"
    const val ACTION_RESUME = "com.studify.focus.RESUME"
    const val ACTION_SKIP = "com.studify.focus.SKIP"
    const val ACTION_STOP = "com.studify.focus.STOP"
    const val ACTION_TICK = "com.studify.focus.TICK"
    const val EXTRA_CONFIG = "config"

    private const val CHANNEL_ONGOING = "focus_ongoing"
    private const val CHANNEL_ALERT = "focus_alert"
    private const val NOTIFICATION_ID = 7301
    private const val ALERT_ID = 7302
    private const val POLL_MS = 1000L
    private const val UNLOCK_MS = 5 * 60 * 1000L

    @Volatile
    var running = false
      private set
  }

  private data class Phase(val kind: String, val ms: Long)

  private val main = Handler(Looper.getMainLooper())
  private var phases: List<Phase> = emptyList()
  private var index = 0
  private var phaseEndsAt = 0L
  private var paused = false
  private var remainingMs = 0L
  private var blocked: Set<String> = emptySet()
  private var dnd = false
  private var dndActive = false
  private var openUrl: String? = null
  private var strings = FocusStrings.from(JSONObject())
  private val unlockedUntil = HashMap<String, Long>()
  private var lastQueryAt = 0L
  private var foreground: String? = null
  private var overlayFor: String? = null
  private var overlay: BlockOverlay? = null
  private var screenReceiver: BroadcastReceiver? = null

  private val tick = Runnable { onTick() }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    running = true
    ensureChannels()
    overlay = BlockOverlay(
      this,
      onBack = {
        openApp()
        hideOverlay()
      },
      onUnlock = {
        overlayFor?.let { unlockedUntil[it] = System.currentTimeMillis() + UNLOCK_MS }
        hideOverlay()
      },
      onEnd = {
        FocusBridge.record(this, "stop", System.currentTimeMillis())
        openApp()
        finish(alertDone = false)
      },
    )
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        // Poll the foreground app only while the screen is on (a blocked app can only open then).
        scheduleTick()
      }
    }
    val filter = IntentFilter().apply {
      addAction(Intent.ACTION_SCREEN_ON)
      addAction(Intent.ACTION_SCREEN_OFF)
    }
    ContextCompat.registerReceiver(this, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    screenReceiver = receiver
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val now = System.currentTimeMillis()
    when (intent?.action) {
      ACTION_START -> {
        val config = intent.getStringExtra(EXTRA_CONFIG)
        if (config == null) {
          stopSelf()
          return START_NOT_STICKY
        }
        applyConfig(JSONObject(config))
        startInForeground()
      }
      ACTION_PAUSE -> if (!paused && phases.isNotEmpty()) {
        remainingMs = (phaseEndsAt - now).coerceAtLeast(0)
        paused = true
        FocusBridge.record(this, "pause", now)
      }
      ACTION_RESUME -> if (paused) {
        phaseEndsAt = now + remainingMs
        paused = false
        FocusBridge.record(this, "resume", now)
      }
      ACTION_SKIP -> if (phases.isNotEmpty()) {
        FocusBridge.record(this, "skip", now)
        advance(now, skipped = true)
      }
      ACTION_STOP -> {
        FocusBridge.record(this, "stop", now)
        finish(alertDone = false)
        return START_NOT_STICKY
      }
      ACTION_TICK -> Unit
      else -> {
        // Restarted without a config (process death): nothing to resume here; the app restarts it on open.
        stopSelf()
        return START_NOT_STICKY
      }
    }
    if (phases.isEmpty()) {
      stopSelf()
      return START_NOT_STICKY
    }
    onTick()
    return START_NOT_STICKY
  }

  private fun applyConfig(o: JSONObject) {
    val list = o.getJSONArray("phases")
    phases = (0 until list.length()).map {
      val p = list.getJSONObject(it)
      Phase(p.getString("kind"), p.getLong("ms"))
    }
    index = o.optInt("index", 0).coerceIn(0, maxOf(0, phases.size - 1))
    paused = o.optBoolean("paused", false)
    phaseEndsAt = o.optLong("phaseEndsAt", System.currentTimeMillis())
    remainingMs = o.optLong("remainingMs", 0)
    val b = o.optJSONArray("blocked")
    blocked = if (b == null) emptySet() else (0 until b.length()).map { b.getString(it) }.toSet()
    dnd = o.optBoolean("dnd", false)
    openUrl = o.optString("openUrl", "").ifEmpty { null }
    strings = FocusStrings.from(o.optJSONObject("strings") ?: JSONObject())
    FocusBridge.beginSession(this, o.optString("sessionId", ""))
  }

  private fun currentKind(): String = phases.getOrNull(index)?.kind ?: "focus"

  private fun inFocusPhase(): Boolean = phases.isNotEmpty() && currentKind() == "focus"

  /** Ends the current phase: at its scheduled end (keeps the timeline aligned) or now when skipped. */
  private fun advance(now: Long, skipped: Boolean) {
    val ended = currentKind()
    val endedAt = if (skipped || paused) now else phaseEndsAt
    index += 1
    paused = false
    if (index >= phases.size) {
      finish(alertDone = !skipped)
      return
    }
    phaseEndsAt = endedAt + phases[index].ms
    if (!skipped) alert(if (ended == "focus") strings.toBreak else strings.toFocus)
  }

  private fun onTick() {
    if (phases.isEmpty()) return
    val now = System.currentTimeMillis()
    // A late tick (Doze) may cover several phases.
    while (!paused && running && phases.isNotEmpty() && index < phases.size && now >= phaseEndsAt) advance(now, skipped = false)
    if (!running || phases.isEmpty()) return
    applyPhaseEffects()
    checkForeground(now)
    updateNotification()
    scheduleTick()
  }

  private fun scheduleTick() {
    main.removeCallbacks(tick)
    if (!running || phases.isEmpty()) return
    val now = System.currentTimeMillis()
    val untilEnd = if (paused) Long.MAX_VALUE else (phaseEndsAt - now).coerceAtLeast(0)
    val polling = blockingActive() && isInteractive()
    val delay = if (polling) minOf(POLL_MS, untilEnd) else untilEnd
    if (delay != Long.MAX_VALUE) main.postDelayed(tick, delay.coerceAtLeast(50))
    scheduleAlarm()
  }

  /** The handler may be delayed in Doze; an inexact alarm that may fire while idle backs it up (no exact alarms). */
  private fun scheduleAlarm() {
    val am = getSystemService(Context.ALARM_SERVICE) as AlarmManager
    val pi = PendingIntent.getService(
      this, 1, Intent(this, FocusService::class.java).setAction(ACTION_TICK),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    am.cancel(pi)
    if (paused || !running) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, phaseEndsAt, pi)
    } else {
      am.set(AlarmManager.RTC_WAKEUP, phaseEndsAt, pi)
    }
  }

  private fun cancelAlarm() {
    val am = getSystemService(Context.ALARM_SERVICE) as AlarmManager
    val pi = PendingIntent.getService(
      this, 1, Intent(this, FocusService::class.java).setAction(ACTION_TICK),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_NO_CREATE,
    )
    if (pi != null) am.cancel(pi)
  }

  private fun isInteractive(): Boolean = (getSystemService(Context.POWER_SERVICE) as PowerManager).isInteractive

  private fun blockingActive(): Boolean = inFocusPhase() && !paused && blocked.isNotEmpty() && FocusPermissions.hasUsageAccess(this)

  // ---------- WEL-02 blocking ----------

  private fun checkForeground(now: Long) {
    if (!blockingActive() || !isInteractive()) {
      hideOverlay()
      return
    }
    val usm = getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
    val from = if (lastQueryAt == 0L) now - 10_000 else lastQueryAt - 1_000
    val events = usm.queryEvents(from, now)
    val e = UsageEvents.Event()
    val resumed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) UsageEvents.Event.ACTIVITY_RESUMED else {
      @Suppress("DEPRECATION")
      UsageEvents.Event.MOVE_TO_FOREGROUND
    }
    while (events.hasNextEvent()) {
      events.getNextEvent(e)
      if (e.eventType == resumed) foreground = e.packageName
    }
    lastQueryAt = now
    val fg = foreground
    val locked = fg != null && fg in blocked && (unlockedUntil[fg] ?: 0L) < now
    if (!locked) {
      hideOverlay()
      return
    }
    if (overlayFor != fg) {
      // One attempt per time a blocked app comes to the front; only the count is kept (WEL-02.5).
      FocusBridge.incrementBlocked(this)
      hideOverlay()
      overlayFor = fg
      // During a focus phase its end is the end of the focus block: "Foco até {hh:mm}".
      val label = SimpleDateFormat("HH:mm", Locale.forLanguageTag("pt-BR")).format(Date(phaseEndsAt))
      overlay?.show(strings, label)
    }
  }

  private fun hideOverlay() {
    overlay?.hide()
    overlayFor = null
  }

  // ---------- WEL-01.4 Não perturbe ----------

  private fun applyPhaseEffects() {
    val want = dnd && inFocusPhase() && !paused
    if (want == dndActive) return
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || !nm.isNotificationPolicyAccessGranted) return
    if (want) {
      FocusBridge.saveDndPrevious(this, nm.currentInterruptionFilter)
      nm.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_PRIORITY)
      dndActive = true
    } else {
      restoreDnd(nm)
    }
  }

  private fun restoreDnd(nm: NotificationManager) {
    val previous = FocusBridge.takeDndPrevious(this)
    if (dndActive && previous > 0 && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && nm.isNotificationPolicyAccessGranted) {
      nm.setInterruptionFilter(previous)
    }
    dndActive = false
  }

  // ---------- notifications ----------

  private fun ensureChannels() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (nm.getNotificationChannel(CHANNEL_ONGOING) == null) {
      val ongoing = NotificationChannel(CHANNEL_ONGOING, "Modo foco", NotificationManager.IMPORTANCE_LOW)
      ongoing.setShowBadge(false)
      ongoing.lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
      nm.createNotificationChannel(ongoing)
    }
    if (nm.getNotificationChannel(CHANNEL_ALERT) == null) {
      // Default sound and vibration: the system applies silent and vibrate modes (WEL-01.3).
      val alert = NotificationChannel(CHANNEL_ALERT, "Fim de foco e de pausa", NotificationManager.IMPORTANCE_HIGH)
      alert.enableVibration(true)
      alert.lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
      nm.createNotificationChannel(alert)
    }
  }

  private fun actionIntent(action: String, code: Int): PendingIntent =
    PendingIntent.getService(this, code, Intent(this, FocusService::class.java).setAction(action), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

  private fun openIntent(): PendingIntent? {
    val intent = openUrl?.let { Intent(Intent.ACTION_VIEW, Uri.parse(it)).setPackage(packageName) }
      ?: packageManager.getLaunchIntentForPackage(packageName)
      ?: return null
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(this, 2, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun openApp() {
    val intent = openUrl?.let { Intent(Intent.ACTION_VIEW, Uri.parse(it)).setPackage(packageName) }
      ?: packageManager.getLaunchIntentForPackage(packageName)
      ?: return
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    try {
      startActivity(intent)
    } catch (_: Exception) {
      // Background activity start refused: the overlay is hidden anyway and the student opens Studify.
    }
  }

  private fun phaseTitle(): String = when (currentKind()) {
    "break" -> strings.breakShort
    "long_break" -> strings.breakLong
    else -> strings.focus
  }

  private fun buildNotification(): android.app.Notification {
    val b = NotificationCompat.Builder(this, CHANNEL_ONGOING)
      .setSmallIcon(R.drawable.studify_focus_ic)
      .setContentTitle(phaseTitle())
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setContentIntent(openIntent())
    if (paused) {
      val s = remainingMs / 1000
      b.setContentText("${strings.paused} · ${s / 60}:${(s % 60).toString().padStart(2, '0')}")
      b.setShowWhen(false).setUsesChronometer(false)
      b.addAction(0, strings.resume, actionIntent(ACTION_RESUME, 10))
    } else {
      b.setWhen(phaseEndsAt).setShowWhen(true).setUsesChronometer(true).setChronometerCountDown(true)
      b.addAction(0, strings.pause, actionIntent(ACTION_PAUSE, 11))
    }
    b.addAction(0, strings.skip, actionIntent(ACTION_SKIP, 12))
    b.addAction(0, strings.stop, actionIntent(ACTION_STOP, 13))
    return b.build()
  }

  private fun startInForeground() {
    val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
    ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type)
  }

  private fun updateNotification() {
    if (!running) return
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.notify(NOTIFICATION_ID, buildNotification())
  }

  private fun alert(text: String) {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val n = NotificationCompat.Builder(this, CHANNEL_ALERT)
      .setSmallIcon(R.drawable.studify_focus_ic)
      .setContentTitle("Studify")
      .setContentText(text)
      .setAutoCancel(true)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_REMINDER)
      .setDefaults(NotificationCompat.DEFAULT_ALL)
      .setTimeoutAfter(60_000)
      .setContentIntent(openIntent())
      .build()
    nm.notify(ALERT_ID, n)
  }

  private fun finish(alertDone: Boolean) {
    if (alertDone) alert(strings.done)
    phases = emptyList()
    main.removeCallbacks(tick)
    cancelAlarm()
    hideOverlay()
    restoreDnd(getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onDestroy() {
    main.removeCallbacks(tick)
    cancelAlarm()
    hideOverlay()
    if (dndActive) restoreDnd(getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
    screenReceiver?.let {
      try {
        unregisterReceiver(it)
      } catch (_: Exception) {
        // not registered
      }
    }
    screenReceiver = null
    running = false
    super.onDestroy()
  }
}
