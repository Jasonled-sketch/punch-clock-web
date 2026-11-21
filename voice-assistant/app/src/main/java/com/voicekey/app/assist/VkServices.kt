package com.voicekey.app.assist

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
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
class VkInteractionService : VoiceInteractionService()

class VkSessionService : VoiceInteractionSessionService() {
    override fun onNewSession(args: Bundle?): VoiceInteractionSession = VkSession(this)
}

class VkSession(context: Context) : VoiceInteractionSession(context) {
    companion object {
        @Volatile
        var current: VkSession? = null
    }

    override fun onPrepareShow(args: Bundle?, showFlags: Int) {
        super.onPrepareShow(args, showFlags)
        // 畫面由 AssistActivity 負責，不需要系統另外幫這個 session 開視窗
        setUiEnabled(false)
    }

    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        current = this
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
