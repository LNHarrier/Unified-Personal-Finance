package com.unifiedpersonalfinance.finova.notificationcapture

import android.content.ComponentName
import android.content.Intent
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class NotificationCaptureModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("FinovaNotificationCapture")

    AsyncFunction("hasNotificationAccess") {
      val context = appContext.reactContext ?: throw IllegalStateException("Android app context is unavailable.")
      val expected = ComponentName(context, FinovaNotificationListenerService::class.java).flattenToString()
      val granted = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners")
      granted?.split(":")?.any { ComponentName.unflattenFromString(it)?.flattenToString() == expected } ?: false
    }

    AsyncFunction("openNotificationSettings") {
      val context = appContext.reactContext ?: throw IllegalStateException("Android app context is unavailable.")
      context.startActivity(
        Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      )
    }

    AsyncFunction("setCaptureEnabled") { enabled: Boolean ->
      val context = appContext.reactContext ?: throw IllegalStateException("Android app context is unavailable.")
      CandidateStore.setEnabled(context, enabled)
      if (!enabled) CandidateStore.clear(context)
    }

    AsyncFunction("isCaptureEnabled") {
      val context = appContext.reactContext ?: throw IllegalStateException("Android app context is unavailable.")
      CandidateStore.isEnabled(context)
    }

    AsyncFunction("getCandidates") {
      val context = appContext.reactContext ?: throw IllegalStateException("Android app context is unavailable.")
      CandidateStore.getCandidates(context)
    }

    AsyncFunction("removeCandidate") { candidateId: String ->
      val context = appContext.reactContext ?: throw IllegalStateException("Android app context is unavailable.")
      CandidateStore.remove(context, candidateId)
    }

    AsyncFunction("clearCandidates") {
      val context = appContext.reactContext ?: throw IllegalStateException("Android app context is unavailable.")
      CandidateStore.clear(context)
    }
  }
}
