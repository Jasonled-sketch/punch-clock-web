package com.voicekey.app.assist

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Bundle
import android.service.quicksettings.TileService
import android.service.voice.VoiceInteractionService
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import android.speech.RecognitionListener
import android.speech.RecognitionService
import android.speech.SpeechRecognizer
import com.voicekey.app.data.Store

/** 被選為「預設數位助理」後，系統會常駐綁定這個服務；長按側鍵時由它開出聆聽畫面。 */
class VkInteractionService : VoiceInteractionService() {
    companion object {
        @Volatile
        var instance: VkInteractionService? = null
            private set
    }

    private var power: AutoWakeReceiver? = null

    override fun onReady() {
        super.onReady()
        instance = this
        // 「插上／拔掉充電」只送給正在執行的 App：預設助理是系統常駐綁著的，由它來收
        if (power == null) {
            val r = AutoWakeReceiver()
            val filter = android.content.IntentFilter().apply { addAction(Intent.ACTION_POWER_CONNECTED); addAction(Intent.ACTION_POWER_DISCONNECTED) }
            runCatching {
                androidx.core.content.ContextCompat.registerReceiver(this, r, filter, androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED)
                power = r
            }
        }
        // 開機時本來就插著充電
        if (Store.autoCharge(this) && runCatching { getSystemService(android.os.BatteryManager::class.java).isCharging }.getOrDefault(false)) {
            AutoWake.on(this, "充電中")
        }
        // 開機後系統會自己把預設助理叫起來：呼喊喚醒有開的話順便接著聽（系統不准的話會記一筆，等人打開設定頁再開）
        if (Store.wakeEnabled(this) && !WakeService.running) {
            WakeService.start(this).let { if (it.isNotEmpty()) Store.log(this, "開機後接著聽喚醒詞：$it") }
        }
    }

    override fun onShutdown() {
        power?.let { runCatching { unregisterReceiver(it) } }
        power = null
        instance = null
        super.onShutdown()
    }
}

class VkSessionService : VoiceInteractionSessionService() {
    override fun onNewSession(args: Bundle?): VoiceInteractionSession = VkSession(this)
}

class VkSession(context: Context) : VoiceInteractionSession(context) {
    companion object {
        @Volatile
        var current: VkSession? = null

        @Volatile
        private var shot: Bitmap? = null
        @Volatile
        private var shotAt = 0L
        private const val SHOT_WAIT_MS = 450L
        private const val SHOT_FRESH_MS = 4000L

        /**
         * 叫出助理那一刻的畫面（系統提供、只留在記憶體）。只有說「登記行程」時才會用到，
         * 取一次就清掉；不是剛剛才叫出來的一律不給，免得用到舊畫面。
         */
        fun takeFreshShot(): Bitmap? {
            val b = shot
            val fresh = b != null && System.currentTimeMillis() - shotAt < SHOT_FRESH_MS
            shot = null
            return if (fresh) b else null
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var waiting = false
    private val startNow = Runnable { openUi() }

    override fun onPrepareShow(args: Bundle?, showFlags: Int) {
        super.onPrepareShow(args, showFlags)
        // 畫面由 AssistActivity 負責，不需要系統另外幫這個 session 開視窗
        setUiEnabled(false)
    }

    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        current = this
        shot = null
        // 系統會給畫面截圖時，先等它到（最多不到半秒）再開聆聽畫面，截圖裡才不會拍到我們自己
        if (showFlags and SHOW_WITH_SCREENSHOT != 0) {
            waiting = true
            handler.postDelayed(startNow, SHOT_WAIT_MS)
        } else {
            openUi()
        }
    }

    override fun onHandleScreenshot(screenshot: Bitmap?) {
        shot = screenshot
        shotAt = System.currentTimeMillis()
        if (waiting) {
            handler.removeCallbacks(startNow)
            openUi()
        }
    }

    private fun openUi() {
        waiting = false
        val intent = Intent(context, AssistActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(AssistActivity.EXTRA_SOURCE, "assistant")
        try {
            startAssistantActivity(intent)
        } catch (e: Exception) {
            Store.log(context, "startAssistantActivity 失敗：${e.message}，改用一般方式開啟")
            runCatching { context.startActivity(intent) }
                .onFailure { Store.log(context, "開啟聆聽畫面失敗：${it.message}") }
        }
    }

    override fun onDestroy() {
        handler.removeCallbacks(startNow)
        if (current === this) current = null
        super.onDestroy()
    }
}

/**
 * 系統規定助理 App 必須附一個語音辨識服務，而且選為預設助理後，
 * 其他 App 的語音輸入也會被導到這裡。所以這裡把請求原封不動轉給真正的辨識引擎，
 * 不影響其他 App。
 */
class VkRecognitionService : RecognitionService() {
    private var real: SpeechRecognizer? = null

    override fun onStartListening(recognizerIntent: Intent, listener: Callback) {
        release()
        val target = Store.recognizer(this)
        if (target == null) {
            runCatching { listener.error(SpeechRecognizer.ERROR_CLIENT) }
            return
        }
        val sr = SpeechRecognizer.createSpeechRecognizer(this, target)
        real = sr
        sr.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) { runCatching { listener.readyForSpeech(params) } }
            override fun onBeginningOfSpeech() { runCatching { listener.beginningOfSpeech() } }
            override fun onRmsChanged(rmsdB: Float) { runCatching { listener.rmsChanged(rmsdB) } }
            override fun onBufferReceived(buffer: ByteArray?) { runCatching { listener.bufferReceived(buffer) } }
            override fun onEndOfSpeech() { runCatching { listener.endOfSpeech() } }
            override fun onError(error: Int) { runCatching { listener.error(error) }; release() }
            override fun onResults(results: Bundle?) { runCatching { listener.results(results) }; release() }
            override fun onPartialResults(partial: Bundle?) { runCatching { listener.partialResults(partial) } }
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        sr.startListening(recognizerIntent)
    }

    override fun onStopListening(listener: Callback) {
        real?.stopListening()
    }

    override fun onCancel(listener: Callback) {
        release()
    }

    override fun onDestroy() {
        release()
        super.onDestroy()
    }

    private fun release() {
        real?.let { runCatching { it.cancel() }; runCatching { it.destroy() } }
        real = null
    }
}

/** 快速面板的按鈕：下拉通知列點一下就開始聽。 */
class QuickTile : TileService() {
    override fun onClick() {
        val intent = Intent(this, AssistActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(AssistActivity.EXTRA_SOURCE, "tile")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startActivityAndCollapse(
                PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT),
            )
        } else {
            @Suppress("DEPRECATION", "StartActivityAndCollapseDeprecated")
            startActivityAndCollapse(intent)
        }
    }
}
