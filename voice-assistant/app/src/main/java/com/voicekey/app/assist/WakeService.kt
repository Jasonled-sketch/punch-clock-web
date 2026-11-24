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
import android.icu.text.Transliterator
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.service.voice.VoiceInteractionSession
import com.voicekey.app.R
import com.voicekey.app.core.Wake
import com.voicekey.app.data.Store
import com.voicekey.app.ui.MainActivity
import org.vosk.Model
import org.vosk.Recognizer
import org.vosk.android.RecognitionListener
import org.vosk.android.SpeechService
import java.io.File

/**
 * 呼喊喚醒：常駐在通知列，用開源的離線語音引擎（Vosk）在手機本機只聽你設定的那幾個詞。
 * 不用註冊帳號、不用金鑰、不用網路；聲音不離開手機、不錄下來。
 * 聽到 → 叫出聆聽畫面；聆聽畫面開著的時候先把麥克風讓出來，關掉後再接著聽。
 */
class WakeService : Service() {

    companion object {
        /** APK 裡的模型資料夾（assets）與它的版本；換模型就改版本，手機上會重新解開。 */
        private const val MODEL_ASSET = "vosk-model-small-cn"
        private const val MODEL_VERSION = "small-cn-0.22"
        private const val RATE = 16000f
        private const val CHANNEL = "wake"
        private const val NOTE_ID = 41
        private const val ASK_ID = 42
        private const val ACTION_STOP = "com.voicekey.app.WAKE_STOP"

        @Volatile
        var running = false
            private set
        @Volatile
        var lastError = ""
            private set
        /** 最近一次聽到的字（給設定頁顯示，方便調喚醒詞）。 */
        @Volatile
        var lastHeard = ""
            private set
        @Volatile
        private var instance: WakeService? = null

        /** 繁體 → 簡體（模型是用簡體字訓練的）。 */
        fun simplified(phrase: String): String =
            runCatching { Transliterator.getInstance("Traditional-Simplified").transliterate(phrase) }.getOrDefault(phrase)

        /** 還缺什麼才能開；空字串＝都齊了。 */
        fun missing(ctx: Context): String = when {
            ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED -> "還沒有麥克風權限"
            Wake.phrases(Store.wakePhrase(ctx)).isEmpty() -> "還沒有設定喚醒詞"
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

        private fun channel(ctx: Context) {
            ctx.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, "呼喊喚醒", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) },
            )
        }

        /** 系統不准在背景自己開：跳一則通知，點一下就開（那時 App 在前景，系統就准了）。 */
        fun askTap(ctx: Context) {
            runCatching {
                channel(ctx)
                val tap = PendingIntent.getActivity(
                    ctx, 2, Intent(ctx, WakeOnActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE,
                )
                val n = Notification.Builder(ctx, CHANNEL)
                    .setSmallIcon(R.drawable.ic_mic)
                    .setContentTitle("語音快捷：點一下開始聽喚醒詞")
                    .setContentText("系統不讓它在背景自己開始，點這裡就會開")
                    .setContentIntent(tap).setAutoCancel(true).build()
                ctx.getSystemService(NotificationManager::class.java).notify(ASK_ID, n)
            }
        }

        fun cancelAskTap(ctx: Context) {
            runCatching { ctx.getSystemService(NotificationManager::class.java).cancel(ASK_ID) }
        }

        @Volatile
        private var uiOpen = false

        /** 聆聽畫面要用麥克風：先停聽。 */
        fun pause() { uiOpen = true; instance?.pauseEngine() }

        /** 聆聽畫面關了：接著聽。 */
        fun resume() { uiOpen = false; instance?.resumeEngine() }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var model: Model? = null
    private var recognizer: Recognizer? = null
    private var speech: SpeechService? = null
    private var phrases: List<String> = emptyList()
    private var eager = false
    private var listening = false
    private var paused = false
    @Volatile
    private var building = false
    private val resumeLater = Runnable { startListening() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        channel(this)
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
            // 安卓 14 起：App 不在前景、又不是預設助理時，不能自己開「用麥克風的常駐服務」
            lastError = "系統不讓它在背景自己啟動，請點通知或打開「語音快捷設定」再開一次"
            Store.log(this, "呼喊喚醒：系統不准在背景啟動（${e.javaClass.simpleName}），改跳通知")
            askTap(this)
            stopSelf()
            return START_NOT_STICKY
        }
        running = true
        lastError = ""
        cancelAskTap(this)
        if (recognizer != null) {
            startListening()
        } else if (!building) {
            // 第一次要把模型從安裝檔解開再載入，要幾秒：放到背景做，不能卡住畫面
            building = true
            Thread {
                val ok = buildEngine()
                handler.post {
                    building = false
                    if (instance !== this) { release(); return@post }
                    if (ok) startListening() else { update(lastError); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf() }
                }
            }.apply { isDaemon = true }.start()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        stopSpeech()
        release()
        running = false
        if (instance === this) instance = null
        super.onDestroy()
    }

    private fun release() {
        runCatching { recognizer?.close() }
        recognizer = null
        runCatching { model?.close() }
        model = null
    }

    /** 模型放在安裝檔裡（assets），引擎要讀真的檔案：第一次先複製到 App 自己的資料夾。 */
    private fun modelDir(): File {
        val dir = File(filesDir, "vosk-model")
        val mark = File(dir, ".version")
        if (mark.exists() && mark.readText() == MODEL_VERSION) return dir
        dir.deleteRecursively()
        copyAsset(MODEL_ASSET, dir)
        mark.writeText(MODEL_VERSION)
        return dir
    }

    private fun copyAsset(path: String, target: File) {
        val children = assets.list(path).orEmpty()
        if (children.isEmpty()) {
            target.parentFile?.mkdirs()
            assets.open(path).use { input -> target.outputStream().use { input.copyTo(it, 1 shl 16) } }
        } else {
            target.mkdirs()
            for (c in children) copyAsset("$path/$c", File(target, c))
        }
    }

    private fun buildEngine(): Boolean {
        return try {
            val list = Wake.phrases(Store.wakePhrase(this)).map(::simplified)
            if (list.isEmpty()) { lastError = "還沒有設定喚醒詞"; return false }
            val m = Model(modelDir().absolutePath)
            val r = Recognizer(m, RATE, Wake.grammar(list))
            model = m
            recognizer = r
            phrases = list
            eager = Store.wakeSensitivity(this) >= 0.65f
            Store.log(this, "呼喊喚醒：引擎準備好了，喚醒詞 ${Wake.phrases(Store.wakePhrase(this))}")
            true
        } catch (e: Throwable) {
            lastError = "喚醒詞引擎啟動失敗（${e.javaClass.simpleName}）"
            Store.log(this, "呼喊喚醒：$lastError ${e.message.orEmpty().take(80)}")
            release()
            false
        }
    }

    private val listener = object : RecognitionListener {
        // 靈敏度選「容易叫醒」：話還沒講完、一聽到就算（快，但比較會誤觸）
        override fun onPartialResult(hypothesis: String?) {
            if (hypothesis == null) return
            note(hypothesis)
            if (eager && Wake.hit(hypothesis, phrases)) onWake()
        }

        // 其他靈敏度：等一小段話講完、引擎確定了才算
        override fun onResult(hypothesis: String?) {
            if (hypothesis == null) return
            note(hypothesis)
            if (Wake.hit(hypothesis, phrases)) onWake()
        }

        override fun onFinalResult(hypothesis: String?) {}

        override fun onError(exception: Exception?) {
            Store.log(this@WakeService, "呼喊喚醒執行中出錯：${exception?.javaClass?.simpleName}")
            listening = false
            handler.removeCallbacks(resumeLater)
            handler.postDelayed(resumeLater, 5000)
        }

        override fun onTimeout() {}

        private fun note(json: String) {
            val h = Wake.heard(json).replace("[unk]", "…")
            if (h.isNotEmpty() && h != "…") lastHeard = h
        }
    }

    private fun startListening() {
        if (paused || listening) return
        val r = recognizer ?: return
        try {
            runCatching { r.reset() }
            val s = SpeechService(r, RATE)
            if (!s.startListening(listener)) throw IllegalStateException("already listening")
            speech = s
            listening = true
            lastError = ""
            update("正在聽：" + Wake.phrases(Store.wakePhrase(this)).joinToString("、"))
        } catch (e: Exception) {
            lastError = "麥克風被別的 App 佔用，等一下會再試"
            update("麥克風被佔用，稍後再試")
            handler.removeCallbacks(resumeLater)
            handler.postDelayed(resumeLater, 5000)
        }
    }

    /** 把麥克風完全放掉（不是只暫停）：聆聽畫面的語音辨識才收得到聲音。 */
    private fun stopSpeech() {
        speech?.let { runCatching { it.stop() }; runCatching { it.shutdown() } }
        speech = null
        listening = false
    }

    private fun pauseEngine() {
        handler.post {
            paused = true
            handler.removeCallbacks(resumeLater)
            stopSpeech()
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
        stopSpeech()
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
