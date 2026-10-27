package com.studify.focus

import android.app.AppOpsManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.os.Process
import android.provider.AlarmClock
import android.provider.Settings
import android.provider.Telephony
import android.telecom.TelecomManager
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

object FocusPermissions {
  fun hasUsageAccess(context: Context): Boolean {
    val ops = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
    val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
    } else {
      @Suppress("DEPRECATION")
      ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
    }
    return mode == AppOpsManager.MODE_ALLOWED
  }

  fun canDrawOverlays(context: Context): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context)

  fun hasDndAccess(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return false
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    return nm.isNotificationPolicyAccessGranted
  }
}

/**
 * Local Expo module behind src/platform/focus.ts (mobile-app.md §19 `FocusBlocker`). Android only; the JS wrapper
 * falls back to soft focus when the module is missing (Expo Go, iOS, tests).
 */
class StudifyFocusModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private fun openSettings(action: String, withPackage: Boolean) {
    val intent = if (withPackage) Intent(action, Uri.parse("package:${context.packageName}")) else Intent(action)
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      context.startActivity(intent)
    } catch (_: Exception) {
      context.startActivity(Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }

  /** WEL-02.4: phone, SMS, emergency, clock, settings and Studify itself can never be blocked. */
  private fun neverBlockable(): Set<String> {
    val pm = context.packageManager
    val out = mutableSetOf(context.packageName, "com.android.settings", "com.android.emergency", "com.google.android.dialer", "com.android.dialer")
    try {
      (context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager)?.defaultDialerPackage?.let { out.add(it) }
    } catch (_: Exception) {
      // ignore
    }
    Telephony.Sms.getDefaultSmsPackage(context)?.let { out.add(it) }
    listOf(Intent(AlarmClock.ACTION_SHOW_ALARMS), Intent(Settings.ACTION_SETTINGS), Intent(Intent.ACTION_DIAL)).forEach { intent ->
      pm.queryIntentActivities(intent, 0).forEach { out.add(it.activityInfo.packageName) }
    }
    return out
  }

  override fun definition() = ModuleDefinition {
    Name("StudifyFocus")

    Events("onFocusAction")

    OnCreate {
      FocusBridge.listener = { sendEvent("onFocusAction", mapOf<String, Any?>()) }
    }

    OnDestroy {
      FocusBridge.listener = null
    }

    /** Starts the session or replaces its state (pause, resume or skip made in the app). */
    Function("start") { configJson: String ->
      val intent = Intent(context, FocusService::class.java).setAction(FocusService.ACTION_START).putExtra(FocusService.EXTRA_CONFIG, configJson)
      ContextCompat.startForegroundService(context, intent)
    }

    Function("stop") {
      context.stopService(Intent(context, FocusService::class.java))
    }

    Function("isRunning") {
      FocusService.running
    }

    Function("consumeActions") {
      FocusBridge.consume(context)
    }

    Function("blockedAttempts") {
      FocusBridge.blockedAttempts(context)
    }

    /** Screen on and unlocked-or-awake: leaving Studify then is an interruption; screen off is not (WEL-01.5). */
    Function("isInteractive") {
      (context.getSystemService(Context.POWER_SERVICE) as PowerManager).isInteractive
    }

    Function("permissions") {
      mapOf(
        "usage" to FocusPermissions.hasUsageAccess(context),
        "overlay" to FocusPermissions.canDrawOverlays(context),
        "dnd" to FocusPermissions.hasDndAccess(context),
      )
    }

    Function("openUsageAccessSettings") {
      openSettings(Settings.ACTION_USAGE_ACCESS_SETTINGS, false)
    }

    Function("openOverlaySettings") {
      openSettings(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, true)
    }

    Function("openDndSettings") {
      openSettings(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS, false)
    }

    /** Launcher apps the student can choose to block. The list never leaves the device (WEL-02.5). */
    AsyncFunction("getInstalledApps") {
      val pm = context.packageManager
      val skip = neverBlockable()
      val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
      pm.queryIntentActivities(launcher, 0)
        .map { it.activityInfo.packageName to it.loadLabel(pm).toString() }
        .filter { (pkg, _) -> pkg !in skip }
        .distinctBy { it.first }
        .sortedBy { it.second.lowercase() }
        .map { (pkg, label) -> mapOf("packageName" to pkg, "label" to label) }
    }
  }
}
