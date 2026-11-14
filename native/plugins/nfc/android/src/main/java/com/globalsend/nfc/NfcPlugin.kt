package com.globalsend.nfc

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.IsoDep
import android.os.Bundle
import app.tauri.Logger
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayOutputStream
import java.io.IOException

@InvokeArg
class TapPayloadArgs {
  lateinit var template: String
  lateinit var secret: String
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

  override fun onResume() {
    if (pendingRead != null) enableReader()
  }

  override fun onPause() {
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
