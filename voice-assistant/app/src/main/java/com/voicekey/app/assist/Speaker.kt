package com.voicekey.app.assist

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.voicekey.app.data.Store
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume

data class VoiceOption(val id: String, val label: String)
data class EngineOption(val pkg: String, val label: String)

/** 語音回覆：引擎、聲音、語速都照設定頁選的來。 */
class Speaker(context: Context, enginePkg: String? = Store.ttsEngine(context)) {
    private val ctx = context.applicationContext
    private val ready = CompletableDeferred<Boolean>()
    private val speaking = ConcurrentHashMap<String, CancellableContinuation<Unit>>()
    private var tts: TextToSpeech? = null

    init {
        val onInit = TextToSpeech.OnInitListener { code ->
            val engine = tts
            if (code != TextToSpeech.SUCCESS || engine == null) {
                ready.complete(false)
                return@OnInitListener
            }
            val ok = listOf(Locale.TAIWAN, Locale.TRADITIONAL_CHINESE, Locale.CHINESE).any {
                runCatching { engine.setLanguage(it) >= TextToSpeech.LANG_AVAILABLE }.getOrDefault(false)
            }
            engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(id: String?) {}
                override fun onDone(id: String?) { finish(id) }
                @Deprecated("Deprecated in Java")
                override fun onError(id: String?) { finish(id) }
                override fun onError(id: String?, errorCode: Int) { finish(id) }
                override fun onStop(id: String?, interrupted: Boolean) { finish(id) }
            })
            applyVoice(Store.ttsVoice(ctx))
            setRate(Store.ttsRate(ctx))
            ready.complete(ok)
        }
        tts = if (enginePkg.isNullOrBlank()) TextToSpeech(ctx, onInit) else TextToSpeech(ctx, onInit, enginePkg)
    }

    private fun finish(id: String?) {
        speaking.remove(id ?: return)?.let { if (it.isActive) it.resume(Unit) }
    }

    private suspend fun engine(): TextToSpeech? {
        val ok = withTimeoutOrNull(2500) { ready.await() } ?: false
        return if (ok) tts else null
    }

    fun applyVoice(id: String?) {
        val engine = tts ?: return
        if (id.isNullOrBlank()) return
        runCatching { engine.voices?.firstOrNull { it.name == id }?.let { engine.voice = it } }
    }

    fun setRate(rate: Float) {
        runCatching { tts?.setSpeechRate(rate.coerceIn(0.5f, 2.0f)) }
    }

    /** 這個引擎裡可用的國語聲音，台灣腔排前面。 */
    suspend fun voices(): List<VoiceOption> {
        val engine = engine() ?: return emptyList()
        val all = runCatching { engine.voices?.toList() }.getOrNull().orEmpty().filter { v ->
            val lang = v.locale.language.lowercase()
            (lang == "zh" || lang == "cmn" || v.name.startsWith("cmn")) &&
                !v.features.orEmpty().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)
        }.sortedWith(compareBy({ if (isTaiwan(it.locale, it.name)) 0 else 1 }, { it.name }))
        var tw = 0
        var other = 0
        return all.map { v ->
            val region = if (isTaiwan(v.locale, v.name)) "台灣 聲音 ${++tw}" else "其他國語 聲音 ${++other}"
            VoiceOption(v.name, region + if (v.isNetworkConnectionRequired) "（需網路）" else "")
        }
    }

    private fun isTaiwan(locale: Locale, name: String) =
        locale.country.equals("TW", true) || name.contains("-tw-", true)

    suspend fun engines(): List<EngineOption> {
        engine()
        return runCatching { tts?.engines?.map { EngineOption(it.name, it.label) } }.getOrNull().orEmpty()
    }

    /** 把話說完才返回，免得接下來的聆聽錄到自己的聲音。 */
    suspend fun say(text: String) {
        if (text.isBlank()) return
        val engine = engine()
        if (engine == null) {
            delay(900)
            return
        }
        val id = Store.newId()
        withTimeoutOrNull(12_000) {
            suspendCancellableCoroutine<Unit> { cont ->
                speaking[id] = cont
                cont.invokeOnCancellation { speaking.remove(id); runCatching { engine.stop() } }
                if (engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) {
                    speaking.remove(id)
                    if (cont.isActive) cont.resume(Unit)
                }
            }
        }
        delay(120)
    }

    fun stop() {
        runCatching { tts?.stop() }
    }

    fun shutdown() {
        tts?.let { runCatching { it.stop() }; runCatching { it.shutdown() } }
        tts = null
    }
}
