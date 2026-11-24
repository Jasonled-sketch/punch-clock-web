package com.voicekey.app.line

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Context
import android.content.Intent
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Toast
import android.content.ClipData
import android.content.ClipboardManager
import com.voicekey.app.core.Names
import com.voicekey.app.data.Store

/**
 * LINE 沒有提供「直接打給某位好友」的接口，所以用無障礙服務代替手指操作：
 * 開 LINE → 搜尋好友名稱 → 點進去 → 按「語音通話」。
 *
 * 每一步都看「畫面上現在有什麼」來決定下一步，LINE 小改版時比較不容易壞；
 * 失敗時會把當下的畫面結構寫進紀錄，方便調整。
 */
class LineCallService : AccessibilityService() {

    companion object {
        const val LINE_PKG = "jp.naver.line.android"

        @Volatile
        var instance: LineCallService? = null

        private val SEARCH = listOf("搜尋", "search", "検索")
        private val FRIEND_TAB = listOf("好友", "friends", "友だち")
        private val VOICE = listOf("語音通話", "免費通話", "voice call", "音声通話", "無料通話")
        private val VIDEO = listOf("視訊通話", "video call", "ビデオ通話")
        private val CALL_ICON = listOf("通話", "語音通話", "call", "撥打")
        private val GO = listOf("開始", "確定", "撥打", "通話", "start", "ok", "call")

        private const val TICK_MS = 450L
        private const val LAUNCH_TIMEOUT_MS = 15_000L
        private const val CLICK_GAP_MS = 1200L

        fun launchLine(ctx: Context): Boolean {
            val intent = ctx.packageManager.getLaunchIntentForPackage(LINE_PKG) ?: return false
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            return runCatching { ctx.startActivity(intent) }.isSuccess
        }
    }

    private enum class Stage(val timeoutMs: Long) {
        SEARCH(9000), PICK(9000), OPENED(9000), CONFIRM(3500)
    }

    private class Job(val name: String) {
        var stage = Stage.SEARCH
        var stageSince = System.currentTimeMillis()
        var lastClick = 0L
        var typedAt = 0L
        var editBottom = 0
        var pasted = false
        var friendTab = false
        var seen: List<String> = emptyList()
        val createdAt = System.currentTimeMillis()
        var lineSeen = false
    }

    private val handler = Handler(Looper.getMainLooper())
    private var job: Job? = null
    private val ticker = object : Runnable {
        override fun run() {
            if (job == null) return
            runCatching { step() }.onFailure { fail("操作 LINE 時出錯：${it.message}") }
            if (job != null) handler.postDelayed(this, TICK_MS)
        }
    }

    override fun onServiceConnected() {
        instance = this
        Store.log(this, "LINE 通話服務已啟動")
    }

    override fun onUnbind(intent: Intent?): Boolean {
        instance = null
        job = null
        handler.removeCallbacksAndMessages(null)
        return super.onUnbind(intent)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}

    override fun onInterrupt() {}

    /** 由聆聽畫面呼叫：接下來 LINE 開到前景時，自動撥給這位好友。 */
    fun startCall(lineName: String) {
        handler.removeCallbacks(ticker)
        job = Job(lineName.trim())
        Store.log(this, "LINE 通話開始：找「${lineName.trim()}」")
        handler.postDelayed(ticker, 700)
    }

    /** 設定頁的工具：幾秒後把目前畫面結構寫進紀錄。 */
    fun dumpLater(delayMs: Long) {
        handler.postDelayed({
            dump("手動擷取")
            toast("已擷取畫面結構，請回設定頁看紀錄")
        }, delayMs)
    }

    private fun step() {
        val j = job ?: return
        val now = System.currentTimeMillis()
        val root = rootInActiveWindow
        if (root == null || root.packageName?.toString() != LINE_PKG) {
            // LINE 冷啟動可能要好幾秒；還沒出現前不算進各步驟的時間
            if (!j.lineSeen && now - j.createdAt > LAUNCH_TIMEOUT_MS) fail("LINE 沒有開到前景")
            else if (j.lineSeen && now - j.stageSince > j.stage.timeoutMs) fail("LINE 被切到背景，已停止")
            return
        }
        if (!j.lineSeen) {
            j.lineSeen = true
            j.stageSince = now
        }
        val nodes = collect(root)
        val screenH = resources.displayMetrics.heightPixels

        when (j.stage) {
            Stage.SEARCH -> {
                // 只認搜尋欄：還沒按過搜尋入口時，輸入框必須自己標示是「搜尋」，避免把名字打進聊天輸入框
                val edit = nodes.firstOrNull { n ->
                    n.isEditable && (j.lastClick > 0 || SEARCH.any { s ->
                        n.says(s, prefix = true) || n.hintText?.toString()?.startsWith(s, true) == true
                    })
                }
                if (edit != null) {
                    edit.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
                    val args = Bundle().apply {
                        putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, j.name)
                    }
                    if (edit.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
                        j.typedAt = now
                        j.editBottom = edit.bounds().bottom
                        go(j, Stage.PICK)
                    }
                    return
                }
                if (now - j.lastClick > CLICK_GAP_MS) {
                    val entry = nodes.firstOrNull { n -> SEARCH.any { n.says(it, prefix = true) } }
                    if (entry != null && click(entry)) j.lastClick = now
                }
            }

            Stage.PICK -> {
                if (now - j.typedAt < 800) return
                val want = Names.norm(j.name)
                // 只看搜尋欄下面的結果；名稱比對忽略空白、emoji、符號，但不接受「包含」以免打錯人
                val results = nodes.filter {
                    !it.isEditable && it.textOf().isNotEmpty() && it.bounds().top >= j.editBottom - 4
                }
                // 真的 LINE（Jason 11/24 截圖）：搜尋結果預設在「全部」分頁，先列一大串有對方在裡面的群組，好友本人排在很下面
                //   → 先切到上面那排分頁的「好友」，結果就只剩好友
                if (!j.friendTab && now - j.lastClick > CLICK_GAP_MS) {
                    val tab = results.firstOrNull { n ->
                        n.bounds().top < screenH * 0.3 && FRIEND_TAB.any { n.textOf().equals(it, true) || n.descOf().equals(it, true) }
                    }
                    if (tab != null && click(tab)) {
                        j.friendTab = true
                        j.lastClick = now
                        j.typedAt = now
                        Store.log(this, "LINE 通話：切到「好友」分頁")
                        return
                    }
                }
                j.seen = results.map { it.textOf() }.distinct().take(8)
                val hit = results.firstOrNull { Names.norm(it.textOf()) == want }
                if (hit != null) {
                    if (now - j.lastClick > CLICK_GAP_MS && click(hit)) {
                        j.lastClick = now
                        go(j, Stage.OPENED)
                    }
                    return
                }
                // 直接塞文字 LINE 有時不會開始搜尋：改用「貼上」再試一次
                if (!j.pasted && now - j.typedAt > 3000) {
                    j.pasted = true
                    val edit = nodes.firstOrNull { it.isEditable }
                    if (edit != null) {
                        Store.log(this, "LINE 搜尋沒有結果，改用貼上再試")
                        paste(edit, j.name)
                        j.typedAt = now
                    }
                }
            }

            Stage.OPENED -> {
                if (now - j.lastClick < 700) return
                var voice = nodes.filter { n -> VOICE.any { n.says(it) } }
                val video = nodes.filter { n -> VIDEO.any { n.says(it) } }
                if (voice.isEmpty() && video.isNotEmpty()) voice = nodes.filter { it.says("通話") }
                if (voice.isNotEmpty() && video.isNotEmpty()) {
                    // 同時看到「語音通話」「視訊通話」＝好友資料卡或通話選單，挑跟視訊並排的那顆
                    val refY = video.first().bounds().centerY()
                    val target = voice.minByOrNull { kotlin.math.abs(it.bounds().centerY() - refY) }!!
                    if (click(target)) {
                        j.lastClick = now
                        go(j, Stage.CONFIRM)
                    }
                    return
                }
                if (now - j.lastClick > CLICK_GAP_MS) {
                    // 聊天室右上角的話筒
                    val icon = nodes.firstOrNull { n ->
                        n.bounds().top < screenH * 0.2 && CALL_ICON.any { n.descOf().equals(it, true) }
                    }
                    if (icon != null && click(icon)) j.lastClick = now
                }
            }

            Stage.CONFIRM -> {
                val ok = nodes.firstOrNull { n -> GO.any { n.textOf().equals(it, true) } }
                if (ok != null && click(ok)) {
                    done("已撥出")
                    return
                }
            }
        }

        if (job === j && now - j.stageSince > j.stage.timeoutMs) {
            when (j.stage) {
                Stage.SEARCH -> fail("找不到 LINE 的搜尋欄")
                Stage.PICK -> {
                    val shown = j.seen.filter { it != j.name }.take(5)
                    fail(
                        "LINE 搜尋不到「${j.name}」" +
                            (if (shown.isNotEmpty()) "。畫面上看到：${shown.joinToString("、")}" else "") +
                            "。請把聯絡人的 LINE 名稱改成跟 LINE 顯示的一樣",
                    )
                }
                Stage.OPENED -> fail("找不到通話按鈕")
                Stage.CONFIRM -> done("已按下語音通話")
            }
        }
    }

    private fun paste(edit: AccessibilityNodeInfo, text: String) {
        runCatching {
            getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("語音快捷", text))
            edit.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
            edit.performAction(
                AccessibilityNodeInfo.ACTION_SET_TEXT,
                Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, "") },
            )
            edit.performAction(AccessibilityNodeInfo.ACTION_PASTE)
        }.onFailure { Store.log(this, "貼上失敗：${it.message}") }
    }

    private fun go(j: Job, stage: Stage) {
        j.stage = stage
        j.stageSince = System.currentTimeMillis()
        Store.log(this, "LINE 通話 → ${stage.name}")
    }

    private fun done(msg: String) {
        Store.log(this, "LINE 通話完成：$msg")
        job = null
    }

    private fun fail(msg: String) {
        Store.log(this, "LINE 通話失敗：$msg")
        dump("失敗時的畫面")
        job = null
        toast("語音快捷：$msg")
    }

    private fun toast(msg: String) {
        handler.post { Toast.makeText(applicationContext, msg, Toast.LENGTH_LONG).show() }
    }

    // ---- 畫面節點工具 ----

    private fun collect(root: AccessibilityNodeInfo): List<AccessibilityNodeInfo> {
        val out = ArrayList<AccessibilityNodeInfo>()
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        stack.addLast(root)
        while (stack.isNotEmpty() && out.size < 2500) {
            val n = stack.removeLast()
            if (n.isVisibleToUser) out.add(n)
            for (i in n.childCount - 1 downTo 0) n.getChild(i)?.let(stack::addLast)
        }
        return out
    }

    private fun AccessibilityNodeInfo.textOf(): String = text?.toString()?.trim().orEmpty()
    private fun AccessibilityNodeInfo.descOf(): String = contentDescription?.toString()?.trim().orEmpty()
    private fun AccessibilityNodeInfo.bounds(): Rect = Rect().also(::getBoundsInScreen)

    private fun AccessibilityNodeInfo.says(word: String, prefix: Boolean = false): Boolean {
        val t = textOf()
        val d = descOf()
        return if (prefix) t.startsWith(word, true) || d.startsWith(word, true)
        else t.equals(word, true) || d.equals(word, true)
    }

    private fun click(node: AccessibilityNodeInfo): Boolean {
        var n: AccessibilityNodeInfo? = node
        repeat(6) {
            val cur = n ?: return@repeat
            if (cur.isClickable && cur.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true
            n = cur.parent
        }
        val b = node.bounds()
        if (b.isEmpty) return false
        val path = Path().apply { moveTo(b.exactCenterX(), b.exactCenterY()) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 60))
            .build()
        return dispatchGesture(gesture, null, null)
    }

    private fun dump(reason: String) {
        val root = rootInActiveWindow
        if (root == null) {
            Store.log(this, "畫面結構（$reason）：讀不到畫面")
            return
        }
        val sb = StringBuilder("畫面結構（$reason）pkg=${root.packageName}\n")
        var count = 0
        fun walk(n: AccessibilityNodeInfo, depth: Int) {
            if (count >= 350) return
            if (n.isVisibleToUser) {
                val t = n.textOf().take(16)
                val d = n.descOf().take(16)
                if (t.isNotEmpty() || d.isNotEmpty() || n.isClickable || n.isEditable) {
                    count++
                    sb.append("  ".repeat(minOf(depth, 12)))
                        .append(n.className?.toString()?.substringAfterLast('.') ?: "?")
                    if (t.isNotEmpty()) sb.append(" 文字=「").append(t).append('」')
                    if (d.isNotEmpty()) sb.append(" 說明=「").append(d).append('」')
                    n.viewIdResourceName?.let { sb.append(" id=").append(it.substringAfterLast('/')) }
                    if (n.isClickable) sb.append(" 可點")
                    if (n.isEditable) sb.append(" 可輸入")
                    sb.append(' ').append(n.bounds().toShortString()).append('\n')
                }
            }
            for (i in 0 until n.childCount) n.getChild(i)?.let { walk(it, depth + 1) }
        }
        walk(root, 0)
        Store.log(this, sb.toString())
    }
}
