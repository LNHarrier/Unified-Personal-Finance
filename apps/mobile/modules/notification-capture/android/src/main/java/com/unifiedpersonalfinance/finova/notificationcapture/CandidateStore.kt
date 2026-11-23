package com.unifiedpersonalfinance.finova.notificationcapture

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object CandidateStore {
  private const val PREFS = "finova_notification_capture"
  private const val DATA_KEY = "encrypted_candidates"
  private const val ENABLED_KEY = "capture_enabled"
  private const val KEY_ALIAS = "FinovaNotificationCaptureKey"
  private const val MAX_CANDIDATES = 100
  private val retentionMillis = TimeUnit.DAYS.toMillis(30)

  fun isEnabled(context: Context): Boolean =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(ENABLED_KEY, false)

  fun setEnabled(context: Context, enabled: Boolean) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(ENABLED_KEY, enabled).apply()
  }

  @Synchronized
  fun add(context: Context, candidate: JSONObject) {
    if (!isEnabled(context)) return
    val now = System.currentTimeMillis()
    val candidates = read(context)
    val valid = JSONArray()
    var duplicate = false
    for (index in 0 until candidates.length()) {
      val item = candidates.getJSONObject(index)
      if (now - item.optLong("receivedAtMillis") > retentionMillis) continue
      if (item.optString("referenceHash") == candidate.optString("referenceHash")) duplicate = true
      valid.put(item)
    }
    if (duplicate || valid.length() >= MAX_CANDIDATES) {
      if (valid.length() != candidates.length()) write(context, valid)
      return
    }
    valid.put(candidate)
    write(context, valid)
  }

  @Synchronized
  fun getCandidates(context: Context): List<Map<String, Any?>> {
    val now = System.currentTimeMillis()
    val candidates = read(context)
    val result = mutableListOf<Map<String, Any?>>()
    val valid = JSONArray()
    for (index in 0 until candidates.length()) {
      val item = candidates.getJSONObject(index)
      if (now - item.optLong("receivedAtMillis") > retentionMillis) continue
      valid.put(item)
      result.add(
        mapOf(
          "candidateId" to item.optString("candidateId"),
          "sourcePackage" to item.optString("sourcePackage"),
          "receivedAt" to item.optString("receivedAt"),
          "receivedAtMillis" to item.optLong("receivedAtMillis"),
          "amountMinor" to item.optLong("amountMinor"),
          "currency" to item.optString("currency"),
          "direction" to item.optString("direction"),
          "description" to item.optString("description"),
          "referenceHash" to item.optString("referenceHash")
        )
      )
    }
    if (valid.length() != candidates.length()) write(context, valid)
    return result
  }

  @Synchronized
  fun remove(context: Context, candidateId: String) {
    val candidates = read(context)
    val remaining = JSONArray()
    for (index in 0 until candidates.length()) {
      val item = candidates.getJSONObject(index)
      if (item.optString("candidateId") != candidateId) remaining.put(item)
    }
    write(context, remaining)
  }

  @Synchronized
  fun clear(context: Context) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(DATA_KEY).apply()
  }

  private fun read(context: Context): JSONArray {
    val encrypted = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(DATA_KEY, null)
      ?: return JSONArray()
    return try {
      val packed = Base64.decode(encrypted, Base64.NO_WRAP)
      val iv = packed.copyOfRange(0, 12)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv))
      JSONArray(String(cipher.doFinal(packed.copyOfRange(12, packed.size)), Charsets.UTF_8))
    } catch (error: Exception) {
      throw IllegalStateException("Could not decrypt local notification candidates.", error)
    }
  }

  private fun write(context: Context, candidates: JSONArray) {
    if (candidates.length() == 0) {
      clear(context)
      return
    }
    try {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, secretKey())
      val encrypted = cipher.doFinal(candidates.toString().toByteArray(Charsets.UTF_8))
      val packed = cipher.iv + encrypted
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        .putString(DATA_KEY, Base64.encodeToString(packed, Base64.NO_WRAP))
        .apply()
    } catch (error: Exception) {
      throw IllegalStateException("Could not encrypt local notification candidates.", error)
    }
  }

  private fun secretKey(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    if (store.containsAlias(KEY_ALIAS)) return store.getKey(KEY_ALIAS, null) as SecretKey
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(
        KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return generator.generateKey()
  }
}
