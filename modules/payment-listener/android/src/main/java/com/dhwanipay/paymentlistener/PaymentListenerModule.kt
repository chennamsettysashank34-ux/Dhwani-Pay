package com.dhwanipay.paymentlistener

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Expo native module that bridges Android NotificationListenerService broadcasts
 * to the React Native / JS layer via EventEmitter.
 *
 * PaymentNotificationListenerService fires:
 *   Intent("in.dhwanipay.app.PAYMENT_RECEIVED")
 *     - amount: Double
 *     - source: String
 *     - payer: String?
 *     - utr: String?
 *
 * This module re-emits those as JS events: "onPaymentReceived"
 */
class PaymentListenerModule : Module() {
    private var receiver: BroadcastReceiver? = null

    override fun definition() = ModuleDefinition {
        Name("PaymentListener")

        Events("onPaymentReceived")

        AsyncFunction("isPermissionGranted") {
            val ctx = appContext.reactContext ?: return@AsyncFunction false
            val enabledListeners = Settings.Secure.getString(
                ctx.contentResolver,
                "enabled_notification_listeners"
            ) ?: ""
            enabledListeners.contains(ctx.packageName)
        }

        AsyncFunction("openPermissionSettings") {
            val ctx = appContext.reactContext ?: return@AsyncFunction false
            val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            ctx.startActivity(intent)
            true
        }

        OnCreate {
            try {
                val ctx = appContext.reactContext ?: return@OnCreate

                receiver = object : BroadcastReceiver() {
                    override fun onReceive(context: Context?, intent: Intent?) {
                        try {
                            if (intent?.action != "in.dhwanipay.app.PAYMENT_RECEIVED") return

                            val amount = intent.getDoubleExtra("amount", 0.0)
                            val source = intent.getStringExtra("source") ?: "UPI"
                            val payer = intent.getStringExtra("payer") ?: ""
                            val utr = intent.getStringExtra("utr") ?: ""
                            val announcedNatively = intent.getBooleanExtra("announcedNatively", false)

                            if (amount <= 0) return

                            sendEvent(
                                "onPaymentReceived", mapOf(
                                    "amount" to amount,
                                    "source" to source,
                                    "payer" to payer,
                                    "utr" to utr,
                                    "announcedNatively" to announcedNatively
                                )
                            )
                        } catch (t: Throwable) {
                            android.util.Log.e("PaymentListenerModule", "Error handling received payment broadcast", t)
                        }
                    }
                }

                val filter = IntentFilter("in.dhwanipay.app.PAYMENT_RECEIVED")
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    ctx.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
                } else {
                    @Suppress("UnspecifiedRegisterReceiverFlag")
                    ctx.registerReceiver(receiver, filter)
                }
            } catch (t: Throwable) {
                android.util.Log.e("PaymentListenerModule", "Failed to register payment broadcast receiver in OnCreate", t)
            }
        }

        OnDestroy {
            receiver?.let { r ->
                try {
                    appContext.reactContext?.unregisterReceiver(r)
                } catch (_: Throwable) {
                    // Already unregistered or context destroyed
                }
            }
            receiver = null
        }
    }
}
