package com.voicekey.app.core

/** 呼喊喚醒的純邏輯：喚醒詞整理、給辨識引擎的「只聽這幾個詞」清單、判斷有沒有喊到。 */
object Wake {
    const val MAX_PHRASES = 3
    const val MIN_LEN = 2
    const val MAX_LEN = 6

    private fun isHan(c: Char) = c in '一'..'鿿'

    /** 使用者打的喚醒詞（可以用、或逗號分開打好幾個）→ 乾淨的清單：只留中文字，每個 2～6 個字，最多 3 個。 */
    fun phrases(raw: String): List<String> =
        raw.split('、', ',', '，', ' ', '　', '\n', ';', '；')
            .map { p -> p.filter(::isHan) }
            .filter { it.length in MIN_LEN..MAX_LEN }
            .distinct()
            .take(MAX_PHRASES)

    /** 打的東西哪裡不合：空字串＝可以用。 */
    fun problem(raw: String): String {
        val parts = raw.split('、', ',', '，', ' ', '　', '\n', ';', '；').map { it.trim() }.filter { it.isNotEmpty() }
        return when {
            parts.isEmpty() -> "請打想喊的詞，例如「小幫手」"
            parts.any { p -> p.any { !isHan(it) } } -> "喚醒詞只能用中文字（不要英文、數字、符號）"
            parts.any { it.length < MIN_LEN } -> "喚醒詞至少要 $MIN_LEN 個字，建議 3～4 個字"
            parts.any { it.length > MAX_LEN } -> "喚醒詞最多 $MAX_LEN 個字"
            parts.size > MAX_PHRASES -> "最多設 $MAX_PHRASES 個喚醒詞"
            else -> ""
        }
    }

    /**
     * 給辨識引擎的清單（JSON 陣列）：每個喚醒詞拆成一個字一個字，再加上 [unk]（其他所有聲音都歸到這裡）。
     * 一定要有 [unk]：沒有它，引擎會把任何聲音硬湊成清單裡的字，隨便講話都會誤觸。
     */
    fun grammar(simplified: List<String>): String =
        (simplified.map { p -> "\"" + p.toList().joinToString(" ") + "\"" } + "\"[unk]\"").joinToString(", ", "[", "]")

    /** 引擎回來的 JSON（結果或進行中的結果）裡聽到的字；[unk] 保留，拿掉空白。 */
    fun heard(json: String): String =
        (JsonLite.stringField(json, "text") ?: JsonLite.stringField(json, "partial") ?: "").replace(" ", "")

    /**
     * 有沒有喊到：喚醒詞要「完整、連續」出現才算。
     * 引擎可能只聽到其中一兩個字（「帮手」），或中間夾了別的聲音（「小[unk]帮手」），那都不算。
     */
    fun hit(json: String, simplified: List<String>): Boolean {
        val h = heard(json)
        return h.isNotEmpty() && simplified.any { it.isNotEmpty() && h.contains(it) }
    }

    /**
     * 現在是不是在「休息時段」裡。時間都用「從 0 點起算的分鐘數」（7:30 → 450）。
     * 起訖一樣＝沒有休息時段；起比訖晚＝跨過半夜（23:00～07:00）。到訖的那一分鐘就算結束。
     */
    fun inQuiet(nowMin: Int, startMin: Int, endMin: Int): Boolean = when {
        startMin == endMin -> false
        startMin < endMin -> nowMin in startMin until endMin
        else -> nowMin >= startMin || nowMin < endMin
    }

    fun clock(min: Int): String = "%02d:%02d".format((min / 60) % 24, min % 60)
}
