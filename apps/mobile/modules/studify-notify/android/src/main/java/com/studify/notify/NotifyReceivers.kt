package com.studify.notify

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONObject

/**
 * Local scheduling for rich notifications (reminders, snoozes). Inexact alarms that may fire while idle:
 * reminders do not need minute precision, and the app never asks for the exact-alarm permission
 * (mobile-app.md §16). The payload is stored so a reboot or an app update can re-arm it.
 */
object NotifyScheduler {
  /** Alarms that were due this long ago when the phone comes back are dropped, not shown late. */
  private const val STALE_MS = 60 * 60_000L

  private fun am(c: Context) = c.getSystemService(Context.ALARM_SERVICE) as AlarmManager

  private fun pending(c: Context, id: String, flags: Int): PendingIntent? {
    val intent = Intent(c, NotifyAlarmReceiver::class.java).setData(Uri.parse("studify-notify://sched/${Uri.encode(id)}"))
    return PendingIntent.getBroadcast(c, 0, intent, PendingIntent.FLAG_IMMUTABLE or flags)
  }

  fun schedule(c: Context, id: String, at: Long, raw: JSONObject): Boolean {
    if (RichPayload.parse(raw) == null) return false
    NotifyStore.saveScheduled(c, id, at, raw)
    arm(c, id, at)
    return true
  }

  private fun arm(c: Context, id: String, at: Long) {
    val pi = pending(c, id, PendingIntent.FLAG_UPDATE_CURRENT) ?: return
    am(c).setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
  }

  fun cancel(c: Context, id: String) {
    pending(c, id, PendingIntent.FLAG_NO_CREATE)?.let { am(c).cancel(it) }
    NotifyStore.removeScheduled(c, id)
  }

  fun cancelPrefix(c: Context, prefix: String): Int {
    val ids = NotifyStore.scheduledIds(c).filter { it.startsWith(prefix) }
    ids.forEach { cancel(c, it) }
    return ids.size
  }

  fun fire(c: Context, id: String) {
    val (_, raw) = NotifyStore.scheduled(c, id) ?: return
    NotifyStore.removeScheduled(c, id)
    RichRenderer.show(c, raw)
  }

  /** After a reboot or an update the system has dropped every alarm: arm them again. */
  fun rearmAll(c: Context) {
    val now = System.currentTimeMillis()
    for (id in NotifyStore.scheduledIds(c)) {
      val (at, _) = NotifyStore.scheduled(c, id) ?: continue
      if (at < now - STALE_MS) NotifyStore.removeScheduled(c, id) else arm(c, id, maxOf(at, now + 5_000L))
    }
  }
}

class NotifyAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val id = intent.data?.lastPathSegment ?: return
    NotifyScheduler.fire(context, id)
  }
}

class NotifyBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
      NotifyScheduler.rearmAll(context)
    }
  }
}

/**
 * Buttons that work without opening the app (Android 12+ forbids starting activities from here anyway):
 * snooze, dismiss, reveal a card's answer, and the two ratings, which are queued for the app to record.
 */
class NotifyActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != RichRenderer.ACTION) return
    val key = intent.getStringExtra(RichRenderer.EXTRA_KEY) ?: return
    when (intent.getStringExtra(RichRenderer.EXTRA_KIND)) {
      "dismiss" -> RichRenderer.cancel(context, key)
      "snooze" -> {
        val raw = NotifyStore.shown(context, key)
        val actionId = intent.getStringExtra(RichRenderer.EXTRA_ACTION_ID)
        val minutes = RichPayload.parse(raw ?: JSONObject())?.actions?.firstOrNull { it.id == actionId }?.snoozeMin ?: 60
        RichRenderer.cancel(context, key)
        if (raw != null) NotifyScheduler.schedule(context, "snooze:$key", System.currentTimeMillis() + minutes * 60_000L, raw)
        NotifyStore.recordAction(context, "snooze", key)
      }
      "reveal" -> {
        val raw = NotifyStore.shown(context, key) ?: return
        RichRenderer.show(context, RichRenderer.revealed(raw))
      }
      "rate_again", "rate_good" -> {
        val kind = intent.getStringExtra(RichRenderer.EXTRA_KIND)!!
        val cardId = NotifyStore.shown(context, key)?.optJSONObject("card")?.optString("card_id")
        RichRenderer.cancel(context, key)
        if (!cardId.isNullOrBlank()) NotifyStore.recordAction(context, kind, key, JSONObject().put("card_id", cardId))
      }
    }
  }
}
