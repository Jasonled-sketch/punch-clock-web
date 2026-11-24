package com.voicekey.app.assist

import android.Manifest
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.ParcelFileDescriptor
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import com.voicekey.app.ai.ClaudeAsk
import com.voicekey.app.core.ActionType
import com.voicekey.app.core.Ask
import com.voicekey.app.line.LineCallService
import com.voicekey.app.core.Config
import com.voicekey.app.core.Matcher
import com.voicekey.app.core.OpenAiStt
import com.voicekey.app.core.Wav
import com.voicekey.app.core.Parsed
import com.voicekey.app.core.Protection
import com.voicekey.app.core.Spoken
import com.voicekey.app.data.Store
import com.voicekey.app.ui.MainActivity
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.withContext
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
        private const val QUIET_PASSWORD_MS = 4_000L
        private val YES_NO_BIAS = listOf("好", "好的", "確定", "對", "可以", "沒問題", "取消", "不要", "不用")
    }

    private enum class Mode { IDLE, LISTENING, WORKING, OK, ERROR }

    private var status by mutableStateOf("準備中…")
    private var heardText by mutableStateOf("")
    private var mode by mutableStateOf(Mode.IDLE)
    private var canRetry by mutableStateOf(false)

    /** 問答的回答：有內容時畫面改成可以捲動的長文字。 */
    private var answer by mutableStateOf("")

    private lateinit var speaker: Speaker

    /** 正在等「好／取消」時不是 null：畫面會多出兩顆按鈕，按了等於說了。 */
    private var choice by mutableStateOf<CompletableDeferred<Boolean>?>(null)
    private var redactSecret = ""
    private var recognizer: SpeechRecognizer? = null
    private var flow: Job? = null
    private var unlocking = false
    private var listenError = 0
    private var cloudError = ""
    @Volatile
    private var recorder: Recorder? = null

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
        WakeService.pause()   // 聆聽畫面要用麥克風，呼喊喚醒先讓出來
        dropLineJob()
        setContent { AssistScreen() }
        start()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        WakeService.pause()
        dropLineJob()
        start()
    }

    /** 人又把聆聽畫面叫出來＝要做別的事了：還在幫忙撥 LINE 的話就不繼續，免得兩邊搶畫面。 */
    private fun dropLineJob() {
        LineCallService.instance?.cancel("又叫出了聆聽畫面")
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
        WakeService.resume()
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
        answer = ""
        choice = null
        val woke = WakeService.takeWoke() || debugWoke()
        val shot = VkSession.takeFreshShot()
        val config = Store.config(this)
        val secret = Store.secret(this)
        redactSecret = secret

        val typed = takeTypedText()
        val learned = Store.learned(this)
        cloudError = ""
        val heard = if (typed != null) listOf(typed) else {
            // 被喊醒的：先回一句，人才知道它醒了（手機靜音時不出聲，只顯示字、震一下）
            val greeting = if (woke) Store.wakeGreeting(this) else ""
            if (greeting.isNotBlank()) {
                Store.log(this, "被喊醒，回應：$greeting" + if (speaker.muted()) "（手機靜音，只顯示不出聲）" else "")
                show(Mode.WORKING, greeting)
                buzz()
                say(greeting)
            }
            show(Mode.LISTENING, "我在聽，請說")
            hearCommand(config, learned)
        }
        if (heard.isEmpty()) {
            giveUp(silenceReason(), speak = false)
            return
        }
        heardText = Spoken.redact(heard.first(), secret)
        Store.log(this, "聽到：${heard.map { Spoken.redact(it, secret) }}")

        val result = Matcher.match(heard, config, Store.apps(this), learned)
        val parsed = result.parsed
        // 不是指令而是在問問題（或擺明說「幫我查…」）：交給問答
        val question = heard.first()
        val unknown = parsed as? Parsed.Unknown
        val asking = Ask.direct(question) ||
            (unknown != null && unknown.reason.isEmpty()) ||
            (unknown == null && result.score < Matcher.EXECUTE && Ask.looksLikeQuestion(question))
        if (asking) {
            if (Store.claudeKey(this).isNotBlank()) {
                answerQuestion(question, secret)
                return
            }
            if (unknown != null) {
                Store.log(this, "比對不到（問答還沒開）")
                giveUp(
                    if (Ask.looksLikeQuestion(question)) "這是在問問題，問答功能還沒開，請到設定頁的「問答」貼上金鑰"
                    else "不好意思，我沒聽懂，可以再說一次嗎",
                )
                return
            }
            // 沒開問答、但比對得到指令：照原本的流程反問
        }
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
            // 記住這個說法，下次同一句話就不用再問（帶數字的不記，免得把密碼記進去）
            val target = Matcher.targetOf(parsed)
            if (target.isNotEmpty() && Spoken.digits(result.heard).length < 3) {
                Store.learn(this, Matcher.phraseKey(result.heard), target)
                Store.log(this, "記住這個說法 → $what")
            }
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
                    Spoken.Inline.NONE -> {
                        Store.log(this, "這句話裡沒有聽到密碼，接著聽")
                        if (!askPassword(what, "請說密碼", quietFirst = true)) return
                    }
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
            // 撥電話：對方接起來之前先別聽喚醒詞，免得鈴聲或「喂」被聽成喚醒詞、聆聽畫面跳出來蓋住 LINE
            val calling = parsed is Parsed.Call ||
                (parsed is Parsed.Run && (parsed.command.type == ActionType.LINE_CALL || parsed.command.type == ActionType.CALL_PHONE))
            if (calling) WakeService.holdOff(25_000)
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

    /** 測試版：用 adb 帶 woke 參數，假裝這次是被喊醒的（模擬器沒有麥克風）。 */
    private fun debugWoke(): Boolean {
        if ((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) == 0) return false
        val w = intent?.getBooleanExtra("woke", false) == true
        intent?.removeExtra("woke")
        return w
    }

    /** 打字代替說話：設定頁的「打字執行」，或測試版用 adb 帶 text 參數（正式版不接受外部參數）。 */
    private fun takeTypedText(): String? {
        val own = pendingText
        pendingText = null
        if (!own.isNullOrBlank()) return own
        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (!debuggable) return null
        // 測試版：問答改連假的伺服器（模擬器上沒有金鑰也能跑完整流程）
        val aiBase = java.io.File(filesDir, "debug_ai_base.txt")
        if (aiBase.exists()) {
            ClaudeAsk.testBaseUrl = aiBase.readText().trim()
            val probe = java.io.File(filesDir, "debug_ai_check.txt")
            if (probe.exists()) {
                probe.delete()
                Thread { Store.log(this, "測試：檢查金鑰 → " + ClaudeAsk.check("not-a-real-key", Store.aiModel(this))) }.start()
            }
        }
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

    private enum class Pw { OK, EMPTY, CLIPPED, WRONG, CANCEL }

    private fun judge(answer: List<String>, secret: String): Pw = when {
        answer.isEmpty() -> Pw.EMPTY
        Spoken.isNo(answer) -> Pw.CANCEL
        Spoken.secretMatches(answer, secret) -> Pw.OK
        // 數字比密碼短＝多半是開頭被切掉沒錄到，不是猜錯（短的數字本來就不可能猜中）
        secret.all { it in '0'..'9' } && answer.all { Spoken.digits(it).length < secret.length } -> Pw.CLIPPED
        else -> Pw.WRONG
    }

    /**
     * quietFirst＝先不出聲、直接接著聽一小段：人常常是「開鐵門…（停一下）…一二三四」，
     * 辨識引擎在停頓那裡就收工了，密碼正要說出口，這時再唸一句「請說密碼」反而蓋掉它。
     * 那一小段沒聽到東西，才開口問。
     */
    private suspend fun askPassword(what: String, firstPrompt: String, quietFirst: Boolean = false): Boolean {
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
        var prompt = firstPrompt
        var quiet = quietFirst
        repeat(if (quietFirst) 3 else 2) { attempt ->
            if (!quiet) {
                show(Mode.WORKING, prompt)
                say(prompt)
            }
            show(Mode.LISTENING, "請說密碼")
            heardText = ""
            // 密碼不顯示在畫面上，也不寫進紀錄
            val answer = listen(emptyList(), showHeard = false, timeoutMs = if (quiet) QUIET_PASSWORD_MS else LISTEN_TIMEOUT_MS)
            val wasQuiet = quiet
            quiet = false
            when (judge(answer, secret)) {
                Pw.OK -> {
                    Store.secretPassed(this)
                    Store.log(this, if (wasQuiet) "密碼通過（停頓後接著說的）" else "密碼通過")
                    return true
                }
                Pw.CANCEL -> {
                    giveUp("好，那先不做")
                    return false
                }
                Pw.EMPTY -> {
                    // 沒聽到不算說錯，不累計鎖定次數
                    Store.log(this, "沒有聽到密碼（第 ${attempt + 1} 次）")
                    if (!wasQuiet) prompt = "我沒聽到，再說一次密碼好嗎"
                }
                Pw.CLIPPED -> {
                    Store.log(this, "密碼沒聽完整（第 ${attempt + 1} 次）")
                    prompt = "密碼沒聽完整，再說一次好嗎"
                }
                Pw.WRONG -> {
                    Store.secretFailed(this)
                    Store.log(this, "密碼不符（第 ${attempt + 1} 次）")
                    prompt = "密碼好像不對，再說一次好嗎"
                    if (Store.lockedMinutes(this) > 0) {
                        giveUp("密碼說錯太多次了，先鎖定十分鐘")
                        return false
                    }
                }
            }
        }
        giveUp("密碼沒有通過，先不做了")
        return false
    }

    /** 問答：把問題交給 Claude（需要最新資訊它會自己上網查），答案顯示在畫面上並唸出來。 */
    private suspend fun answerQuestion(question: String, secret: String) {
        // 萬一句子裡帶到密碼，先拿掉再送出去
        val q = if (secret.isBlank()) question else question.replace(secret, "")
        Store.log(this, "問答：$q")
        show(Mode.WORKING, "我查一下，稍等…")
        val today = java.text.SimpleDateFormat("yyyy-MM-dd（EEEE）", Locale.TAIWAN).format(java.util.Date())
        val reply = coroutineScope {
            val asking = async(Dispatchers.IO) { ClaudeAsk.ask(Store.claudeKey(this@AssistActivity), Store.aiModel(this@AssistActivity), q, today) }
            say("我查一下")
            asking.await()
        }
        if (reply.error.isNotEmpty()) {
            Store.log(this, "問答失敗：${reply.error}")
            giveUp(reply.error)
            return
        }
        Store.log(this, "回答：${reply.text.take(80)}")
        answer = reply.text
        show(Mode.OK, "")
        canRetry = true
        val silent = speaker.muted()
        speaker.say(reply.text, maxMs = 90_000)
        // 唸完再留一下讓人看；靜音時沒唸，就留久一點
        delay(if (silent) 60_000 else 20_000)
        finish()
    }

    /** 沒聽到內容時，分辨是真的沒聲音，還是辨識引擎本身有狀況。 */
    private fun silenceReason(): String = if (cloudError.isNotEmpty()) cloudError else when (listenError) {
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

    /**
     * 聽「指令」這一句。設定頁選了雲端辨識而且有金鑰才會走下面這段，否則就是原本的手機內建辨識。
     *   both（兩段式）：自己錄音，同一份聲音同時餵給手機內建辨識；內建的先回來而且對得上固定指令就直接用（快），
     *                  沒把握或是地名、行程內容這種自由發揮的句子，再把錄音送雲端重聽（準）。
     *   cloud：不用內建，錄完直接送雲端。
     * 確認（好／取消）和密碼一律走手機內建，密碼的聲音不會送到雲端。
     */
    private suspend fun hearCommand(config: Config, learned: Map<String, String>): List<String> {
        val mode = Store.sttMode(this)
        val key = Store.openAiKey(this)
        if (mode == "google" || key.isBlank()) return listen(bias(config), showHeard = true)
        scriptedAnswers.removeFirstOrNull()?.let { return if (it.isBlank()) emptyList() else listOf(it) }

        val rec = Recorder()
        recorder = rec
        var pipeRead: ParcelFileDescriptor? = null
        var tee: java.io.OutputStream? = null
        if (mode == "both" && android.os.Build.VERSION.SDK_INT >= 33) {
            runCatching { ParcelFileDescriptor.createPipe() }.getOrNull()?.let { p ->
                pipeRead = p[0]
                tee = ParcelFileDescriptor.AutoCloseOutputStream(p[1])
            }
        }
        buzz()
        return try {
            coroutineScope {
                val clipJob = async(Dispatchers.IO) { rec.record(tee) }
                val fd = pipeRead
                val google: Deferred<List<String>>? = if (fd != null) async { withTimeoutOrNull(LISTEN_TIMEOUT_MS + 4000) { listenOnce(bias(config), true, fd) } ?: emptyList<String>() } else null
                // 內建辨識先有結果就不用等到偵測出安靜
                var g: List<String> = emptyList()
                if (google != null) {
                    val first = select<List<String>?> {
                        google.onAwait { it }
                        clipJob.onAwait { null }
                    }
                    g = first ?: (withTimeoutOrNull(1500) { google.await() } ?: emptyList())
                    if (g.isNotEmpty()) rec.stop()
                }
                val clip = clipJob.await()
                google?.cancel()
                stopListening()
                if (g.isNotEmpty() && sureEnough(g, config, learned)) return@coroutineScope g
                if (!clip.spoke || clip.pcm.size < Recorder.RATE) return@coroutineScope g   // 沒錄到人聲：內建有聽到就用它的
                show(Mode.WORKING, "聽清楚一點…")
                val r = withContext(Dispatchers.IO) { OpenAiStt.transcribe(key, Wav.wrap(clip.pcm, Recorder.RATE), OpenAiStt.promptOf(bias(config))) }
                if (r.text.isBlank()) {
                    if (r.error.isNotEmpty()) { Store.log(this@AssistActivity, "雲端辨識：${r.error}"); if (g.isEmpty()) cloudError = r.error }
                    return@coroutineScope g
                }
                heardText = Spoken.redact(r.text, redactSecret)
                listOf(r.text) + g
            }
        } finally {
            recorder = null
            runCatching { pipeRead?.close() }
        }
    }

    /** 內建辨識的結果夠不夠用：對得上固定指令／聯絡人／App／存過的地點，或是只是要把畫面交出去，就不必再送雲端。 */
    private fun sureEnough(g: List<String>, config: Config, learned: Map<String, String>): Boolean {
        val r = Matcher.match(g, config, Store.apps(this), learned)
        if (r.score < Matcher.EXECUTE) return false
        return when (val p = r.parsed) {
            is Parsed.Run, is Parsed.Call, is Parsed.Open, is Parsed.Media -> true
            is Parsed.Navigate -> p.place != null || p.query.isBlank()
            is Parsed.Schedule -> p.detail.length < 4
            is Parsed.Keep -> p.detail.length < 4
            is Parsed.Unknown -> false
        }
    }

    private suspend fun listen(biasStrings: List<String>, showHeard: Boolean, timeoutMs: Long = LISTEN_TIMEOUT_MS): List<String> {
        scriptedAnswers.removeFirstOrNull()?.let { return if (it.isBlank()) emptyList() else listOf(it) }
        val result = withTimeoutOrNull(timeoutMs) { listenOnce(biasStrings, showHeard) }
        stopListening()
        return result ?: emptyList()
    }

    private suspend fun listenOnce(biasStrings: List<String>, showHeard: Boolean, audio: ParcelFileDescriptor? = null): List<String> =
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
                override fun onReadyForSpeech(params: Bundle?) { if (audio == null) buzz() }
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
            if (audio != null) {
                // Android 13 起可以把自己錄的聲音交給辨識引擎（它就不會自己再開一次麥克風）
                intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, audio)
                    .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
                    .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, android.media.AudioFormat.ENCODING_PCM_16BIT)
                    .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, Recorder.RATE)
            }
            runCatching { sr.startListening(intent) }.onFailure {
                Store.log(this, "開始聆聽失敗：${it.message}")
                listenError = SpeechRecognizer.ERROR_CLIENT
                if (cont.isActive) cont.resume(emptyList())
            }
            cont.invokeOnCancellation { runOnUiThread { stopListening() } }
        }

    private fun stopListening() {
        recorder?.stop()
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
                        if (answer.isNotBlank()) {
                            Text(
                                answer, color = Color.White, fontSize = 19.sp, lineHeight = 28.sp,
                                modifier = Modifier.fillMaxWidth().heightIn(max = 360.dp).verticalScroll(rememberScrollState()),
                            )
                        } else {
                            Text(
                                status, color = Color.White, fontSize = 22.sp, lineHeight = 30.sp,
                                textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth(),
                            )
                        }
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
                            if (canRetry) TextButton(onClick = { speaker.stop(); start() }) { Text(if (answer.isNotBlank()) "再問一題" else "再說一次") }
                            TextButton(onClick = { finish() }) { Text("關閉") }
                        }
                    }
                }
            }
        }
    }
}
