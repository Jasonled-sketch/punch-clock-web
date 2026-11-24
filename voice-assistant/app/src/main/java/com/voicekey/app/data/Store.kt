package com.voicekey.app.data

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.speech.RecognitionService
import com.voicekey.app.core.ActionType
import com.voicekey.app.core.AppEntry
import com.voicekey.app.core.Channel
import com.voicekey.app.core.Command
import com.voicekey.app.core.Config
import com.voicekey.app.core.Contact
import com.voicekey.app.core.Place
import com.voicekey.app.core.Protection
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

/** 所有設定都只存在手機本機（App 私有空間），不會上傳。 */
object Store {
    private const val PREFS = "voicekey"
    private const val KEY_CONFIG = "config"
    private const val KEY_SECRET = "secret"
    private const val KEY_RECOGNIZER = "recognizer"
    private const val KEY_TTS_ENGINE = "tts_engine"
    private const val KEY_TTS_VOICE = "tts_voice"
    private const val KEY_TTS_RATE = "tts_rate"
    private const val KEY_STT_MODE = "stt_mode"
    private const val KEY_OPENAI = "openai_key"
    private const val KEY_LEARNED = "learned"
    private const val KEY_WAKE_ON = "wake_on"
    private const val KEY_PICO = "pico_key"
    private const val KEY_WAKE_SENS = "wake_sens"
    private const val KEY_WAKE_NAME = "wake_name"
    private const val KEY_WAKE_AUTO = "wake_auto"
    private const val KEY_AUTO_CHARGE = "auto_charge"
    private const val KEY_AUTO_BT = "auto_bt"
    private const val KEY_AUTO_BT_NAME = "auto_bt_name"
    private const val LEARNED_MAX = 200
    private const val KEY_FAILS = "secret_fails"
    private const val KEY_LOCK_UNTIL = "secret_lock_until"
    private const val MAX_FAILS = 5
    private const val LOCK_MS = 10 * 60 * 1000L
    private const val LOG_FILE = "log.txt"
    private const val LOG_MAX = 200_000L

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun newId(): String = UUID.randomUUID().toString().take(8)

    // ---- 指令與聯絡人 ----

    fun config(ctx: Context): Config {
        val raw = prefs(ctx).getString(KEY_CONFIG, null) ?: return seed().also { save(ctx, it) }
        return runCatching { fromJson(raw) }.getOrElse { seed() }
    }

    fun save(ctx: Context, config: Config) {
        prefs(ctx).edit().putString(KEY_CONFIG, toJson(config)).apply()
    }

    private fun seed() = Config(
        commands = listOf(
            Command(
                id = newId(),
                name = "開公司鐵門",
                triggers = listOf("開鐵門", "開啟公司鐵門", "打開鐵門", "開公司鐵門", "鐵門打開"),
                type = ActionType.WEBHOOK,
                target = "",
                protection = Protection.PASSWORD,
                requireUnlock = true,
            ),
        ),
        places = seedPlaces(),
    )

    private fun seedPlaces() = listOf(Place(newId(), "公司", emptyList(), ""))

    fun toJson(c: Config): String {
        val cmds = JSONArray()
        c.commands.forEach {
            cmds.put(
                JSONObject()
                    .put("id", it.id).put("name", it.name).put("triggers", JSONArray(it.triggers))
                    .put("type", it.type.name).put("target", it.target)
                    .put("method", it.method).put("body", it.body)
                    .put("protection", it.protection.name).put("requireUnlock", it.requireUnlock),
            )
        }
        val contacts = JSONArray()
        c.contacts.forEach {
            contacts.put(
                JSONObject()
                    .put("id", it.id).put("name", it.name).put("aliases", JSONArray(it.aliases))
                    .put("lineName", it.lineName).put("phone", it.phone)
                    .put("defaultChannel", it.defaultChannel.name),
            )
        }
        val places = JSONArray()
        c.places.forEach {
            places.put(
                JSONObject()
                    .put("id", it.id).put("name", it.name).put("aliases", JSONArray(it.aliases))
                    .put("address", it.address),
            )
        }
        return JSONObject().put("version", 1).put("commands", cmds).put("contacts", contacts)
            .put("places", places).toString(2)
    }

    fun fromJson(raw: String): Config {
        val o = JSONObject(raw)
        val cmds = o.optJSONArray("commands") ?: JSONArray()
        val contacts = o.optJSONArray("contacts") ?: JSONArray()
        val places = o.optJSONArray("places")
        return Config(
            places = if (places == null) seedPlaces() else (0 until places.length()).map { i ->
                val p = places.getJSONObject(i)
                Place(
                    id = p.optString("id").ifBlank { newId() },
                    name = p.optString("name"),
                    aliases = strings(p.optJSONArray("aliases")),
                    address = p.optString("address"),
                )
            },
            commands = (0 until cmds.length()).map { i ->
                val c = cmds.getJSONObject(i)
                Command(
                    id = c.optString("id").ifBlank { newId() },
                    name = c.optString("name"),
                    triggers = strings(c.optJSONArray("triggers")),
                    type = enumOr(c.optString("type"), ActionType.WEBHOOK),
                    target = c.optString("target"),
                    method = c.optString("method", "GET").ifBlank { "GET" },
                    body = c.optString("body"),
                    protection = enumOr(c.optString("protection"), Protection.NONE),
                    requireUnlock = c.optBoolean("requireUnlock", false),
                )
            },
            contacts = (0 until contacts.length()).map { i ->
                val c = contacts.getJSONObject(i)
                Contact(
                    id = c.optString("id").ifBlank { newId() },
                    name = c.optString("name"),
                    aliases = strings(c.optJSONArray("aliases")),
                    lineName = c.optString("lineName"),
                    phone = c.optString("phone"),
                    defaultChannel = enumOr(c.optString("defaultChannel"), Channel.LINE),
                )
            },
        )
    }

    private fun strings(a: JSONArray?): List<String> =
        if (a == null) emptyList() else (0 until a.length()).map { a.optString(it) }.filter { it.isNotBlank() }

    private inline fun <reified T : Enum<T>> enumOr(name: String, fallback: T): T =
        enumValues<T>().firstOrNull { it.name == name } ?: fallback

    // ---- 口說密碼（不會隨匯出帶出去）----

    fun secret(ctx: Context): String = prefs(ctx).getString(KEY_SECRET, "").orEmpty()

    fun setSecret(ctx: Context, value: String) {
        prefs(ctx).edit().putString(KEY_SECRET, value.trim()).putInt(KEY_FAILS, 0).putLong(KEY_LOCK_UNTIL, 0).apply()
    }

    /** 連續說錯太多次就暫時鎖住，回傳還要等幾分鐘；0 表示沒鎖。 */
    fun lockedMinutes(ctx: Context): Int {
        val left = prefs(ctx).getLong(KEY_LOCK_UNTIL, 0) - System.currentTimeMillis()
        return if (left <= 0) 0 else ((left + 59_999) / 60_000).toInt()
    }

    fun secretFailed(ctx: Context) {
        val p = prefs(ctx)
        val fails = p.getInt(KEY_FAILS, 0) + 1
        if (fails >= MAX_FAILS) {
            p.edit().putInt(KEY_FAILS, 0).putLong(KEY_LOCK_UNTIL, System.currentTimeMillis() + LOCK_MS).apply()
            log(ctx, "密碼連續說錯 $MAX_FAILS 次，鎖定 10 分鐘")
        } else {
            p.edit().putInt(KEY_FAILS, fails).apply()
        }
    }

    fun secretPassed(ctx: Context) {
        prefs(ctx).edit().putInt(KEY_FAILS, 0).apply()
    }

    // ---- 語音辨識引擎 ----

    fun recognizers(ctx: Context): List<ComponentName> =
        ctx.packageManager.queryIntentServices(Intent(RecognitionService.SERVICE_INTERFACE), 0)
            .map { ComponentName(it.serviceInfo.packageName, it.serviceInfo.name) }
            .filter { it.packageName != ctx.packageName }

    /** 一律明確指定引擎：本 App 當上預設助理後，系統預設的辨識服務會變成我們自己。 */
    fun recognizer(ctx: Context): ComponentName? {
        val all = recognizers(ctx)
        val saved = prefs(ctx).getString(KEY_RECOGNIZER, null)?.let(ComponentName::unflattenFromString)
        if (saved != null && saved in all) return saved
        return all.firstOrNull { it.packageName == "com.google.android.googlequicksearchbox" }
            ?: all.firstOrNull { it.packageName == "com.google.android.tts" }
            ?: all.firstOrNull { it.packageName.startsWith("com.google.") }
            ?: all.firstOrNull()
    }

    fun setRecognizer(ctx: Context, c: ComponentName) {
        prefs(ctx).edit().putString(KEY_RECOGNIZER, c.flattenToString()).apply()
    }

    // ---- 雲端語音辨識（金鑰只存在這支手機，不會隨匯出帶出去）----

    /** "google"＝只用手機內建（最快）；"both"＝先用內建、沒把握再送雲端；"cloud"＝一律送雲端（最準） */
    fun sttMode(ctx: Context): String = prefs(ctx).getString(KEY_STT_MODE, "google") ?: "google"
    fun setSttMode(ctx: Context, mode: String) { prefs(ctx).edit().putString(KEY_STT_MODE, mode).apply() }
    fun openAiKey(ctx: Context): String = prefs(ctx).getString(KEY_OPENAI, "").orEmpty()
    fun setOpenAiKey(ctx: Context, key: String) { prefs(ctx).edit().putString(KEY_OPENAI, key.trim()).apply() }

    // ---- 記住你的說法：反問「你是要…對嗎」答「對」之後，下次同一句話直接執行 ----

    fun learned(ctx: Context): Map<String, String> = runCatching {
        val o = JSONObject(prefs(ctx).getString(KEY_LEARNED, "{}") ?: "{}")
        o.keys().asSequence().associateWith { o.optString(it) }
    }.getOrDefault(emptyMap())

    fun learn(ctx: Context, phraseKey: String, target: String) {
        if (phraseKey.isBlank() || target.isBlank()) return
        val m = LinkedHashMap(learned(ctx))
        m.remove(phraseKey)
        m[phraseKey] = target
        while (m.size > LEARNED_MAX) m.remove(m.keys.first())
        prefs(ctx).edit().putString(KEY_LEARNED, JSONObject(m as Map<*, *>).toString()).apply()
    }

    fun clearLearned(ctx: Context) { prefs(ctx).edit().remove(KEY_LEARNED).apply() }

    // ---- 呼喊喚醒（Picovoice AccessKey 只存在這支手機）----

    fun wakeEnabled(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_WAKE_ON, false)
    fun setWakeEnabled(ctx: Context, on: Boolean) { prefs(ctx).edit().putBoolean(KEY_WAKE_ON, on).apply() }
    fun picoKey(ctx: Context): String = prefs(ctx).getString(KEY_PICO, "").orEmpty()
    fun setPicoKey(ctx: Context, key: String) { prefs(ctx).edit().putString(KEY_PICO, key.trim()).apply() }
    fun wakeSensitivity(ctx: Context): Float = prefs(ctx).getFloat(KEY_WAKE_SENS, 0.5f)
    fun setWakeSensitivity(ctx: Context, v: Float) { prefs(ctx).edit().putFloat(KEY_WAKE_SENS, v.coerceIn(0.1f, 0.9f)).apply() }
    fun wakeName(ctx: Context): String = prefs(ctx).getString(KEY_WAKE_NAME, "").orEmpty()
    fun setWakeName(ctx: Context, name: String) { prefs(ctx).edit().putString(KEY_WAKE_NAME, name).apply() }

    /** 這次是不是「自動開起來的」（自動關的時候只關這種，手動開的不動） */
    fun wakeAuto(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_WAKE_AUTO, false)
    fun setWakeAuto(ctx: Context, on: Boolean) { prefs(ctx).edit().putBoolean(KEY_WAKE_AUTO, on).apply() }
    fun autoCharge(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_AUTO_CHARGE, false)
    fun setAutoCharge(ctx: Context, on: Boolean) { prefs(ctx).edit().putBoolean(KEY_AUTO_CHARGE, on).apply() }
    fun autoBtAddress(ctx: Context): String = prefs(ctx).getString(KEY_AUTO_BT, "").orEmpty()
    fun autoBtName(ctx: Context): String = prefs(ctx).getString(KEY_AUTO_BT_NAME, "").orEmpty()
    fun setAutoBt(ctx: Context, address: String, name: String) {
        prefs(ctx).edit().putString(KEY_AUTO_BT, address).putString(KEY_AUTO_BT_NAME, name).apply()
    }

    // ---- 語音回覆 ----

    fun ttsEngine(ctx: Context): String? = prefs(ctx).getString(KEY_TTS_ENGINE, null)
    fun ttsVoice(ctx: Context): String? = prefs(ctx).getString(KEY_TTS_VOICE, null)
    fun ttsRate(ctx: Context): Float = prefs(ctx).getFloat(KEY_TTS_RATE, 1.0f)

    fun setTtsEngine(ctx: Context, pkg: String?) {
        prefs(ctx).edit().putString(KEY_TTS_ENGINE, pkg).remove(KEY_TTS_VOICE).apply()
    }

    fun setTtsVoice(ctx: Context, id: String?) {
        prefs(ctx).edit().putString(KEY_TTS_VOICE, id).apply()
    }

    fun setTtsRate(ctx: Context, rate: Float) {
        prefs(ctx).edit().putFloat(KEY_TTS_RATE, rate).apply()
    }

    // ---- 公司行事曆（裝在桌面的那個，可以接收分享）----

    /** 找出名字有「行事曆」、而且收得下圖片或文字分享的 App；找不到回 null。 */
    fun calendarTarget(ctx: Context, mime: String): ComponentName? {
        val pm = ctx.packageManager
        val probe = Intent(Intent.ACTION_SEND).setType(mime)
        val hits = pm.queryIntentActivities(probe, 0).filter { it.activityInfo.packageName != ctx.packageName }
        fun label(r: android.content.pm.ResolveInfo) = r.loadLabel(pm).toString()
        val pick = hits.firstOrNull { label(it).contains("譽昇行事曆") }
            ?: hits.firstOrNull { label(it) == "行事曆" }
            ?: hits.firstOrNull { label(it).contains("行事曆") && !it.activityInfo.packageName.startsWith("com.google.") &&
                !it.activityInfo.packageName.startsWith("com.samsung.") }
        return pick?.let { ComponentName(it.activityInfo.packageName, it.activityInfo.name) }
    }

    // ---- 已安裝的 App ----

    fun apps(ctx: Context): List<AppEntry> {
        val pm = ctx.packageManager
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        return pm.queryIntentActivities(intent, 0)
            .filter { it.activityInfo.packageName != ctx.packageName }
            .map { AppEntry(it.loadLabel(pm).toString(), it.activityInfo.packageName) }
            .distinctBy { it.pkg }
            .sortedBy { it.label }
    }

    // ---- 執行紀錄（排查問題用）----

    @Synchronized
    fun log(ctx: Context, line: String) {
        runCatching {
            val f = File(ctx.filesDir, LOG_FILE)
            if (f.length() > LOG_MAX) f.writeText(f.readText().takeLast((LOG_MAX / 2).toInt()))
            val ts = SimpleDateFormat("MM-dd HH:mm:ss", Locale.US).format(Date())
            f.appendText("$ts $line\n")
        }
    }

    @Synchronized
    fun readLog(ctx: Context): String =
        runCatching { File(ctx.filesDir, LOG_FILE).readText() }.getOrDefault("")

    @Synchronized
    fun clearLog(ctx: Context) {
        runCatching { File(ctx.filesDir, LOG_FILE).delete() }
    }
}
