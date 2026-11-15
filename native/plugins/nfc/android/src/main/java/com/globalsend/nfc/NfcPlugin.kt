package com.globalsend.nfc

import android.Manifest
import android.app.Activity
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import android.net.wifi.WifiManager
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.IsoDep
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import app.tauri.Logger
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException

@InvokeArg
class TapPayloadArgs {
  lateinit var template: String
  lateinit var secret: String
}

@InvokeArg
class UriArgs {
  lateinit var uri: String
}

@InvokeArg
class TransferStatusArgs {
  var active: Boolean = false
  var title: String = ""
  var text: String = ""
  var percent: Int = -1
}

@InvokeArg
class RequestArgs {
  lateinit var requestId: String
  var title: String = ""
  var text: String = ""
}

@InvokeArg
class PresenceArgs {
  var enabled: Boolean = false
}

@InvokeArg
class PublishArgs {
  lateinit var path: String
  lateinit var name: String
}

@TauriPlugin
class NfcPlugin(private val activity: Activity) : Plugin(activity) {
  private val adapter: NfcAdapter? by lazy { NfcAdapter.getDefaultAdapter(activity) }
  private var multicastLock: WifiManager.MulticastLock? = null

  /** The pending readTap call; non-null while reader mode should be on. */
  @Volatile private var pendingRead: Invoke? = null

  @Command
  fun status(invoke: Invoke) {
    val nfc = adapter
    val result = JSObject()
    result.put("supported", nfc != null)
    result.put("enabled", nfc?.isEnabled == true)
    result.put(
      "cardEmulation",
      activity.packageManager.hasSystemFeature(PackageManager.FEATURE_NFC_HOST_CARD_EMULATION),
    )
    invoke.resolve(result)
  }

  /** Called by Rust whenever our name, IPs, port or signaling id change. */
  @Command
  fun setTapPayload(invoke: Invoke) {
    val args = invoke.parseArgs(TapPayloadArgs::class.java)
    TapProtocol.secret = TapProtocol.hex(args.secret)
    TapProtocol.template = args.template
    invoke.resolve()
  }

  /** Waits for the user to tap another GlobalSend phone; resolves with its payload JSON. */
  @Command
  fun readTap(invoke: Invoke) {
    val nfc = adapter ?: return invoke.reject("This device has no NFC")
    if (!nfc.isEnabled) return invoke.reject("NFC is turned off")
    pendingRead?.reject("Replaced by a new tap request")
    pendingRead = invoke
    enableReader()
  }

  @Command
  fun cancelRead(invoke: Invoke) {
    pendingRead?.reject("cancelled")
    pendingRead = null
    disableReader()
    invoke.resolve()
  }

  @Command
  fun acquireMulticastLock(invoke: Invoke) {
    if (multicastLock == null) {
      val wifi = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
      multicastLock = wifi.createMulticastLock("globalsend-lan").apply {
        setReferenceCounted(false)
        acquire()
      }
    }
    invoke.resolve()
  }

  override fun load(webView: WebView) {
    // Android 13+: needed to show transfer progress while in the background.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7302)
    }
  }

  /** Real file name of a picked content:// URI (the URI itself is often just an id). */
  @Command
  fun displayName(invoke: Invoke) {
    val args = invoke.parseArgs(UriArgs::class.java)
    val name = try {
      activity.contentResolver.query(Uri.parse(args.uri), arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
        if (it.moveToFirst()) it.getString(0) else null
      }
    } catch (e: Exception) {
      null
    }
    invoke.resolve(JSObject().apply { put("name", name) })
  }

  /** Starts, updates or stops the foreground service that keeps transfers alive. */
  @Command
  fun transferStatus(invoke: Invoke) {
    val args = invoke.parseArgs(TransferStatusArgs::class.java)
    try {
      TransferService.transfer = if (args.active) TransferService.Transfer(args.title, args.text, args.percent) else null
      TransferService.refresh(activity)
      invoke.resolve()
    } catch (e: Exception) {
      // e.g. Android 12+ refuses to start a foreground service from the background.
      invoke.reject(e.message ?: "Could not start the transfer service")
    }
  }

  /** "Stay reachable": keep running in the background so nearby devices can send. */
  @Command
  fun setPresence(invoke: Invoke) {
    val args = invoke.parseArgs(PresenceArgs::class.java)
    try {
      TransferService.presence = args.enabled
      TransferService.refresh(activity)
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject(e.message ?: "Could not change background mode")
    }
  }

  /** Accept/Decline notification for an incoming request, only when the app isn't on screen. */
  @Command
  fun notifyRequest(invoke: Invoke) {
    val args = invoke.parseArgs(RequestArgs::class.java)
    if (!foreground) RequestNotifications.show(activity, args.requestId, args.title, args.text)
    invoke.resolve()
  }

  @Command
  fun cancelRequest(invoke: Invoke) {
    RequestNotifications.cancel(activity, invoke.parseArgs(RequestArgs::class.java).requestId)
    invoke.resolve()
  }

  /** Long-poll used by Rust: resolves with the next notification button press. */
  @Command
  fun nextRequestAction(invoke: Invoke) {
    RequestNotifications.next(invoke)
  }

  /**
   * Moves a received file from the app's private folder into the public
   * Download/GlobalSend folder via MediaStore, so it shows up in Files and
   * Photos. Needs Android 10+; older versions keep the private copy.
   */
  @Command
  fun publishDownload(invoke: Invoke) {
    val args = invoke.parseArgs(PublishArgs::class.java)
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      return invoke.resolve(JSObject().apply { put("path", args.path) })
    }
    Thread {
      try {
        val source = File(args.path)
        val public = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "GlobalSend")
        if (source.absolutePath.startsWith(public.absolutePath)) {
          // Already in public Downloads: just tell the media scanner so Photos/Files see it.
          MediaScannerConnection.scanFile(activity, arrayOf(source.absolutePath), null, null)
          return@Thread invoke.resolve(JSObject().apply { put("path", "Download/GlobalSend/${source.name}") })
        }
        val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(source.extension.lowercase())
          ?: "application/octet-stream"
        val folder = Environment.DIRECTORY_DOWNLOADS + "/GlobalSend"
        val resolver = activity.contentResolver
        val values = ContentValues().apply {
          put(MediaStore.MediaColumns.DISPLAY_NAME, args.name)
          put(MediaStore.MediaColumns.MIME_TYPE, mime)
          put(MediaStore.MediaColumns.RELATIVE_PATH, folder)
          put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
          ?: throw IOException("Could not create the file in Downloads")
        try {
          resolver.openOutputStream(uri)?.use { out -> source.inputStream().use { it.copyTo(out, 1 shl 20) } }
            ?: throw IOException("Could not write to Downloads")
          resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        } catch (e: Exception) {
          resolver.delete(uri, null, null)
          throw e
        }
        source.delete()
        // MediaStore may have renamed it to avoid a clash ("photo (1).jpg").
        val savedName = resolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)?.use {
          if (it.moveToFirst()) it.getString(0) else null
        } ?: args.name
        invoke.resolve(JSObject().apply { put("path", "$folder/$savedName") })
      } catch (e: Exception) {
        invoke.reject(e.message ?: "Could not save to Downloads")
      }
    }.start()
  }

  /** Whether the app is on screen (then the in-app prompt is enough). */
  @Volatile private var foreground = true

  override fun onResume() {
    foreground = true
    if (pendingRead != null) enableReader()
  }

  override fun onPause() {
    foreground = false
    // Reader mode is tied to the foreground activity; onResume turns it back on.
    disableReader()
  }

  private fun enableReader() {
    val nfc = adapter ?: return
    activity.runOnUiThread {
      val extras = Bundle().apply { putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, 250) }
      nfc.enableReaderMode(
        activity,
        { tag -> onTag(tag) },
        NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_NFC_B or NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK,
        extras,
      )
    }
  }

  private fun disableReader() {
    val nfc = adapter ?: return
    activity.runOnUiThread {
      try {
        nfc.disableReaderMode(activity)
      } catch (e: IllegalStateException) {
        // Activity not resumed; nothing to disable.
      }
    }
  }

  private fun onTag(tag: Tag) {
    val iso = IsoDep.get(tag) ?: return // Not a phone running HCE.
    try {
      iso.connect()
      iso.timeout = 2000
      val selected = iso.transceive(TapProtocol.selectApdu())
      if (!TapProtocol.endsOk(selected) || selected.size != 4) {
        Logger.info("GlobalSend", "Tapped device is not running GlobalSend")
        return
      }
      val length = ((selected[0].toInt() and 0xFF) shl 8) or (selected[1].toInt() and 0xFF)
      val out = ByteArrayOutputStream(length)
      while (out.size() < length) {
        val want = minOf(TapProtocol.CHUNK, length - out.size())
        val chunk = iso.transceive(TapProtocol.readBinaryApdu(out.size(), want))
        if (!TapProtocol.endsOk(chunk) || chunk.size <= 2) throw IOException("bad read response")
        out.write(chunk, 0, chunk.size - 2)
      }
      val invoke = pendingRead ?: return
      pendingRead = null
      disableReader()
      val result = JSObject()
      result.put("payload", String(out.toByteArray(), Charsets.UTF_8))
      invoke.resolve(result)
    } catch (e: IOException) {
      // Phones moved apart mid-read; keep reader mode on so the user can tap again.
      Logger.info("GlobalSend", "NFC read interrupted: ${e.message}")
    } finally {
      try {
        iso.close()
      } catch (_: IOException) {
      }
    }
  }
}
