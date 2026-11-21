package com.voicekey.app.core

import com.github.promeg.pinyinhelper.Pinyin

/**
 * 把一句話轉成「讀音」再比對，語音辨識聽成同音字或近音字時仍然對得上。
 * 中文字 → 無聲調拼音；英文單字 → "@word"；數字 → 對應的拼音。
 */
object Phonetic {
    private val DIGIT = arrayOf("ling", "yi", "er", "san", "si", "wu", "liu", "qi", "ba", "jiu")

    /** 文字間多出一個贅字（「開一下鐵門」的「一下」）的代價，比聽錯字便宜。 */
    private const val GAP_COST = 0.3

    fun tokens(s: String): List<String> {
        val out = ArrayList<String>()
        val word = StringBuilder()
        fun flush() {
            if (word.isNotEmpty()) {
                out.add("@$word")
                word.setLength(0)
            }
        }
        for (ch in s) {
            when {
                ch in 'a'..'z' || ch in 'A'..'Z' -> word.append(ch.lowercaseChar())
                ch in '0'..'9' -> { flush(); out.add(DIGIT[ch - '0']) }
                ch in '０'..'９' -> { flush(); out.add(DIGIT[ch - '０']) }
                Pinyin.isChinese(ch) -> { flush(); out.add(Pinyin.toPinyin(ch).lowercase()) }
                else -> flush()
            }
        }
        flush()
        return out
    }

    /** 台灣口音常混淆的音歸成同一類：捲舌/不捲舌、ㄋ/ㄌ、ㄖ/ㄌ、前後鼻音。 */
    fun canon(t: String): String {
        if (t.startsWith("@")) return t
        var s = t
        s = when {
            s.startsWith("zh") -> "z" + s.substring(2)
            s.startsWith("ch") -> "c" + s.substring(2)
            s.startsWith("sh") -> "s" + s.substring(2)
            else -> s
        }
        if (s.length > 1 && (s[0] == 'n' || s[0] == 'r')) s = "l" + s.substring(1)
        if (s.endsWith("ng")) s = s.dropLast(1)
        return s
    }

    private fun rime(t: String): String {
        val c = canon(t)
        var i = 0
        while (i < c.length && c[i] !in "aeiouv") i++
        return c.substring(i)
    }

    /** 兩個音節的差異：0 完全相同，1 完全不同。 */
    fun subCost(a: String, b: String): Double {
        if (a == b) return 0.0
        val la = a.startsWith("@")
        val lb = b.startsWith("@")
        if (la || lb) {
            if (la != lb) return 1.0
            val d = levenshtein(a, b)
            return if (d * 4 <= maxOf(a.length, b.length) - 1) 0.4 else 1.0
        }
        if (canon(a) == canon(b)) return 0.25
        val ra = rime(a)
        if (ra.isNotEmpty() && ra == rime(b)) return 0.6
        return 1.0
    }

    private fun levenshtein(a: String, b: String): Int {
        var prev = IntArray(b.length + 1) { it }
        for (i in 1..a.length) {
            val cur = IntArray(b.length + 1)
            cur[0] = i
            for (j in 1..b.length) {
                cur[j] = minOf(
                    prev[j] + 1,
                    cur[j - 1] + 1,
                    prev[j - 1] + if (a[i - 1] == b[j - 1]) 0 else 1,
                )
            }
            prev = cur
        }
        return prev[b.length]
    }

    data class Found(val cost: Double, val start: Int, val end: Int)

    /** 在 text 裡找出最像 pattern 的一段（允許聽錯字、漏字、贅字）。 */
    fun find(pattern: List<String>, text: List<String>): Found? {
        val m = pattern.size
        val n = text.size
        if (m == 0) return null
        var prevCost = DoubleArray(n + 1)
        var prevStart = IntArray(n + 1) { it }
        for (i in 1..m) {
            val curCost = DoubleArray(n + 1)
            val curStart = IntArray(n + 1)
            curCost[0] = i.toDouble()
            curStart[0] = 0
            for (j in 1..n) {
                val sub = prevCost[j - 1] + subCost(pattern[i - 1], text[j - 1])
                val missing = prevCost[j] + 1.0
                val extra = curCost[j - 1] + GAP_COST
                when {
                    sub <= missing && sub <= extra -> { curCost[j] = sub; curStart[j] = prevStart[j - 1] }
                    missing <= extra -> { curCost[j] = missing; curStart[j] = prevStart[j] }
                    else -> { curCost[j] = extra; curStart[j] = curStart[j - 1] }
                }
            }
            prevCost = curCost
            prevStart = curStart
        }
        var best = 0
        for (j in 1..n) if (prevCost[j] < prevCost[best]) best = j
        return Found(prevCost[best], prevStart[best], best)
    }

    /** 0~1，1 表示完全吻合。兩個字以下的短詞要求讀音幾乎一致，避免亂配。 */
    fun score(pattern: List<String>, text: List<String>): Double {
        val f = find(pattern, text) ?: return 0.0
        if (pattern.size <= 2 && f.cost > 0.25) return 0.0
        return (1.0 - f.cost / pattern.size).coerceIn(0.0, 1.0)
    }
}
