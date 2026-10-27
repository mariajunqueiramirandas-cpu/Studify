package com.studify.notify

import android.content.Context
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import org.json.JSONObject

/**
 * Receives every FCM message before Expo does (Expo registers its service with priority -1 so apps can do
 * this). Rich payloads are drawn here natively, so the custom UI shows even when the app is closed; every
 * other message goes to Expo unchanged. Expo's push service delivers the message's `data` as the JSON
 * string in data["body"] (expo-notifications NotificationData).
 */
class StudifyMessagingService : ExpoFirebaseMessagingService() {
  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    val handled = try {
      RichPush.handle(this, remoteMessage.data)
    } catch (_: Exception) {
      false
    }
    if (!handled) super.onMessageReceived(remoteMessage)
  }
}

object RichPush {
  /** True when the message was a rich notification (shown) or a cancel for one. */
  fun handle(c: Context, data: Map<String, String>): Boolean {
    val body = data["body"]?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return false
    body.optString("rich_cancel").takeIf { it.isNotBlank() }?.let {
      RichRenderer.cancel(c, it)
      return true
    }
    val rich = body.optJSONObject("rich") ?: return false
    if (!rich.has("deep_link")) body.optString("deep_link").takeIf { it.startsWith("studify://") }?.let { rich.put("deep_link", it) }
    val shown = RichRenderer.show(c, rich)
    if (shown) NotifyStore.listener?.invoke("received", rich.optString("key"))
    return shown
  }
}
