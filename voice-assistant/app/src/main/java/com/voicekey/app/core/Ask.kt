package com.voicekey.app.core

/** 問答的純邏輯：哪些話算是「在問問題」、給 AI 的說明、把回答整理成適合唸出來的樣子。 */
object Ask {
    /** 一開頭就這樣講＝擺明要查資料，不用再去比對指令。 */
    private val DIRECT = listOf("請問", "問一下", "我想問", "幫我查", "幫我找", "幫我搜尋", "查一下", "上網查", "搜尋一下", "搜尋")

    /** 句子裡有這些字，多半是問題而不是指令。 */
    private val MARKS = listOf(
        "多少", "什麼", "甚麼", "為什麼", "怎麼", "怎樣", "如何", "幾點", "幾號", "幾歲", "幾度", "是誰", "哪裡", "哪一", "哪個",
        "嗎", "天氣", "價格", "價錢", "匯率", "股價", "新聞", "意思",
    )

    fun direct(text: String): Boolean {
        val t = text.trim()
        return DIRECT.any { t.startsWith(it) }
    }

    fun looksLikeQuestion(text: String): Boolean {
        val t = text.trim()
        return t.length >= 4 && (direct(t) || MARKS.any { t.contains(it) } || t.endsWith("?") || t.endsWith("？"))
    }

    /** 給 AI 的說明。today 例如「2026-11-24（星期二）」。 */
    fun system(today: String): String =
        "你是裝在使用者手機裡的語音助理，使用者人在台灣，用說的問你問題，你的回答會被語音唸出來。\n" +
            "今天是 $today（台灣時間）。\n" +
            "需要最新資訊（價格、匯率、天氣、新聞、營業時間等）就用網路搜尋查證，不要憑印象回答。\n" +
            "回答規則：\n" +
            "- 用台灣習慣的繁體中文、口語、直接講結論；一到三句話，最多大約八十個字。\n" +
            "- 有數字就講出數字和單位，並說明是哪一天、哪個來源的數字（例如「台灣銀行今天的牌告」）。台灣常用的單位請換算好（例如黃金一錢是 3.75 公克）。\n" +
            "- 不要用條列、表格、粗體、連結或任何符號標記；不要寒暄，不要反問，不要說「根據搜尋結果」。\n" +
            "- 查不到或不確定就老實說查不到，不要猜。"

    private val LINK = Regex("\\[([^\\]]*)]\\((?:[^)]*)\\)")
    private val URL = Regex("https?://\\S+")
    private val MARKUP = Regex("[*_`#>|]+")
    private val BULLET = Regex("(?m)^\\s*(?:[-•]|\\d+[.)、])\\s*")
    private val SPACES = Regex("[ \\t]+")
    private val BLANK_LINES = Regex("\\n{2,}")

    /** 把回答裡的 Markdown 記號、網址拿掉，畫面比較乾淨，唸出來也不會唸到「星號星號」。 */
    fun clean(answer: String): String {
        var t = LINK.replace(answer) { it.groupValues[1] }
        t = URL.replace(t, "")
        t = BULLET.replace(t, "")
        t = MARKUP.replace(t, "")
        t = SPACES.replace(t, " ")
        t = BLANK_LINES.replace(t, "\n")
        return t.trim()
    }
}
