package com.globalsend.nfc

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * Keeps the app process alive so Android doesn't freeze it in the background.
 * Runs in two situations, each optional:
 *
 * - **Presence** (user setting "Stay reachable"): stays visible to nearby
 *   devices and able to receive while the app is closed, like KDE Connect.
 *   Holds no wake or Wi-Fi lock, so idle cost is low.
 * - **Transfer**: while files are being sent or received. Shows progress and
 *   holds a CPU wake lock plus a low-latency Wi-Fi lock (Wi-Fi power saving
 *   otherwise slows LAN transfers a lot).
 *
 * Stops when neither applies.
 */
class TransferService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val current = transfer
    if (current == null && !presence) {
      stopSelf()
      return START_NOT_STICKY
    }
    val notification = if (current != null) {
      buildNotification(this, current.title, current.text, current.percent)
    } else {
      buildNotification(this, "GlobalSend is reachable", "Nearby devices can send you files", null)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      var type = 0
      if (current != null) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
      if (presence) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
      startForeground(NOTIFICATION_ID, notification, type)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    if (current != null) acquireLocks() else releaseLocks()
    // Restart in presence mode if the system kills us.
    return if (presence) START_STICKY else START_NOT_STICKY
  }

  override fun onDestroy() {
    releaseLocks()
    super.onDestroy()
  }

  private fun acquireLocks() {
    if (wakeLock == null) {
      val power = getSystemService(Context.POWER_SERVICE) as PowerManager
      // Safety timeout: a forgotten lock must not drain the battery.
      wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "GlobalSend:transfer").apply { acquire(6 * 60 * 60 * 1000L) }
    }
    if (wifiLock == null) {
      val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
      val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) WifiManager.WIFI_MODE_FULL_LOW_LATENCY
      else @Suppress("DEPRECATION") WifiManager.WIFI_MODE_FULL_HIGH_PERF
      wifiLock = wifi.createWifiLock(mode, "GlobalSend:transfer").apply { setReferenceCounted(false); acquire() }
    }
  }

  private fun releaseLocks() {
    wakeLock?.takeIf { it.isHeld }?.release()
    wifiLock?.takeIf { it.isHeld }?.release()
    wakeLock = null
    wifiLock = null
  }

  data class Transfer(val title: String, val text: String, val percent: Int)

  companion object {
    const val NOTIFICATION_ID = 7301
    private const val CHANNEL_ID = "transfers"

    @Volatile var presence = false
    @Volatile var transfer: Transfer? = null

    /** Applies the current [presence] / [transfer] state: start, update or stop. */
    fun refresh(context: Context) {
      val intent = Intent(context, TransferService::class.java)
      if (presence || transfer != null) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
        else context.startService(intent)
      } else {
        context.stopService(intent)
      }
    }

    fun openAppIntent(context: Context): PendingIntent? =
      context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
        PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE)
      }

    private fun buildNotification(context: Context, title: String, text: String, percent: Int?): Notification {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL_ID) == null) {
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Transfers and background", NotificationManager.IMPORTANCE_LOW))
      }
      val builder = NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(if (percent != null) android.R.drawable.stat_sys_download else android.R.drawable.stat_sys_data_bluetooth)
        .setContentTitle(title)
        .setContentText(text)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(openAppIntent(context))
      if (percent != null) builder.setProgress(100, percent.coerceIn(0, 100), percent < 0)
      return builder.build()
    }
  }
}
