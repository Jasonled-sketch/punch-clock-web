package com.voicekey.app.actions

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
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
        is Parsed.Call, is Parsed.Open -> true
        is Parsed.Unknown -> false
    }

    /** 需要先解鎖手機才做得到的動作。 */
    fun needsUnlock(p: Parsed): Boolean = when (p) {
        is Parsed.Run -> p.command.requireUnlock || p.command.type != ActionType.WEBHOOK
        is Parsed.Call -> p.channel == Channel.LINE
        is Parsed.Open -> true
        is Parsed.Unknown -> false
    }

    suspend fun run(activity: Activity, p: Parsed): Outcome = when (p) {
        is Parsed.Run -> runCommand(activity, p.command)
        is Parsed.Call ->
            if (p.channel == Channel.LINE) lineCall(activity, p.contact.lineName.ifBlank { p.contact.name })
            else phoneCall(activity, p.contact.phone)
        is Parsed.Open -> openApp(activity, p.app.pkg)
        is Parsed.Unknown -> Outcome(false, "聽不懂")
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
                if (code in 200..299) Outcome(true, "${c.name}，指令已送出")
                else Outcome(false, "${c.name}失敗，伺服器回應 $code")
            } catch (e: Exception) {
                Outcome(false, "${c.name}失敗，連不上網路或網址有誤")
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
