package `in`.dhwanipay.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import androidx.core.app.NotificationCompat
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.regex.Pattern

/**
 * Hardened Android NotificationListenerService for DhwaniPay Soundbox
 *
 * Intercepts incoming UPI payment notifications from:
 * - Google Pay for Business & Consumer (com.google.android.apps.nbu.paisa.*)
 * - PhonePe for Business & Consumer (com.phonepe.app.*)
 * - Paytm for Business (net.one97.paytm)
 * - BHIM UPI (in.org.npci.upiapp)
 * - BharatPe (com.bharatpe.app)
 * - Verified Bank Transaction SMS (Default Android Messaging, Samsung Messages)
 *
 * Core Guarantees:
 * 1. Single Voice Owner: Native code speaks payment; sends announcedNatively=true to React Native.
 * 2. UtteranceProgressListener: Keeps WakeLock held during actual speech playback, then cleanly releases.
 * 3. Replay & Duplicate Prevention: Sliding 120-second window on (amount + payer + utr).
 * 4. Negative Pattern Filtering: Rejects debits, failures, cashback promos, and payment requests.
 */
class PaymentNotificationListenerService : NotificationListenerService(), TextToSpeech.OnInitListener {

    companion object {
        private const val TAG = "DhwaniPayListener"
        private const val CHANNEL_ID = "dhwanipay_soundbox_service"
        private const val NOTIFICATION_ID = 8801

        // Supported Indian payment package names
        private val SUPPORTED_PACKAGES = setOf(
            "com.google.android.apps.nbu.paisa.merchant", // Google Pay for Business
            "com.google.android.apps.nbu.paisa.user",     // Google Pay
            "com.phonepe.app.business",                   // PhonePe Merchant
            "com.phonepe.app",                            // PhonePe Consumer
            "net.one97.paytm",                            // Paytm
            "in.org.npci.upiapp",                         // BHIM UPI
            "com.bharatpe.app",                           // BharatPe
            "com.google.android.apps.messaging",          // Default Android SMS
            "com.samsung.android.messaging"               // Samsung SMS
        )

        // Strict positive credit regex patterns
        private val AMOUNT_PATTERN = Pattern.compile(
            "(?i)(?:received|credited|received\\s+payment\\s+of|payment\\s+of)\\s*(?:rs\\.?|inr|₹)?\\s*([0-9,]+(?:\\.[0-9]{1,2})?)",
            Pattern.CASE_INSENSITIVE
        )
        private val FALLBACK_AMOUNT_PATTERN = Pattern.compile(
            "(?i)(?:rs\\.?|inr|₹)\\s*([0-9,]+(?:\\.[0-9]{1,2})?)",
            Pattern.CASE_INSENSITIVE
        )
        private val PAYER_PATTERN = Pattern.compile(
            "(?i)(?:from|by)\\s+([a-zA-Z\\s]{2,30}?)(?=\\s+(?:on|via|with|using|through|in|at)\\b|[.,(]|\\s*$)",
            Pattern.CASE_INSENSITIVE
        )
        private val UTR_PATTERN = Pattern.compile(
            "(?i)(?:utr|ref(?:erence)?\\s*(?:no|id)?|txn\\s*id)[\\s:]*([0-9]{8,16})",
            Pattern.CASE_INSENSITIVE
        )

        // Negative indicators (debits, failures, promos)
        private val NEGATIVE_KEYWORDS = listOf(
            "debited", "paid to", "sent to", "you paid", "withdrawn",
            "payment sent", "failed", "declined", "unsuccessful", "reversed",
            "reminder to", "requested", "request to pay", "collect request",
            "cashback offer", "scratch card", "win up to", "reward", "coupon"
        )

        // Deduplication cache: key -> timestamp (expires after 120 seconds)
        private val recentAnnouncements = ConcurrentHashMap<String, Long>()
    }

    private var tts: TextToSpeech? = null
    private var isTtsReady = false
    private var wakeLock: PowerManager.WakeLock? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var wakeLockTimeoutRunnable: Runnable? = null

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "DhwaniPay Notification Listener Service starting")
        try {
            tts = TextToSpeech(applicationContext, this)

            val powerManager = getSystemService(Context.POWER_SERVICE) as? PowerManager
            wakeLock = powerManager?.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "DhwaniPay::PaymentAnnouncementWakeLock"
            )

            createNotificationChannel()
            startForegroundServiceNotification()
        } catch (e: Exception) {
            Log.e(TAG, "Error in onCreate", e)
        }
    }

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            val result = tts?.setLanguage(Locale("en", "IN"))
            if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
                tts?.setLanguage(Locale.US)
            }
            tts?.setSpeechRate(0.9f)

            // Setup UtteranceProgressListener to manage WakeLock lifecycle accurately
            tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {
                    Log.d(TAG, "TTS Utterance started: $utteranceId")
                }

                override fun onDone(utteranceId: String?) {
                    Log.d(TAG, "TTS Utterance completed: $utteranceId")
                    releaseWakeLockSafely()
                }

                override fun onError(utteranceId: String?) {
                    Log.w(TAG, "TTS Utterance failed: $utteranceId")
                    releaseWakeLockSafely()
                }

                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?, errorCode: Int) {
                    Log.w(TAG, "TTS Utterance failed with code $errorCode: $utteranceId")
                    releaseWakeLockSafely()
                }
            })

            isTtsReady = true
            Log.i(TAG, "Native TextToSpeech initialized with UtteranceProgressListener")
        } else {
            Log.e(TAG, "Native TextToSpeech initialization failed with code: $status")
        }
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null) return

        val packageName = sbn.packageName ?: return
        if (!SUPPORTED_PACKAGES.contains(packageName)) return

        val extras = sbn.notification?.extras ?: return
        val title = extras.getCharSequence("android.title")?.toString() ?: ""
        val text = extras.getCharSequence("android.text")?.toString() ?: ""
        val bigText = extras.getCharSequence("android.bigText")?.toString() ?: ""

        val fullContent = "$title $text $bigText".trim()
        if (fullContent.isEmpty()) return

        parseAndAnnounce(packageName, fullContent)
    }

    private fun parseAndAnnounce(packageName: String, content: String) {
        val lower = content.lowercase(Locale.ROOT)

        // 1. Negative checks: reject debits, failures, requests, and marketing messages
        for (keyword in NEGATIVE_KEYWORDS) {
            if (lower.contains(keyword)) {
                Log.d(TAG, "Notification rejected due to negative keyword '$keyword': $content")
                return
            }
        }

        // 2. Positive credit check
        val isCredit = lower.contains("received") || lower.contains("credited") ||
                lower.contains("paid you") || lower.contains("sent you")
        if (!isCredit) return

        // 3. Extract Amount
        var amount: Double? = null
        var matcher = AMOUNT_PATTERN.matcher(content)
        if (matcher.find()) {
            amount = cleanAmount(matcher.group(1))
        } else {
            matcher = FALLBACK_AMOUNT_PATTERN.matcher(content)
            if (matcher.find()) {
                amount = cleanAmount(matcher.group(1))
            }
        }

        if (amount == null || amount <= 0 || amount > 1_000_000) {
            Log.d(TAG, "Invalid amount extracted: $amount")
            return
        }

        // 4. Extract Payer Name (Optional)
        var payer: String? = null
        val payerMatcher = PAYER_PATTERN.matcher(content)
        if (payerMatcher.find()) {
            payer = payerMatcher.group(1)?.trim()
        }

        // 5. Extract UTR / Txn Reference (Optional)
        var utr: String? = null
        val utrMatcher = UTR_PATTERN.matcher(content)
        if (utrMatcher.find()) {
            utr = utrMatcher.group(1)?.trim()
        }

        // 6. Source App Identifier
        val sourceName = when (packageName) {
            "com.google.android.apps.nbu.paisa.merchant" -> "Google Pay for Business"
            "com.google.android.apps.nbu.paisa.user" -> "Google Pay"
            "com.phonepe.app.business" -> "PhonePe for Business"
            "com.phonepe.app" -> "PhonePe"
            "net.one97.paytm" -> "Paytm"
            "in.org.npci.upiapp" -> "BHIM UPI"
            "com.bharatpe.app" -> "BharatPe"
            else -> "Bank UPI"
        }

        // 7. Deduplication check (120-second window)
        val dedupeKey = "${amount}_${payer ?: "anon"}_${utr ?: content.hashCode()}"
        val now = System.currentTimeMillis()
        val lastSeen = recentAnnouncements[dedupeKey]

        if (lastSeen != null && (now - lastSeen) < 120_000) {
            Log.d(TAG, "Duplicate payment notification ignored: $dedupeKey")
            return
        }

        recentAnnouncements[dedupeKey] = now
        cleanupOldAnnouncements(now)

        // 8. Speak payment aloud natively (single voice owner)
        speakPaymentNatively(amount, sourceName, payer)

        // 9. Broadcast event to React Native UI with announcedNatively=true
        broadcastToReactNative(amount, sourceName, payer, utr, announcedNatively = true)
    }

    private fun cleanAmount(raw: String?): Double? {
        if (raw == null) return null
        return try {
            raw.replace(",", "").toDouble()
        } catch (_: Exception) {
            null
        }
    }

    private fun speakPaymentNatively(amount: Double, source: String, payer: String?) {
        try {
            acquireWakeLockWithTimeout(15000L) // 15s max safety ceiling

            val amountInt = if (amount % 1.0 == 0.0) amount.toInt().toString() else amount.toString()
            val speechText = if (!payer.isNullOrBlank()) {
                "Received $amountInt rupees from $payer on $source."
            } else {
                "Received $amountInt rupees on $source."
            }

            Log.i(TAG, "Announcing natively: $speechText")

            if (isTtsReady && tts != null) {
                tts?.stop()
                val utteranceId = "dhwani_${System.currentTimeMillis()}"
                tts?.speak(speechText, TextToSpeech.QUEUE_FLUSH, null, utteranceId)
            } else {
                Log.w(TAG, "TTS not ready for speech playback")
                releaseWakeLockSafely()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error in speakPaymentNatively", e)
            releaseWakeLockSafely()
        }
    }

    private fun acquireWakeLockWithTimeout(timeoutMs: Long) {
        try {
            if (wakeLock?.isHeld != true) {
                wakeLock?.acquire(timeoutMs)
            }
            // Clear existing timeout
            wakeLockTimeoutRunnable?.let { mainHandler.removeCallbacks(it) }
            // Schedule safety release
            wakeLockTimeoutRunnable = Runnable { releaseWakeLockSafely() }
            mainHandler.postDelayed(wakeLockTimeoutRunnable!!, timeoutMs)
        } catch (e: Exception) {
            Log.w(TAG, "Could not acquire WakeLock: ${e.message}")
        }
    }

    private fun releaseWakeLockSafely() {
        try {
            wakeLockTimeoutRunnable?.let { mainHandler.removeCallbacks(it) }
            wakeLockTimeoutRunnable = null
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
                Log.d(TAG, "WakeLock safely released")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Error releasing WakeLock: ${e.message}")
        }
    }

    private fun broadcastToReactNative(
        amount: Double,
        source: String,
        payer: String?,
        utr: String?,
        announcedNatively: Boolean
    ) {
        val intent = Intent("in.dhwanipay.app.PAYMENT_RECEIVED").apply {
            putExtra("amount", amount)
            putExtra("source", source)
            putExtra("payer", payer)
            putExtra("utr", utr)
            putExtra("announcedNatively", announcedNatively)
            setPackage(packageName)
        }
        sendBroadcast(intent)
    }

    private fun cleanupOldAnnouncements(now: Long) {
        val iterator = recentAnnouncements.entries.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            if (now - entry.value > 300_000) { // 5 minutes
                iterator.remove()
            }
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "DhwaniPay Soundbox Service",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Monitors incoming UPI merchant notifications and announces payments."
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }
    }

    private fun startForegroundServiceNotification() {
        try {
            val notificationIntent = packageManager.getLaunchIntentForPackage(packageName) ?: return
            val pendingIntent = PendingIntent.getActivity(
                this,
                0,
                notificationIntent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )

            val safeIcon = if (applicationInfo.icon != 0) applicationInfo.icon else android.R.drawable.ic_dialog_info

            val notification = NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("DhwaniPay Soundbox Active")
                .setContentText("Listening for incoming PhonePe, Google Pay & Paytm payments")
                .setSmallIcon(safeIcon)
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build()

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "Foreground notification start skipped or failed: ${t.message}")
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        tts?.stop()
        tts?.shutdown()
        releaseWakeLockSafely()
        Log.i(TAG, "DhwaniPay Notification Listener Service destroyed")
    }
}
