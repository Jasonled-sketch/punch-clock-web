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
    )

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
        return JSONObject().put("version", 1).put("commands", cmds).put("contacts", contacts).toString(2)
    }

    fun fromJson(raw: String): Config {
        val o = JSONObject(raw)
        val cmds = o.optJSONArray("commands") ?: JSONArray()
        val contacts = o.optJSONArray("contacts") ?: JSONArray()
        return Config(
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
