package com.voicekey.app.actions

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.content.ClipData
import android.graphics.Bitmap
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.File
import com.voicekey.app.core.ActionType
import com.voicekey.app.core.Channel
import com.voicekey.app.core.Command
import com.voicekey.app.core.Parsed
import com.voicekey.app.data.Store
import com.voicekey.app.line.LineCallService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

data class Outcome(val ok: Boolean, val message: String)

object ActionRunner {

    /** 會跳去別的 App 的動作，要先把話說完再執行，免得語音蓋到通話。 */
    fun leavesApp(p: Parsed): Boolean = when (p) {
        is Parsed.Run -> p.command.type != ActionType.WEBHOOK
        is Parsed.Call, is Parsed.Open, is Parsed.Navigate, is Parsed.Schedule -> true
        is Parsed.Unknown -> false
    }

    /** 需要先解鎖手機才做得到的動作。 */
    fun needsUnlock(p: Parsed): Boolean = when (p) {
        is Parsed.Run -> p.command.requireUnlock || p.command.type != ActionType.WEBHOOK
        is Parsed.Call -> p.channel == Channel.LINE
        is Parsed.Open, is Parsed.Navigate, is Parsed.Schedule -> true
        is Parsed.Unknown -> false
    }

    /** shot＝叫出助理那一刻的畫面（只有登記行程會用到）。 */
    suspend fun run(activity: Activity, p: Parsed, shot: Bitmap? = null): Outcome = when (p) {
        is Parsed.Run -> runCommand(activity, p.command)
        is Parsed.Call ->
            if (p.channel == Channel.LINE) lineCall(activity, p.contact.lineName.ifBlank { p.contact.name })
            else phoneCall(activity, p.contact.phone)
        is Parsed.Open -> openApp(activity, p.app.pkg)
        is Parsed.Navigate -> navigate(activity, p)
        is Parsed.Schedule -> schedule(activity, p, shot)
        is Parsed.Unknown -> Outcome(false, "聽不懂")
    }

    /** 登記行程會不會成功，在說「好」之前先看得出來的問題。null＝沒問題。 */
    fun scheduleProblem(activity: Activity, p: Parsed.Schedule, shot: Bitmap?): String? {
        val useShot = p.detail.length < 4
        if (useShot && shot == null) {
            return "我沒有拿到畫面。請在要登記的那個畫面上長按側鍵再說一次，或是直接把時間和事情說出來"
        }
        if (Store.calendarTarget(activity, if (useShot) "image/jpeg" else "text/plain") == null) {
            return "手機上找不到公司行事曆。請先用瀏覽器打開公司行事曆，選「安裝到手機桌面」"
        }
        return null
    }

    /**
     * 交給公司行事曆原本就有的「截圖排行程」：它會用 AI 讀出日期時間地點、把新增表單填好，人看過再按儲存。
     * 這裡不直接寫進行事曆，所以不會有說錯就登記錯的問題。
     */
    private suspend fun schedule(activity: Activity, p: Parsed.Schedule, shot: Bitmap?): Outcome {
        scheduleProblem(activity, p, shot)?.let { return Outcome(false, it) }
        val useShot = p.detail.length < 4
        val intent = Intent(Intent.ACTION_SEND).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (useShot) {
            val uri = try {
                withContext(Dispatchers.IO) {
                    val dir = File(activity.cacheDir, "shots").apply { mkdirs() }
                    val f = File(dir, "screen.jpg")
                    f.outputStream().use { shot!!.compress(Bitmap.CompressFormat.JPEG, 88, it) }
                    FileProvider.getUriForFile(activity, activity.packageName + ".files", f)
                }
            } catch (e: Exception) {
                Store.log(activity, "存截圖失敗：${e.message}")
                return Outcome(false, "畫面沒有存成功，請再試一次")
            }
            intent.setType("image/jpeg").putExtra(Intent.EXTRA_STREAM, uri)
            intent.clipData = ClipData.newRawUri("screen", uri)
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            intent.component = Store.calendarTarget(activity, "image/jpeg")
        } else {
            intent.setType("text/plain").putExtra(Intent.EXTRA_TEXT, p.detail)
            intent.component = Store.calendarTarget(activity, "text/plain")
        }
        return if (runCatching { activity.startActivity(intent) }.isSuccess) Outcome(true, "")
        else Outcome(false, "打不開公司行事曆")
    }

    private const val MAPS = "com.google.android.apps.maps"

    private fun navigate(activity: Activity, p: Parsed.Navigate): Outcome {
        val place = p.place
        if (place != null && place.address.isBlank()) {
            return Outcome(false, "還沒有設定${place.name}的地址，請到設定頁的地點填寫")
        }
        val hasMaps = activity.packageManager.getLaunchIntentForPackage(MAPS) != null
        if (p.query.isBlank()) {
            return if (hasMaps) openApp(activity, MAPS) else openUrl(activity, "geo:0,0")
        }
        val q = Uri.encode(p.query.trim())
        val intent = if (hasMaps) {
            Intent(Intent.ACTION_VIEW, Uri.parse("google.navigation:q=$q&mode=${p.mode}")).setPackage(MAPS)
        } else {
            Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=$q"))
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return if (runCatching { activity.startActivity(intent) }.isSuccess) Outcome(true, "") else Outcome(false, "打不開地圖")
    }

    private suspend fun runCommand(activity: Activity, c: Command): Outcome = when (c.type) {
        ActionType.WEBHOOK -> webhook(c)
        ActionType.OPEN_APP -> openApp(activity, c.target)
        ActionType.OPEN_URL -> openUrl(activity, c.target)
        ActionType.CALL_PHONE -> phoneCall(activity, c.target)
        ActionType.LINE_CALL -> lineCall(activity, c.target)
    }

    private suspend fun webhook(c: Command): Outcome {
        val url = c.target.trim()
        if (url.isEmpty()) return Outcome(false, "${c.name}還沒有設定網址，請到設定頁填寫")
        return withContext(Dispatchers.IO) {
            try {
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.connectTimeout = 8000
                conn.readTimeout = 8000
                conn.requestMethod = if (c.method.equals("POST", true)) "POST" else "GET"
                if (conn.requestMethod == "POST") {
                    conn.doOutput = true
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.outputStream.use { it.write(c.body.toByteArray()) }
                }
                val code = conn.responseCode
                runCatching { (if (code in 200..299) conn.inputStream else conn.errorStream)?.close() }
                conn.disconnect()
                if (code in 200..299) Outcome(true, "好了，${c.name}，已經送出囉")
                else Outcome(false, "不好意思，${c.name}沒有成功，伺服器回應 $code")
            } catch (e: Exception) {
                Outcome(false, "不好意思，${c.name}沒有成功，可能是網路不通或網址有誤")
            }
        }
    }

    private fun openApp(activity: Activity, pkg: String): Outcome {
        val intent = activity.packageManager.getLaunchIntentForPackage(pkg.trim())
            ?: return Outcome(false, "手機裡找不到這個 App")
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return if (runCatching { activity.startActivity(intent) }.isSuccess) Outcome(true, "") else Outcome(false, "打不開這個 App")
    }

    private fun openUrl(activity: Activity, url: String): Outcome {
        if (url.isBlank()) return Outcome(false, "還沒有設定連結")
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url.trim())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return if (runCatching { activity.startActivity(intent) }.isSuccess) Outcome(true, "") else Outcome(false, "打不開這個連結")
    }

    private fun phoneCall(activity: Activity, number: String): Outcome {
        val num = number.filter { it.isDigit() || it == '+' || it == '#' || it == '*' }
        if (num.isEmpty()) return Outcome(false, "這位聯絡人沒有設定電話號碼")
        val granted = activity.checkSelfPermission(Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED
        val intent = Intent(if (granted) Intent.ACTION_CALL else Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(num)))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return if (runCatching { activity.startActivity(intent) }.isSuccess) Outcome(true, "") else Outcome(false, "無法撥號")
    }

    private fun lineCall(activity: Activity, lineName: String): Outcome {
        if (lineName.isBlank()) return Outcome(false, "這位聯絡人沒有設定 LINE 名稱")
        val service = LineCallService.instance
            ?: return Outcome(false, "LINE 通話功能還沒開啟，請到設定頁開啟無障礙權限")
        if (activity.packageManager.getLaunchIntentForPackage(LineCallService.LINE_PKG) == null) {
            return Outcome(false, "手機沒有安裝 LINE")
        }
        service.startCall(lineName)
        if (!LineCallService.launchLine(activity)) return Outcome(false, "打不開 LINE")
        Store.log(activity, "已交給 LINE 通話服務")
        return Outcome(true, "")
    }
}
