package com.voicekey.app.assist

import android.Manifest
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.lifecycleScope
import com.voicekey.app.actions.ActionRunner
import com.voicekey.app.core.Config
import com.voicekey.app.core.Matcher
import com.voicekey.app.core.Parsed
import com.voicekey.app.core.Protection
import com.voicekey.app.core.Spoken
import com.voicekey.app.data.Store
import com.voicekey.app.ui.MainActivity
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume

/** 聆聽畫面：聽指令 → 比對 →（確認／密碼）→ 執行。 */
class AssistActivity : ComponentActivity() {

    companion object {
        const val EXTRA_SOURCE = "source"

        /** 設定頁「打字執行」用：只能由本 App 自己設定，外部 App 塞不進來。 */
        @Volatile
        var pendingText: String? = null
        private const val LISTEN_TIMEOUT_MS = 12_000L
        private val YES_NO_BIAS = listOf("好", "好的", "確定", "對", "可以", "沒問題", "取消", "不要", "不用")
    }

    private enum class Mode { IDLE, LISTENING, WORKING, OK, ERROR }

    private var status by mutableStateOf("準備中…")
    private var heardText by mutableStateOf("")
    private var mode by mutableStateOf(Mode.IDLE)
    private var canRetry by mutableStateOf(false)

    private lateinit var speaker: Speaker

    /** 正在等「好／取消」時不是 null：畫面會多出兩顆按鈕，按了等於說了。 */
    private var choice by mutableStateOf<CompletableDeferred<Boolean>?>(null)
    private var redactSecret = ""
    private var recognizer: SpeechRecognizer? = null
    private var flow: Job? = null
    private var unlocking = false
    private var listenError = 0

    /** 只有測試版（debuggable）才會有內容：用 adb 預先排好後續要「說」的回答，方便在沒有麥克風的模擬器上跑完整流程。 */
    private val scriptedAnswers = ArrayDeque<String>()

    private val askMic = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) start() else {
            mode = Mode.ERROR
            status = "需要麥克風權限才能聽指令"
            canRetry = true
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        speaker = Speaker(this)
        setContent { AssistScreen() }
        start()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        start()
    }

    override fun onStop() {
        super.onStop()
        // 跳去別的 App（撥號、LINE）或被蓋住時就收掉，不留在背景偷聽
        if (!isChangingConfigurations && !unlocking) {
            flow?.cancel()
            stopListening()
            if (!isFinishing) finish()
        }
    }

    override fun onDestroy() {
        flow?.cancel()
        stopListening()
        speaker.shutdown()
        runCatching { VkSession.current?.hide() }
        super.onDestroy()
    }

    private fun start() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            askMic.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        flow?.cancel()
        stopListening()
        flow = lifecycleScope.launch { runFlow() }
    }

    // ---- 主流程 ----

    private suspend fun runFlow() {
        canRetry = false
        heardText = ""
        choice = null
        val shot = VkSession.takeFreshShot()
        val config = Store.config(this)
        val secret = Store.secret(this)
        redactSecret = secret

        val typed = takeTypedText()
        val heard = if (typed != null) listOf(typed) else {
            show(Mode.LISTENING, "我在聽，請說")
            listen(bias(config), showHeard = true)
        }
        if (heard.isEmpty()) {
            giveUp(silenceReason(), speak = false)
            return
        }
        heardText = Spoken.redact(heard.first(), secret)
        Store.log(this, "聽到：${heard.map { Spoken.redact(it, secret) }}")

        val result = Matcher.match(heard, config, Store.apps(this))
        val parsed = result.parsed
        if (parsed is Parsed.Unknown) {
            Store.log(this, "比對不到")
            giveUp(parsed.reason.ifEmpty { "不好意思，我沒聽懂，可以再說一次嗎" })
            return
        }
        val what = Matcher.describe(parsed)
        Store.log(this, "比對到：$what（${"%.2f".format(result.score)}）")

        val toCal = when (parsed) {
            is Parsed.Schedule -> parsed.detail
            is Parsed.Keep -> parsed.detail
            else -> null
        }
        if (toCal != null) {
            ActionRunner.calendarProblem(this, toCal, shot)?.let { problem ->
                Store.log(this, "$what：$problem")
                giveUp(problem)
                return
            }
        }

        var confirmed = false
        if (result.score < Matcher.EXECUTE) {
            if (!askYesNo("你是要，$what，對嗎？")) {
                giveUp("好，那先不做")
                return
            }
            confirmed = true
        }

        if (ActionRunner.needsUnlock(parsed) && isLocked()) {
            show(Mode.WORKING, "麻煩先解鎖手機")
            if (!unlock()) {
                giveUp("手機沒有解鎖，先不做了")
                return
            }
        }

        val protection = (parsed as? Parsed.Run)?.command?.protection ?: Protection.NONE
        when (protection) {
            Protection.NONE -> {}
            Protection.CONFIRM -> if (!confirmed && !askYesNo("要${what}，對嗎？")) {
                giveUp("好，那先不做")
                return
            }
            Protection.PASSWORD -> {
                // 指令和密碼一口氣說完就不用再問第二次
                val inline = if (Store.lockedMinutes(this) > 0) Spoken.Inline.NONE else Spoken.inlineSecret(heard, secret)
                when (inline) {
                    Spoken.Inline.MATCH -> {
                        Store.secretPassed(this)
                        Store.log(this, "密碼通過（一句話帶密碼）")
                    }
                    Spoken.Inline.WRONG -> {
                        Store.secretFailed(this)
                        Store.log(this, "一句話帶的密碼不符")
                        if (!askPassword(what, "密碼好像不對，再說一次密碼好嗎")) return
                    }
                    Spoken.Inline.NONE -> if (!askPassword(what, "好，要$what，請說密碼")) return
                }
            }
        }

        if (ActionRunner.leavesApp(parsed)) {
            val opening = when (parsed) {
                is Parsed.Schedule -> scheduleOpening(parsed)
                is Parsed.Keep -> if (parsed.detail.length < 4) "好，把這個畫面存進知識庫" else "好，存進知識庫"
                else -> "好，$what"
            }
            show(Mode.OK, opening)
            say(opening)
            val out = ActionRunner.run(this, parsed, shot)
            Store.log(this, "執行：$what → ${if (out.ok) "成功" else out.message}")
            if (out.ok) finish() else giveUp(out.message)
        } else {
            show(Mode.WORKING, "馬上處理…")
            val out = ActionRunner.run(this, parsed)
            Store.log(this, "執行：$what → ${out.message}")
            if (out.ok) {
                show(Mode.OK, out.message)
                say(out.message)
                delay(600)
                finish()
            } else {
                giveUp(out.message)
            }
        }
    }

    private fun scheduleOpening(p: Parsed.Schedule): String {
        val which = if (p.calendar.isEmpty()) "" else "，放${p.calendar}的"
        return if (p.detail.length < 4) "好，把這個畫面交給行事曆讀$which，填好後請看一下再按儲存"
        else "好，交給行事曆登記$which，填好後請看一下再按儲存"
    }

    /** 打字代替說話：設定頁的「打字執行」，或測試版用 adb 帶 text 參數（正式版不接受外部參數）。 */
    private fun takeTypedText(): String? {
        val own = pendingText
        pendingText = null
        if (!own.isNullOrBlank()) return own
        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (!debuggable) return null
        // 測試版：長按側鍵叫出來時沒辦法帶參數，改讀這個檔（用完就刪）
        val script = java.io.File(filesDir, "debug_text.txt")
        val fromFile = if (script.exists()) script.readText().trim().also { script.delete() } else ""
        val fromIntent = intent?.getStringExtra("text") ?: fromFile.takeIf { it.isNotEmpty() }
        scriptedAnswers.clear()
        intent?.getStringExtra("answers")?.split('|')?.let(scriptedAnswers::addAll)
        intent?.removeExtra("text")
        intent?.removeExtra("answers")
        return fromIntent?.takeIf { it.isNotBlank() }
    }

    /** 問「好不好」：可以用說的，也可以直接按畫面上的按鈕；聽不清楚會再問一次，還是不清楚就當作不要。 */
    private suspend fun askYesNo(question: String): Boolean {
        val tap = CompletableDeferred<Boolean>()
        choice = tap
        try {
            var prompt = question
            repeat(2) {
                show(Mode.WORKING, prompt)
                say(prompt)
                if (tap.isCompleted) return tap.await()
                show(Mode.LISTENING, prompt)
                val verdict: Boolean? = coroutineScope {
                    val heard = async { listen(YES_NO_BIAS, showHeard = true) }
                    val v = select<Boolean?> {
                        tap.onAwait { it }
                        heard.onAwait { answer ->
                            Store.log(this@AssistActivity, "確認回答：$answer")
                            when {
                                Spoken.isNo(answer) -> false
                                Spoken.isYes(answer) -> true
                                else -> null
                            }
                        }
                    }
                    heard.cancel()
                    v
                }
                if (verdict != null) return verdict
                heardText = ""
                prompt = "不好意思沒聽清楚。要的話請說「好」，不要請說「取消」，也可以直接按畫面上的按鈕"
            }
            return false
        } finally {
            choice = null
        }
    }

    private suspend fun askPassword(what: String, firstPrompt: String): Boolean {
        val secret = Store.secret(this)
        if (secret.isEmpty()) {
            giveUp("還沒有設定密碼喔，請先到設定頁設定")
            return false
        }
        val locked = Store.lockedMinutes(this)
        if (locked > 0) {
            giveUp("密碼說錯太多次了，請 $locked 分鐘後再試")
            return false
        }
        var retryPrompt = ""
        repeat(2) { attempt ->
            val prompt = if (attempt == 0) firstPrompt else retryPrompt
            show(Mode.WORKING, prompt)
            say(prompt)
            show(Mode.LISTENING, "請說密碼")
            heardText = ""
            // 密碼不顯示在畫面上，也不寫進紀錄
            val answer = listen(emptyList(), showHeard = false)
            if (answer.isEmpty()) {
                // 沒聽到不算說錯，不累計鎖定次數
                Store.log(this, "沒有聽到密碼（第 ${attempt + 1} 次）")
                retryPrompt = "我沒聽到，再說一次密碼好嗎"
                return@repeat
            }
            if (Spoken.isNo(answer)) {
                giveUp("好，那先不做")
                return false
            }
            if (Spoken.secretMatches(answer, secret)) {
                Store.secretPassed(this)
                Store.log(this, "密碼通過")
                return true
            }
            Store.secretFailed(this)
            Store.log(this, "密碼不符（第 ${attempt + 1} 次）")
            retryPrompt = "密碼好像不對，再說一次好嗎"
            if (Store.lockedMinutes(this) > 0) {
                giveUp("密碼說錯太多次了，先鎖定十分鐘")
                return false
            }
        }
        giveUp("密碼沒有通過，先不做了")
        return false
    }

    /** 沒聽到內容時，分辨是真的沒聲音，還是辨識引擎本身有狀況。 */
    private fun silenceReason(): String = when (listenError) {
        SpeechRecognizer.ERROR_CLIENT, SpeechRecognizer.ERROR_SERVER_DISCONNECTED ->
            "語音辨識沒有啟動，請到設定頁檢查辨識引擎"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS ->
            "辨識引擎沒有麥克風權限，請到手機設定開啟 Google 的麥克風權限"
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT ->
            "網路不通，語音辨識失敗"
        SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE ->
            "辨識引擎還沒有中文語音，請到 Google 語音設定下載"
        else -> "我沒聽到聲音，按「再說一次」試試"
    }

    private suspend fun giveUp(message: String, speak: Boolean = true) {
        show(Mode.ERROR, message)
        canRetry = true
        if (speak) say(message)
        // 沒人理就自己收掉，不要一直蓋在畫面上；按「再說一次」會取消這段等待
        delay(8000)
        finish()
    }

    private fun show(m: Mode, text: String) {
        mode = m
        status = text
    }

    private fun bias(config: Config): List<String> =
        (config.commands.flatMap { it.triggers + it.name } +
            config.contacts.flatMap { it.aliases + it.name } +
            config.places.flatMap { it.aliases + it.name } +
            listOf("用賴打給", "打給", "打電話給", "打開", "導航到", "導航回", "登記行程", "行事曆", "個人", "公司", "存到知識庫", "知識庫"))
            .filter { it.isNotBlank() }.distinct().take(100)

    // ---- 解鎖 ----

    private fun isLocked(): Boolean =
        (getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked

    private suspend fun unlock(): Boolean {
        unlocking = true
        try {
            return suspendCancellableCoroutine { cont ->
                val km = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
                km.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
                    override fun onDismissSucceeded() { if (cont.isActive) cont.resume(true) }
                    override fun onDismissCancelled() { if (cont.isActive) cont.resume(false) }
                    override fun onDismissError() { if (cont.isActive) cont.resume(false) }
                })
            }
        } finally {
            unlocking = false
        }
    }

    // ---- 語音辨識 ----

    private suspend fun listen(biasStrings: List<String>, showHeard: Boolean): List<String> {
        scriptedAnswers.removeFirstOrNull()?.let { return if (it.isBlank()) emptyList() else listOf(it) }
        val result = withTimeoutOrNull(LISTEN_TIMEOUT_MS) { listenOnce(biasStrings, showHeard) }
        stopListening()
        return result ?: emptyList()
    }

    private suspend fun listenOnce(biasStrings: List<String>, showHeard: Boolean): List<String> =
        suspendCancellableCoroutine { cont ->
            val component = Store.recognizer(this)
            listenError = 0
            val sr = try {
                if (component != null) SpeechRecognizer.createSpeechRecognizer(this, component)
                else SpeechRecognizer.createSpeechRecognizer(this)
            } catch (e: Exception) {
                Store.log(this, "建立語音辨識失敗：${e.message}")
                listenError = SpeechRecognizer.ERROR_CLIENT
                cont.resume(emptyList())
                return@suspendCancellableCoroutine
            }
            recognizer = sr
            sr.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) { buzz() }
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() { if (mode == Mode.LISTENING) mode = Mode.WORKING }
                override fun onEvent(eventType: Int, params: Bundle?) {}

                override fun onPartialResults(partial: Bundle?) {
                    if (!showHeard) return
                    partial?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        ?.firstOrNull()?.takeIf { it.isNotBlank() }?.let { heardText = Spoken.redact(it, redactSecret) }
                }

                override fun onResults(results: Bundle?) {
                    val list = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        ?.filter { it.isNotBlank() }.orEmpty()
                    if (cont.isActive) cont.resume(list)
                }

                override fun onError(error: Int) {
                    listenError = error
                    if (error != SpeechRecognizer.ERROR_NO_MATCH && error != SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                        Store.log(this@AssistActivity, "語音辨識錯誤代碼 $error（引擎：${component?.packageName ?: "系統預設"}）")
                    }
                    if (cont.isActive) cont.resume(emptyList())
                }
            })
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-TW")
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "zh-TW")
                .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5)
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, packageName)
            if (biasStrings.isNotEmpty() && android.os.Build.VERSION.SDK_INT >= 33) {
                intent.putStringArrayListExtra(RecognizerIntent.EXTRA_BIASING_STRINGS, ArrayList(biasStrings))
            }
            runCatching { sr.startListening(intent) }.onFailure {
                Store.log(this, "開始聆聽失敗：${it.message}")
                listenError = SpeechRecognizer.ERROR_CLIENT
                if (cont.isActive) cont.resume(emptyList())
            }
            cont.invokeOnCancellation { runOnUiThread { stopListening() } }
        }

    private fun stopListening() {
        recognizer?.let { runCatching { it.cancel() }; runCatching { it.destroy() } }
        recognizer = null
    }

    private fun buzz() {
        runCatching {
            @Suppress("DEPRECATION")
            (getSystemService(Context.VIBRATOR_SERVICE) as Vibrator)
                .vibrate(VibrationEffect.createOneShot(35, VibrationEffect.DEFAULT_AMPLITUDE))
        }
    }

    // ---- 語音回覆 ----

    private suspend fun say(text: String) = speaker.say(text)

    // ---- 畫面 ----

    @Composable
    private fun AssistScreen() {
        MaterialTheme(colorScheme = darkColorScheme()) {
            Box(
                Modifier
                    .fillMaxSize()
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { finish() },
                contentAlignment = Alignment.BottomCenter,
            ) {
                Surface(
                    modifier = Modifier
                        .fillMaxWidth()
                        .navigationBarsPadding()
                        .padding(12.dp)
                        .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {},
                    shape = RoundedCornerShape(28.dp),
                    color = Color(0xFF1B1F27),
                    tonalElevation = 6.dp,
                ) {
                    Column(
                        Modifier.padding(horizontal = 24.dp, vertical = 22.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        val dot = when (mode) {
                            Mode.LISTENING -> Color(0xFF3FB950)
                            Mode.WORKING, Mode.IDLE -> Color(0xFF58A6FF)
                            Mode.OK -> Color(0xFF3FB950)
                            Mode.ERROR -> Color(0xFFF85149)
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(14.dp).clip(CircleShape).background(dot))
                            Spacer(Modifier.size(10.dp))
                            Text(
                                when (mode) {
                                    Mode.LISTENING -> "聆聽中"
                                    Mode.WORKING, Mode.IDLE -> "處理中"
                                    Mode.OK -> "完成"
                                    Mode.ERROR -> "未完成"
                                },
                                color = Color(0xFF9AA4B2), fontSize = 14.sp,
                            )
                        }
                        Spacer(Modifier.height(14.dp))
                        Text(
                            status, color = Color.White, fontSize = 22.sp, lineHeight = 30.sp,
                            textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth(),
                        )
                        if (heardText.isNotBlank()) {
                            Spacer(Modifier.height(10.dp))
                            Text(
                                "「$heardText」", color = Color(0xFF9AA4B2), fontSize = 16.sp,
                                textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth(),
                            )
                        }
                        choice?.let { pending ->
                            Spacer(Modifier.height(16.dp))
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                OutlinedButton(
                                    onClick = { pending.complete(false); speaker.stop() },
                                    modifier = Modifier.weight(1f).height(52.dp),
                                ) { Text("取消", fontSize = 18.sp) }
                                Button(
                                    onClick = { pending.complete(true); speaker.stop() },
                                    modifier = Modifier.weight(1f).height(52.dp),
                                ) { Text("好", fontSize = 18.sp) }
                            }
                        }
                        Spacer(Modifier.height(14.dp))
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            TextButton(onClick = {
                                startActivity(Intent(this@AssistActivity, MainActivity::class.java))
                                finish()
                            }) { Text("設定") }
                            if (canRetry) TextButton(onClick = { start() }) { Text("再說一次") }
                            TextButton(onClick = { finish() }) { Text("關閉") }
                        }
                    }
                }
            }
        }
    }
}
