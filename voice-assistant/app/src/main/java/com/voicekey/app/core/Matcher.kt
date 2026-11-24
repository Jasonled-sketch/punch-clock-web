package com.voicekey.app.core

sealed class Parsed {
    data class Run(val command: Command) : Parsed()
    data class Call(val contact: Contact, val channel: Channel) : Parsed()
    data class Open(val app: AppEntry) : Parsed()
    /** label 空白＝只打開地圖；place 有值＝設定頁存的地點；query 是交給地圖的目的地。 */
    /** detail 空白＝用當下畫面的截圖交給行事曆讀；有內容＝把這段話交給行事曆。calendar＝使用者說的「個人／公司」。 */
    data class Schedule(val detail: String, val calendar: String) : Parsed()
    /** 存到公司行事曆裡的知識庫：detail 空白＝存當下畫面的截圖；有內容＝存這段話。 */
    data class Keep(val detail: String) : Parsed()
    data class Navigate(val label: String, val place: Place?, val query: String, val mode: String) : Parsed()
    data class Unknown(val reason: String) : Parsed()
}

data class MatchResult(val parsed: Parsed, val score: Double, val heard: String)

/**
 * 封閉式比對：只在「你的指令 + 你的聯絡人 + 手機裡的 App」中挑最像的一個，
 * 所以比通用語音助理不容易聽錯。
 */
object Matcher {
    /** 這個分數以上直接執行。 */
    const val EXECUTE = 0.78
    /** 介於 ASK 與 EXECUTE 之間會先反問「你是說…嗎？」。 */
    const val ASK = 0.6

    private const val LINE_PKG = "jp.naver.line.android"
    private val OPEN_VERBS = listOf("打開", "開啟", "啟動", "進入", "開")
    private val PHONE_WORDS = listOf("電話", "手機", "市話")
    private val CALL_WORDS = listOf("打給", "撥給", "撥打", "打去", "聯絡", "連絡")

    fun match(candidates: List<String>, config: Config, apps: List<AppEntry>): MatchResult {
        var best: MatchResult? = null
        var bestAdjusted = -1.0
        candidates.forEachIndexed { i, text ->
            val r = matchOne(text, config, apps)
            if (r.parsed is Parsed.Unknown) return@forEachIndexed
            val adjusted = r.score - i * 0.02
            if (adjusted > bestAdjusted) { bestAdjusted = adjusted; best = r }
        }
        best?.let { return it }
        val first = candidates.firstOrNull().orEmpty()
        return matchOne(first, config, apps)
    }

    fun matchOne(text: String, config: Config, apps: List<AppEntry>): MatchResult {
        val toks = Phonetic.tokens(text)
        if (toks.isEmpty()) return MatchResult(Parsed.Unknown("沒有聽到內容"), 0.0, text)

        var best: Parsed? = null
        var bestScore = 0.0
        fun offer(p: Parsed, s: Double) {
            if (s > bestScore) { best = p; bestScore = s }
        }

        for (c in config.commands) {
            for (t in (c.triggers + c.name).distinct()) {
                val p = Phonetic.tokens(t)
                if (p.isEmpty()) continue
                val s = Phonetic.score(p, toks)
                if (s <= 0.0) continue
                val coverage = minOf(1.0, p.size.toDouble() / toks.size)
                offer(Parsed.Run(c), s * 0.9 + 0.1 * coverage)
            }
        }

        val lower = text.lowercase()
        val saysLine = lower.contains("賴") || toks.contains("@line") || toks.contains("lai")
        val saysPhone = PHONE_WORDS.any { text.contains(it) }
        val saysCall = saysLine || saysPhone || CALL_WORDS.any { text.contains(it) } ||
            toks.contains("da") || toks.contains("bo") || toks.contains("@call")

        var contactScore = 0.0
        var contactLen = 0
        var contact: Contact? = null
        for (c in config.contacts) {
            for (a in (c.aliases + c.name).distinct()) {
                val p = Phonetic.tokens(a)
                if (p.isEmpty()) continue
                val s = Phonetic.score(p, toks)
                if (s > contactScore || (s == contactScore && s > 0 && p.size > contactLen)) {
                    contactScore = s; contactLen = p.size; contact = c
                }
            }
        }
        val who = contact
        if (who != null && contactScore >= ASK) {
            val onlyName = toks.size <= contactLen + 1
            if (saysCall || onlyName) {
                offer(Parsed.Call(who, pickChannel(who, saysLine, saysPhone)), contactScore)
            }
        }

        Schedule.parse(text)?.let { ask -> offer(Parsed.Schedule(ask.detail, ask.calendar), 0.97) }
        Knowledge.parse(text)?.let { detail -> offer(Parsed.Keep(detail), 0.98) }

        Nav.parse(text)?.let { ask ->
            if (ask.dest.isEmpty()) {
                offer(Parsed.Navigate("", null, "", ask.mode), 0.9)
            } else {
                val destToks = Phonetic.tokens(ask.dest)
                var place: Place? = null
                var placeScore = 0.0
                for (p in config.places) {
                    for (a in (p.aliases + p.name).distinct()) {
                        val pt = Phonetic.tokens(a)
                        if (pt.isEmpty() || destToks.isEmpty()) continue
                        val s = Phonetic.score(pt, destToks)
                        val coverage = minOf(1.0, pt.size.toDouble() / destToks.size)
                        val adjusted = s * (0.7 + 0.3 * coverage)
                        if (adjusted > placeScore) { placeScore = adjusted; place = p }
                    }
                }
                val hit = place?.takeIf { placeScore >= 0.8 }
                offer(Parsed.Navigate(hit?.name ?: ask.dest, hit, hit?.address ?: ask.dest, ask.mode), 0.96)
            }
        }

        val verb = OPEN_VERBS.firstOrNull { text.contains(it) }
        if (verb != null) {
            val rest = Phonetic.tokens(text.substring(text.indexOf(verb) + verb.length))
            if (rest.isNotEmpty()) {
                for (app in apps) {
                    val names = if (app.pkg == LINE_PKG) listOf(app.label, "賴") else listOf(app.label)
                    for (name in names) {
                        val p = Phonetic.tokens(name)
                        if (p.isEmpty()) continue
                        val s = Phonetic.score(p, rest)
                        if (s <= 0.0) continue
                        val coverage = minOf(1.0, p.size.toDouble() / rest.size)
                        offer(Parsed.Open(app), (s * 0.85 + 0.15 * coverage) * 0.97)
                    }
                }
            }
        }

        best?.let { if (bestScore >= ASK) return MatchResult(it, minOf(bestScore, 1.0), text) }
        val reason = if (saysCall && CALL_WORDS.any { text.contains(it) }) "聯絡人清單裡找不到這個人" else ""
        return MatchResult(Parsed.Unknown(reason), 0.0, text)
    }

    private fun pickChannel(c: Contact, saysLine: Boolean, saysPhone: Boolean): Channel {
        val want = when {
            saysLine -> Channel.LINE
            saysPhone -> Channel.PHONE
            else -> c.defaultChannel
        }
        return when {
            want == Channel.LINE && c.lineName.isBlank() && c.phone.isNotBlank() -> Channel.PHONE
            want == Channel.PHONE && c.phone.isBlank() && c.lineName.isNotBlank() -> Channel.LINE
            else -> want
        }
    }

    fun describe(p: Parsed): String = when (p) {
        is Parsed.Run -> p.command.name
        is Parsed.Call -> if (p.channel == Channel.LINE) "用 LINE 打給${p.contact.name}" else "打電話給${p.contact.name}"
        is Parsed.Open -> "打開${p.app.label}"
        is Parsed.Schedule -> "登記行程"
        is Parsed.Keep -> "存到知識庫"
        is Parsed.Navigate -> if (p.label.isEmpty()) "打開地圖導航" else "導航到${p.label}"
        is Parsed.Unknown -> "聽不懂"
    }
}
