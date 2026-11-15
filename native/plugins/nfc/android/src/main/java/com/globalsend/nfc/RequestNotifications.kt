package com.globalsend.nfc

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import java.util.ArrayDeque

/**
 * "X wants to send you files" notification with Accept / Decline buttons,
 * shown when a request arrives while the app isn't on screen. Button presses
 * are handed to Rust through a long-poll (`nextRequestAction`), so they work
 * even when the web page isn't running.
 */
object RequestNotifications {
  private const val CHANNEL_ID = "requests"
  const val EXTRA_REQUEST = "requestId"
  const val EXTRA_ACCEPT = "accept"

  private val actions = ArrayDeque<Pair<String, Boolean>>()
  private var waiting: Invoke? = null

  fun show(context: Context, requestId: String, title: String, text: String) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL_ID) == null) {
      // High importance: shows as a heads-up banner.
      manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Incoming files", NotificationManager.IMPORTANCE_HIGH))
    }
    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle(title)
      .setContentText(text)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setAutoCancel(true)
      .setContentIntent(TransferService.openAppIntent(context))
      .addAction(0, "Decline", actionIntent(context, requestId, false))
      .addAction(0, "Accept", actionIntent(context, requestId, true))
      .build()
    try {
      NotificationManagerCompat.from(context).notify(requestId.hashCode(), notification)
    } catch (e: SecurityException) {
      // Notification permission denied: the in-app prompt still works.
    }
  }

  fun cancel(context: Context, requestId: String) {
    NotificationManagerCompat.from(context).cancel(requestId.hashCode())
  }

  /** Resolves with the next button press, now or when it happens. */
  @Synchronized
  fun next(invoke: Invoke) {
    val action = actions.pollFirst()
    if (action != null) resolve(invoke, action) else waiting = invoke
  }

  @Synchronized
  fun push(requestId: String, accept: Boolean) {
    val invoke = waiting
    if (invoke != null) {
      waiting = null
      resolve(invoke, requestId to accept)
    } else {
      actions.addLast(requestId to accept)
    }
  }

  private fun resolve(invoke: Invoke, action: Pair<String, Boolean>) {
    invoke.resolve(JSObject().apply {
      put("requestId", action.first)
      put("accept", action.second)
    })
  }

  private fun actionIntent(context: Context, requestId: String, accept: Boolean): PendingIntent {
    val intent = Intent(context, RequestActionReceiver::class.java)
      .putExtra(EXTRA_REQUEST, requestId)
      .putExtra(EXTRA_ACCEPT, accept)
    // Distinct request codes so Accept and Decline don't overwrite each other.
    val code = requestId.hashCode() * 2 + if (accept) 1 else 0
    return PendingIntent.getBroadcast(context, code, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }
}

class RequestActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val requestId = intent.getStringExtra(RequestNotifications.EXTRA_REQUEST) ?: return
    RequestNotifications.cancel(context, requestId)
    RequestNotifications.push(requestId, intent.getBooleanExtra(RequestNotifications.EXTRA_ACCEPT, false))
  }
}
