package com.voicekey.app.core

import java.text.Normalizer

/** 從「導航回公司」「帶我去台北車站」「到高雄車站怎麼走」這類句子挑出目的地與交通方式。 */
object Nav {
    data class Ask(val dest: String, val mode: String)

    private val AFTER_KEYS = listOf("導航", "导航", "帶我去", "帶我回", "帶我到", "載我去", "載我回", "開車去", "開車回", "騎車去", "騎車回", "走路去", "走路回")
    private val BEFORE_KEYS = listOf("怎麼去", "怎麼走", "怎麼回去", "的路線", "路線")
    private val LEAD = listOf(
        "我要", "我想", "請", "幫我", "一下", "前往", "回到", "開車", "騎車", "走路",
        "到", "去", "回", "至", "往", "給我",
    )
    private val TAIL = listOf("的路線", "路線", "的路", "吧", "好了", "謝謝", "一下")

    fun parse(text: String): Ask? {
        val t = text.replace(Regex("[\\s，。,.！!？?、]"), "")
        val after = AFTER_KEYS.mapNotNull { k -> t.indexOf(k).takeIf { it >= 0 }?.let { it to k } }.minByOrNull { it.first }
        val before = BEFORE_KEYS.mapNotNull { k -> t.indexOf(k).takeIf { it >= 0 }?.let { it to k } }.minByOrNull { it.first }
        if (after == null && before == null) return null

        var dest = ""
        if (after != null) dest = clean(t.substring(after.first + after.second.length))
        if (dest.isEmpty() && before != null) {
            val start = after?.let { it.first + it.second.length } ?: 0
            if (before.first >= start) dest = clean(t.substring(start, before.first))
        }
        return Ask(dest, mode(t))
    }

    private fun clean(s: String): String {
        var d = s
        var changed = true
        while (changed && d.isNotEmpty()) {
            changed = false
            for (p in LEAD) if (d.startsWith(p) && d.length > p.length) { d = d.substring(p.length); changed = true }
            for (p in TAIL) if (d.endsWith(p)) { d = d.dropLast(p.length); changed = true }
        }
        return d
    }

    private fun mode(t: String): String = when {
        listOf("走路", "步行").any { t.contains(it) } -> "w"
        listOf("騎車", "機車", "摩托車").any { t.contains(it) } -> "l"
        listOf("腳踏車", "單車", "自行車").any { t.contains(it) } -> "b"
        else -> "d"
    }
}

/** 比對 LINE 顯示名稱用：去掉空白、emoji、符號，全形半形一致。 */
object Names {
    fun norm(s: String): String =
        Normalizer.normalize(s, Normalizer.Form.NFKC).filter { it.isLetterOrDigit() }.lowercase()
}
