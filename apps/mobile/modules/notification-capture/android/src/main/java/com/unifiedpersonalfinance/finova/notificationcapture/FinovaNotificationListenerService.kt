package com.unifiedpersonalfinance.finova.notificationcapture

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import org.json.JSONObject
import java.math.BigDecimal
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

class FinovaNotificationListenerService : NotificationListenerService() {
  companion object {
    private const val TAG = "FinovaNotification"
    private val supportedPackages = setOf(
      "com.google.android.apps.nbu.paisa.user",
      "net.one97.paytm",
      "com.phonepe.app"
    )
    private val amountPattern = Regex("(?:₹|INR\\s*|Rs\\.?\\s*)([0-9][0-9,]*(?:\\.[0-9]{1,2})?)", RegexOption.IGNORE_CASE)
    private val outgoingPattern = Regex("\\b(debited|paid|spent|sent|transferred|purchase)\\b", RegexOption.IGNORE_CASE)
    private val incomingPattern = Regex("\\b(credited|received|refunded)\\b", RegexOption.IGNORE_CASE)
    private val failedPattern = Regex("\\b(failed|declined|pending|reversed|cancelled)\\b", RegexOption.IGNORE_CASE)
  }

  override fun onNotificationPosted(notification: StatusBarNotification) {
    if (!CandidateStore.isEnabled(this) || notification.packageName !in supportedPackages) return
    val extras = notification.notification.extras ?: return
    val title = extras.getCharSequence("android.title")?.toString().orEmpty()
    val body = extras.getCharSequence("android.text")?.toString().orEmpty()
    val bigText = extras.getCharSequence("android.bigText")?.toString().orEmpty()
    val message = listOf(title, body, bigText).filter { it.isNotBlank() }.joinToString(" ").take(3000)
    if (message.isBlank() || failedPattern.containsMatchIn(message)) return
    val outgoing = outgoingPattern.containsMatchIn(message)
    val incoming = incomingPattern.containsMatchIn(message)
    if (outgoing == incoming) return
    val amountText = amountPattern.find(message)?.groupValues?.getOrNull(1) ?: return
    val amountMinor = try {
      BigDecimal(amountText.replace(",", "")).movePointRight(2).longValueExact()
    } catch (_: Exception) {
      return
    }
    if (amountMinor <= 0) return
    val referenceHash = sha256(notification.key ?: "${notification.packageName}:${notification.postTime}:$amountMinor")
    val merchant = Regex("\\b(?:at|to|from)\\s+([^,;]+?)(?:\\s+(?:via|using|on|ref|utr)\\b|$)", RegexOption.IGNORE_CASE)
      .find(message)?.groupValues?.getOrNull(1)?.trim()?.take(100)
      ?: "Payment via ${notification.packageName.substringAfterLast('.')}"
    val receivedAt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
      timeZone = TimeZone.getTimeZone("UTC")
    }.format(Date(notification.postTime))
    val candidate = JSONObject()
      .put("candidateId", UUID.nameUUIDFromBytes(referenceHash.toByteArray()).toString())
      .put("sourcePackage", notification.packageName)
      .put("receivedAt", receivedAt)
      .put("receivedAtMillis", notification.postTime)
      .put("amountMinor", amountMinor)
      .put("currency", "INR")
      .put("direction", if (outgoing) "expense" else "income")
      .put("description", merchant)
      .put("referenceHash", referenceHash)
    try {
      CandidateStore.add(this, candidate)
    } catch (error: Exception) {
      Log.e(TAG, "Notification candidate could not be stored securely.", error)
    }
  }

  private fun sha256(value: String): String =
    MessageDigest.getInstance("SHA-256")
      .digest(value.toByteArray(Charsets.UTF_8))
      .joinToString("") { "%02x".format(it) }
}
