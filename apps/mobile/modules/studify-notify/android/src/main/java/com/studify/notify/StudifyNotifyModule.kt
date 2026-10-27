package com.studify.notify

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

/**
 * Local Expo module behind src/platform/rich-notify.ts. Android only; the JS wrapper falls back to plain
 * expo-notifications when the module is missing (Expo Go, tests, other platforms).
 */
class StudifyNotifyModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private fun json(s: String): JSONObject? = runCatching { JSONObject(s) }.getOrNull()

  override fun definition() = ModuleDefinition {
    Name("StudifyNotify")

    Events("onNotifyEvent")

    OnCreate {
      NotifyStore.listener = { type, key -> sendEvent("onNotifyEvent", mapOf("type" to type, "key" to key)) }
    }

    OnDestroy {
      NotifyStore.listener = null
    }

    /** Shows (or replaces, by key) a rich notification now. */
    Function("show") { payloadJson: String ->
      json(payloadJson)?.let { RichRenderer.show(context, it) } ?: false
    }

    Function("cancel") { key: String ->
      RichRenderer.cancel(context, key)
    }

    Function("activeKeys") {
      RichRenderer.activeKeys(context)
    }

    /** Shows the payload at `atMs` (epoch ms). Re-armed after reboots and updates. */
    Function("schedule") { id: String, atMs: Double, payloadJson: String ->
      json(payloadJson)?.let { NotifyScheduler.schedule(context, id, atMs.toLong(), it) } ?: false
    }

    Function("cancelScheduled") { prefix: String ->
      NotifyScheduler.cancelPrefix(context, prefix)
    }

    Function("scheduledIds") {
      NotifyStore.scheduledIds(context)
    }

    /** Actions taken from notifications since the last call (ratings, snoozes), oldest first. */
    Function("consumeActions") {
      NotifyStore.consumeActions(context)
    }

    Function("capabilities") {
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val live = Build.VERSION.SDK_INT >= 36
      mapOf(
        "sdk" to Build.VERSION.SDK_INT,
        "enabled" to NotificationManagerCompat.from(context).areNotificationsEnabled(),
        "liveUpdates" to live,
        "promoted" to (live && nm.canPostPromotedNotifications()),
      )
    }

    /** The app's notification settings (channels, and on Android 16 the Live Updates switch). */
    Function("openSettings") {
      val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }
  }
}
