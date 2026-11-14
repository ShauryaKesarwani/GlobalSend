package com.globalsend.nfc

import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject

/**
 * APDU framing and tap tokens shared by the HCE service (tag side) and the
 * reader (sender side).
 *
 * Exchange:
 *   reader -> SELECT AID (00 A4 04 00 Lc AID 00)
 *   tag    -> [len_hi, len_lo] 90 00          (payload length)
 *   reader -> READ BINARY (00 B0 off_hi off_lo Le), repeated until done
 *   tag    -> chunk 90 00
 *
 * Tokens must match globalsend-core `tap.rs` byte for byte:
 *   token = nonce_hex "." unix_secs "." hex(HMAC-SHA256(secret, "gs-tap-v1|" + nonce_hex + "|" + unix_secs))
 * Test vector (secret = 32 bytes of 0x07, nonce = "ab" x 16, unix_secs = 1700000000):
 *   mac = 5362c439d4b9f043f243190867b0881e24403e64056aa65033bfaf1aa47eb66a
 */
object TapProtocol {
  val AID: ByteArray = hex("F0474C53454E4401")
  val SW_OK = byteArrayOf(0x90.toByte(), 0x00)
  val SW_NOT_READY = byteArrayOf(0x69.toByte(), 0x85.toByte()) // conditions not satisfied
  val SW_UNKNOWN = byteArrayOf(0x6D.toByte(), 0x00) // instruction not supported
  val SW_WRONG_OFFSET = byteArrayOf(0x6B.toByte(), 0x00)
  const val CHUNK = 240

  private val random = SecureRandom()

  /** Set by the app via NfcPlugin.setTapPayload; empty until the Rust engine starts. */
  @Volatile var template: String? = null
  @Volatile var secret: ByteArray? = null

  fun selectApdu(): ByteArray =
    byteArrayOf(0x00, 0xA4.toByte(), 0x04, 0x00, AID.size.toByte()) + AID + byteArrayOf(0x00)

  fun readBinaryApdu(offset: Int, length: Int): ByteArray =
    byteArrayOf(0x00, 0xB0.toByte(), (offset shr 8).toByte(), (offset and 0xFF).toByte(), length.toByte())

  fun isReadBinary(apdu: ByteArray): Boolean = apdu.size >= 4 && apdu[1] == 0xB0.toByte()

  fun endsOk(response: ByteArray): Boolean =
    response.size >= 2 && response[response.size - 2] == 0x90.toByte() && response[response.size - 1] == 0x00.toByte()

  /** Builds the payload for one tap: the template plus a fresh token. */
  fun mintPayload(): String? {
    val template = template ?: return null
    val key = secret ?: return null
    val nonce = ByteArray(16).also { random.nextBytes(it) }.toHex()
    val issued = System.currentTimeMillis() / 1000
    val token = "$nonce.$issued.${mac(key, nonce, issued)}"
    return JSONObject(template).put("token", token).toString()
  }

  // --- NFC Forum Type 4 Tag (NDEF) emulation -------------------------------
  // Lets browsers (Chrome Web NFC) and phones without the app read a one-time
  // website connect link. Standard flow:
  //   SELECT AID D2760000850101 -> SELECT file E103 (CC) -> READ CC
  //   -> SELECT file E104 (NDEF) -> READ NLEN -> READ message

  val NDEF_AID: ByteArray = hex("D2760000850101")
  val CC_FILE: ByteArray = hex("E103")
  val NDEF_FILE: ByteArray = hex("E104")
  val SW_NOT_FOUND = byteArrayOf(0x6A.toByte(), 0x82.toByte())
  private const val MAX_NDEF_FILE = 0x0400

  /** Capability container: mapping v2.0, MLe 0x003B, MLc 0x0034, read-only NDEF file E104 of 1 KB. */
  val CAPABILITY_CONTAINER: ByteArray = hex("000F20003B00340406E104" + "%04X".format(MAX_NDEF_FILE) + "00FF")

  fun isSelectAid(apdu: ByteArray, aid: ByteArray): Boolean {
    if (apdu.size < 5 + aid.size) return false
    if (apdu[1] != 0xA4.toByte() || apdu[2] != 0x04.toByte()) return false
    val lc = apdu[4].toInt() and 0xFF
    return lc == aid.size && apdu.copyOfRange(5, 5 + lc).contentEquals(aid)
  }

  /** SELECT by file id (P1 = 00), as sent by NDEF readers. Returns the 2-byte id or null. */
  fun selectedFileId(apdu: ByteArray): ByteArray? {
    if (apdu.size < 7 || apdu[1] != 0xA4.toByte() || apdu[2] != 0x00.toByte()) return null
    if ((apdu[4].toInt() and 0xFF) != 2) return null
    return apdu.copyOfRange(5, 7)
  }

  /** One-time website link for this tap, or null if offline / no site configured. */
  fun mintLink(): String? {
    val template = template ?: return null
    val key = secret ?: return null
    val url = JSONObject(template).optString("url", "")
    if (url.isEmpty()) return null
    val nonce = ByteArray(16).also { random.nextBytes(it) }.toHex()
    val issued = System.currentTimeMillis() / 1000
    return "$url&nfcToken=$nonce.$issued.${mac(key, nonce, issued)}"
  }

  /** NDEF file contents (2-byte NLEN + message) holding a single URI record. */
  fun ndefFile(url: String): ByteArray? {
    val (prefix, rest) = when {
      url.startsWith("https://") -> 0x04.toByte() to url.removePrefix("https://")
      url.startsWith("http://") -> 0x03.toByte() to url.removePrefix("http://")
      else -> 0x00.toByte() to url
    }
    val payload = byteArrayOf(prefix) + rest.toByteArray(Charsets.UTF_8)
    val record = if (payload.size < 256) {
      // MB | ME | SR, TNF = well-known; type "U"
      byteArrayOf(0xD1.toByte(), 0x01, payload.size.toByte(), 0x55) + payload
    } else {
      val n = payload.size
      byteArrayOf(0xC1.toByte(), 0x01, (n shr 24).toByte(), (n shr 16).toByte(), (n shr 8).toByte(), n.toByte(), 0x55) + payload
    }
    if (record.size + 2 > MAX_NDEF_FILE) return null
    return byteArrayOf((record.size shr 8).toByte(), (record.size and 0xFF).toByte()) + record
  }

  fun mac(key: ByteArray, nonce: String, issued: Long): String {
    val hmac = Mac.getInstance("HmacSHA256")
    hmac.init(SecretKeySpec(key, "HmacSHA256"))
    return hmac.doFinal("gs-tap-v1|$nonce|$issued".toByteArray(Charsets.UTF_8)).toHex()
  }

  fun hex(value: String): ByteArray =
    ByteArray(value.length / 2) { i -> value.substring(i * 2, i * 2 + 2).toInt(16).toByte() }

  private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
}
