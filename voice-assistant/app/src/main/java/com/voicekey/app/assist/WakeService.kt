package com.voicekey.app.assist

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.service.voice.VoiceInteractionSession
import ai.picovoice.porcupine.PorcupineActivationException
import ai.picovoice.porcupine.PorcupineActivationLimitException
import ai.picovoice.porcupine.PorcupineActivationRefusedException
import ai.picovoice.porcupine.PorcupineActivationThrottledException
import ai.picovoice.porcupine.PorcupineInvalidArgumentException
import ai.picovoice.porcupine.PorcupineManager
import com.voicekey.app.R
import com.voicekey.app.data.Store
import com.voicekey.app.ui.MainActivity
import java.io.File

/**
 * 呼喊喚醒：常駐在通知列，用 Porcupine 在手機本機聽喚醒詞（聲音不離開手機、不錄下來）。
 * 聽到 → 叫出聆聽畫面；聆聽畫面開著的時候先把麥克風讓出來，關掉後再接著聽。
 */
class WakeService : Service() {

    companion object {
        const val MODEL = "porcupine_params_zh.pv"
        const val KEYWORD_FILE = "wake.ppn"
        private const val CHANNEL = "wake"
        private const val NOTE_ID = 41
        private const val ACTION_STOP = "com.voicekey.app.WAKE_STOP"

        @Volatile
        var running = false
            private set
        @Volatile
        var lastError = ""
            private set
        @Volatile
        private var instance: WakeService? = null

        fun keywordFile(ctx: Context) = File(ctx.filesDir, KEYWORD_FILE)

        /** 還缺什麼才能開；空字串＝都齊了。 */
        fun missing(ctx: Context): String = when {
            ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED -> "還沒有麥克風權限"
            Store.picoKey(ctx).isBlank() -> "還沒有填 Picovoice AccessKey"
            !keywordFile(ctx).exists() -> "還沒有選喚醒詞檔案"
            else -> ""
        }

        /** 回空字串＝已送出啟動；否則是給人看的原因。 */
        fun start(ctx: Context): String {
            missing(ctx).let { if (it.isNotEmpty()) return it }
            return try {
                ctx.startForegroundService(Intent(ctx, WakeService::class.java))
                ""
            } catch (e: Exception) {
                Store.log(ctx, "呼喊喚醒啟動被系統擋下：${e.javaClass.simpleName}")
                "系統不讓它在背景自己啟動，請打開「語音快捷設定」再開一次"
            }
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, WakeService::class.java))
        }

        @Volatile
        private var uiOpen = false

        /** 聆聽畫面要用麥克風：先停聽。 */
        fun pause() { uiOpen = true; instance?.pauseEngine() }

        /** 聆聽畫面關了：接著聽。 */
        fun resume() { uiOpen = false; instance?.resumeEngine() }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var manager: PorcupineManager? = null
    private var listening = false
    private var paused = false
    @Volatile
    private var building = false
    private val resumeLater = Runnable { startListening() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "呼喊喚醒", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) },
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            Store.setWakeEnabled(this, false)
            stopSelf()
            return START_NOT_STICKY
        }
        try {
            if (Build.VERSION.SDK_INT >= 30) startForeground(NOTE_ID, note("準備中…"), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            else startForeground(NOTE_ID, note("準備中…"))
        } catch (e: Exception) {
            // 安卓 14 起：App 不在前景時不能自己開「用麥克風的常駐服務」
            lastError = "系統不讓它在背景自己啟動，請打開「語音快捷設定」再開一次"
            Store.log(this, "呼喊喚醒：${e.javaClass.simpleName}")
            stopSelf()
            return START_NOT_STICKY
        }
        running = true
        lastError = ""
        if (manager != null) {
            startListening()
        } else if (!building) {
            // 引擎第一次啟動要連網驗證金鑰，可能要好幾秒：放到背景做，不能卡住畫面
            building = true
            Thread {
                val ok = buildEngine()
                handler.post {
                    building = false
                    if (instance !== this) { runCatching { manager?.delete() }; manager = null; return@post }
                    if (ok) startListening() else { update(lastError); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf() }
                }
            }.apply { isDaemon = true }.start()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        runCatching { manager?.stop() }
        runCatching { manager?.delete() }
        manager = null
        listening = false
        running = false
        if (instance === this) instance = null
        super.onDestroy()
    }

    private fun buildEngine(): Boolean {
        return try {
            manager = PorcupineManager.Builder()
                .setAccessKey(Store.picoKey(this))
                .setKeywordPath(keywordFile(this).absolutePath)
                .setModelPath(MODEL)
                .setSensitivity(Store.wakeSensitivity(this))
                .setErrorCallback { e -> handler.post { Store.log(this, "呼喊喚醒執行中出錯：${e.javaClass.simpleName}") } }
                .build(applicationContext) { handler.post { onWake() } }
            true
        } catch (e: Exception) {
            lastError = when (e) {
                is PorcupineActivationException, is PorcupineActivationRefusedException -> "Picovoice AccessKey 不對，或這把金鑰不能用"
                is PorcupineActivationLimitException, is PorcupineActivationThrottledException -> "Picovoice 的免費額度用完了，或用得太頻繁"
                is PorcupineInvalidArgumentException -> "喚醒詞檔案不合：請在 Picovoice 後台選「中文」和「Android」重新下載"
                is ai.picovoice.porcupine.PorcupineIOException -> "喚醒詞檔案讀不了，或連不上 Picovoice 驗證金鑰（第一次開要有網路）"
                else -> "喚醒詞引擎啟動失敗（${e.javaClass.simpleName}）"
            }
            Store.log(this, "呼喊喚醒：$lastError")
            false
        }
    }

    private fun startListening() {
        if (paused || listening) return
        val m = manager ?: return
        try {
            m.start()
            listening = true
            update("正在聽喚醒詞")
        } catch (e: Exception) {
            lastError = "麥克風被別的 App 佔用，等一下會再試"
            update("麥克風被佔用，稍後再試")
            handler.removeCallbacks(resumeLater)
            handler.postDelayed(resumeLater, 5000)
        }
    }

    private fun pauseEngine() {
        handler.post {
            paused = true
            handler.removeCallbacks(resumeLater)
            if (listening) { runCatching { manager?.stop() }; listening = false }
            update("聆聽畫面開著，先暫停")
        }
    }

    private fun resumeEngine() {
        handler.post {
            paused = false
            handler.removeCallbacks(resumeLater)
            handler.postDelayed(resumeLater, 600)
        }
    }

    private fun onWake() {
        if (paused) return
        Store.log(this, "聽到喚醒詞")
        // 先把麥克風讓出來，聆聽畫面才收得到聲音
        paused = true
        if (listening) { runCatching { manager?.stop() }; listening = false }
        val service = VkInteractionService.instance
        val shown = service != null && runCatching {
            service.showSession(Bundle(), VoiceInteractionSession.SHOW_WITH_ASSIST or VoiceInteractionSession.SHOW_WITH_SCREENSHOT)
        }.isSuccess
        if (!shown) {
            val intent = Intent(this, AssistActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(AssistActivity.EXTRA_SOURCE, "wake")
            if (runCatching { startActivity(intent) }.isFailure) {
                Store.log(this, "聽到喚醒詞，但系統不讓它跳出畫面（請把語音快捷設成預設數位助理）")
                paused = false
                startListening()
                return
            }
        }
        // 保險：萬一聆聽畫面根本沒開起來（所以不會回頭叫我們繼續），過一下自己接著聽；畫面還開著就不搶麥克風
        handler.removeCallbacks(resumeLater)
        handler.postDelayed({ if (!uiOpen && paused) { paused = false; startListening() } }, 8_000)
    }

    private fun update(text: String) {
        runCatching { getSystemService(NotificationManager::class.java).notify(NOTE_ID, note(text)) }
    }

    private fun note(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(
            this, 1, Intent(this, WakeService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_mic)
            .setContentTitle("語音快捷：呼喊喚醒")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "關閉", stop).build())
            .build()
    }
}
