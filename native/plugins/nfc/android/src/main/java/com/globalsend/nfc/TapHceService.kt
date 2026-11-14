package com.globalsend.nfc

import android.nfc.cardemulation.HostApduService
import android.os.Bundle

/**
 * Makes this phone look like an NFC tag. Android routes APDUs for our AIDs here
 * even while the app is in the background, as long as the phone is unlocked and
 * the app process is alive. Two ways to read it:
 *
 * - GlobalSend app (AID F0474C53454E4401): full JSON payload with LAN addresses.
 * - Anything that reads NDEF (AID D2760000850101): a one-time website connect
 *   link. Chrome's Web NFC uses this; a phone without the app or site open
 *   simply opens the link.
 *
 * A new token is minted on every SELECT, so each tap is single-use.
 */
class TapHceService : HostApduService() {
  /** File the next READ BINARY reads from. */
  private var selected: ByteArray? = null

  /** NDEF application state (CC + NDEF file) after the NDEF AID was selected. */
  private var ndefFile: ByteArray? = null
  private var inNdefApp = false

  override fun processCommandApdu(apdu: ByteArray, extras: Bundle?): ByteArray {
    if (TapProtocol.isSelectAid(apdu, TapProtocol.AID)) {
      inNdefApp = false
      val payload = TapProtocol.mintPayload()?.toByteArray(Charsets.UTF_8)
        ?: return TapProtocol.SW_NOT_READY
      selected = payload
      return byteArrayOf((payload.size shr 8).toByte(), (payload.size and 0xFF).toByte()) + TapProtocol.SW_OK
    }
    if (TapProtocol.isSelectAid(apdu, TapProtocol.NDEF_AID)) {
      val file = TapProtocol.mintLink()?.let(TapProtocol::ndefFile)
        ?: return TapProtocol.SW_NOT_FOUND // offline or no website configured: act like no tag
      ndefFile = file
      inNdefApp = true
      selected = null
      return TapProtocol.SW_OK
    }
    TapProtocol.selectedFileId(apdu)?.let { id ->
      if (!inNdefApp) return TapProtocol.SW_NOT_FOUND
      selected = when {
        id.contentEquals(TapProtocol.CC_FILE) -> TapProtocol.CAPABILITY_CONTAINER
        id.contentEquals(TapProtocol.NDEF_FILE) -> ndefFile
        else -> null
      }
      return if (selected != null) TapProtocol.SW_OK else TapProtocol.SW_NOT_FOUND
    }
    if (TapProtocol.isReadBinary(apdu)) {
      val file = selected ?: return TapProtocol.SW_NOT_READY
      val offset = ((apdu[2].toInt() and 0xFF) shl 8) or (apdu[3].toInt() and 0xFF)
      if (offset > file.size) return TapProtocol.SW_WRONG_OFFSET
      val requested = if (apdu.size > 4) (apdu[4].toInt() and 0xFF).let { if (it == 0) 256 else it } else TapProtocol.CHUNK
      val end = minOf(file.size, offset + requested)
      return file.copyOfRange(offset, end) + TapProtocol.SW_OK
    }
    return TapProtocol.SW_UNKNOWN
  }

  override fun onDeactivated(reason: Int) {
    selected = null
    ndefFile = null
    inNdefApp = false
  }
}
