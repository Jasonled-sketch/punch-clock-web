package com.voicekey.app.core

/** 用讀音找關鍵詞：語音把「行程」聽成「行政」、「知識庫」聽成「支市庫」也找得到。回傳 (起點, 長度)。 */
internal object Sound {
    fun find(t: String, patterns: List<List<Set<String>>>): Pair<Int, Int>? {
        val canon = t.map { ch -> Phonetic.tokens(ch.toString()).firstOrNull()?.takeIf { !it.startsWith("@") }?.let(Phonetic::canon).orEmpty() }
        var best: Pair<Int, Int>? = null
        for (p in patterns) {
            for (i in 0..t.length - p.size) {
                if (p.indices.all { canon[i + it] in p[it] }) {
                    if (best == null || i < best!!.first || (i == best!!.first && p.size > best!!.second)) best = i to p.size
                    break
                }
            }
        }
        return best
    }

    fun clean(text: String): String = text.replace(Regex("[\\s，。,.！!？?、：:]"), "")
}

/** 「幫我登記行程 個人」「登記到公司行事曆 明天下午三點去永康估價」→ 要登記的內容與哪一本。 */
object Schedule {
    data class Ask(val detail: String, val calendar: String)

    // 行事曆、行程（含常聽錯的「行政」「行成」）
    private val KEYS = listOf(
        listOf(setOf("xin"), setOf("si"), setOf("li")),
        listOf(setOf("xin"), setOf("cen", "zen")),
    )
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
        val t = Sound.clean(text)
        val hit = Sound.find(t, KEYS) ?: return null
        var before = t.substring(0, hit.first)
        var after = t.substring(hit.first + hit.second)
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

/** 「存到知識庫」「把這個放進知識庫」「存知識庫 每天早上先做最難的事」→ 要存的內容（空白＝存當下畫面）。 */
object Knowledge {
    private val KEYS = listOf(listOf(setOf("zi"), setOf("si"), setOf("ku")))
    private val VERBS = listOf("存", "加", "放", "記", "丟", "收", "留", "保存", "收藏")
    private val LEAD = listOf("幫我", "請", "麻煩", "把這個", "把這則", "把這篇", "把畫面上的", "把畫面", "把", "這個", "這則", "這篇", "畫面上的")
    private val BEFORE_TAIL = listOf(
        "存到", "存進", "存入", "保存到", "收藏到", "加到", "加進", "加入", "放到", "放進", "放入", "記到", "記進",
        "丟到", "丟進", "收到", "收進", "留到", "留在", "存", "加", "放", "記", "丟", "收", "留", "到", "進", "在", "我的", "的",
    )
    private val AFTER_HEAD = listOf("裡面", "裡", "中", "的", "說", "是")

    fun parse(text: String): String? {
        val t = Sound.clean(text)
        val hit = Sound.find(t, KEYS) ?: return null
        var before = t.substring(0, hit.first)
        var after = t.substring(hit.first + hit.second)
        // 「打開知識庫」是去看，不是存
        if (VERBS.none { before.contains(it) }) return null
        var changed = true
        while (changed) {
            changed = false
            for (p in LEAD) if (before.startsWith(p)) { before = before.substring(p.length); changed = true }
            for (p in BEFORE_TAIL) if (before.endsWith(p)) { before = before.dropLast(p.length); changed = true }
            for (p in AFTER_HEAD) if (after.startsWith(p)) { after = after.substring(p.length); changed = true }
        }
        return before + after
    }
}
