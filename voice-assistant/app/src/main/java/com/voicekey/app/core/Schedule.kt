package com.voicekey.app.core

/** 「幫我登記行程 個人」「登記到公司行事曆 明天下午三點去永康估價」→ 要登記的內容與哪一本。 */
object Schedule {
    data class Ask(val detail: String, val calendar: String)

    private val KEYS = listOf("行事曆", "行程")
    private val VERBS = listOf("登記", "登錄", "記錄", "記", "排", "加", "新增", "建立", "安排", "寫", "存")
    private val LEAD = listOf("幫我", "請", "麻煩", "把這個", "把這則", "把畫面上的", "把畫面", "把", "這個", "這則", "畫面上的")
    private val BEFORE_TAIL = listOf(
        "登記到", "登記進", "登記在", "登記", "登錄到", "登錄", "記錄到", "記錄", "記到", "記在", "記進",
        "排進", "排到", "排", "加到", "加進", "加入", "加", "新增到", "新增", "建立", "安排到", "安排",
        "寫到", "寫進", "存到", "存進", "記", "到", "進", "在", "的", "一個", "一筆",
        "公司", "個人", "私人", "我的", "我",
    )
    private val AFTER_HEAD = listOf("裡面", "裡", "上面", "上", "中", "的", "個人", "私人", "公司", "我的", "行事曆", "行程", "說", "是")
    private val PERSONAL = listOf("個人", "私人", "我的")

    fun parse(text: String): Ask? {
        val t = text.replace(Regex("[\\s，。,.！!？?、：:]"), "")
        val hit = KEYS.mapNotNull { k -> t.indexOf(k).takeIf { it >= 0 }?.let { it to k } }.minByOrNull { it.first } ?: return null
        var before = t.substring(0, hit.first)
        var after = t.substring(hit.first + hit.second.length)
        // 「打開行事曆」是開 App，不是登記
        if (VERBS.none { before.contains(it) || after.startsWith(it) }) return null

        val head = before + after.take(4)
        val calendar = when {
            PERSONAL.any { head.contains(it) } -> "個人"
            head.contains("公司") -> "公司"
            else -> ""
        }
        var changed = true
        while (changed) {
            changed = false
            for (p in LEAD) if (before.startsWith(p)) { before = before.substring(p.length); changed = true }
            for (p in BEFORE_TAIL) if (before.endsWith(p)) { before = before.dropLast(p.length); changed = true }
            for (p in AFTER_HEAD) if (after.startsWith(p)) { after = after.substring(p.length); changed = true }
        }
        return Ask(before + after, calendar)
    }
}
