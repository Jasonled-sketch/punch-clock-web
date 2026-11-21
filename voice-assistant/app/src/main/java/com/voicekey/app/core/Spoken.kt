package com.voicekey.app.core

/** 「確定／取消」與口說密碼的判讀。 */
object Spoken {
    private val NO = listOf("取消", "不要", "不用", "不是", "不對", "不行", "算了", "否", "停", "no", "cancel")
    private val YES = listOf("確定", "確認", "沒錯", "可以", "是", "對", "好", "要", "yes", "ok")
    private val YES_SOUND = listOf(listOf("que", "din"), listOf("que", "len"))

    private val NUMERAL = mapOf(
        '零' to '0', '〇' to '0', '洞' to '0',
        '一' to '1', '壹' to '1', '么' to '1', '幺' to '1',
        '二' to '2', '貳' to '2', '兩' to '2', '两' to '2',
        '三' to '3', '參' to '3', '叁' to '3',
        '四' to '4', '肆' to '4',
        '五' to '5', '伍' to '5',
        '六' to '6', '陸' to '6',
        '七' to '7', '柒' to '7',
        '八' to '8', '捌' to '8',
        '九' to '9', '玖' to '9',
    )

    fun isNo(candidates: List<String>): Boolean =
        candidates.any { c -> NO.any { c.lowercase().contains(it) } }

    fun isYes(candidates: List<String>): Boolean {
        if (isNo(candidates)) return false
        return candidates.any { c ->
            val low = c.lowercase()
            if (YES.any { low.contains(it) }) return@any true
            val canon = Phonetic.tokens(c).map(Phonetic::canon)
            YES_SOUND.any { containsRun(canon, it) }
        }
    }

    /** 從一句話裡挑出數字，例如「密碼是一二三四」→ "1234"。 */
    fun digits(text: String): String {
        val sb = StringBuilder()
        for (ch in text) {
            when {
                ch in '0'..'9' -> sb.append(ch)
                ch in '０'..'９' -> sb.append('0' + (ch - '０'))
                else -> NUMERAL[ch]?.let(sb::append)
            }
        }
        return sb.toString()
    }

    fun secretMatches(candidates: List<String>, secret: String): Boolean {
        val s = secret.trim()
        if (s.isEmpty()) return false
        val want = Phonetic.tokens(s).map(Phonetic::canon)
        if (want.isEmpty()) return false
        val numeric = s.all { it in '0'..'9' }
        return candidates.any { c ->
            if (numeric && digits(c) == s) return@any true
            val got = Phonetic.tokens(c).map(Phonetic::canon)
            if (numeric) got == want else containsRun(got, want)
        }
    }

    private fun containsRun(hay: List<String>, needle: List<String>): Boolean {
        if (needle.isEmpty() || hay.size < needle.size) return false
        for (i in 0..hay.size - needle.size) {
            var ok = true
            for (j in needle.indices) if (hay[i + j] != needle[j]) { ok = false; break }
            if (ok) return true
        }
        return false
    }
}
