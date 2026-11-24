package com.voicekey.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AskTest {
    @Test fun questionsAreRecognized() {
        // Jason 11/24 實際問的那句
        assertTrue(Ask.looksLikeQuestion("找這周黃金的價格一錢多少元"))
        assertTrue(Ask.looksLikeQuestion("明天台南會下雨嗎"))
        assertTrue(Ask.looksLikeQuestion("美金匯率現在是多少"))
        assertTrue(Ask.looksLikeQuestion("幫我查台積電今天股價"))
        assertFalse(Ask.looksLikeQuestion("打開鐵門"))
        assertFalse(Ask.looksLikeQuestion("用賴打給陳如如"))
        assertFalse(Ask.looksLikeQuestion("嗎"))
    }

    @Test fun directPrefixes() {
        assertTrue(Ask.direct("請問現在油價"))
        assertTrue(Ask.direct(" 幫我查 明天的天氣"))
        assertTrue(Ask.direct("查一下高鐵時刻"))
        assertFalse(Ask.direct("打開鐵門"))
        assertFalse(Ask.direct("導航到高雄車站"))
    }

    @Test fun commandsStayCommands() {
        // 固定指令就算句尾帶「嗎」，比對分數夠高時仍然是指令（問答只接比對不到或沒把握的）
        val gate = Command("g", "開公司鐵門", listOf("開鐵門", "打開鐵門"), ActionType.WEBHOOK, "https://example.invalid/x")
        val r = Matcher.match(listOf("打開鐵門"), Config(listOf(gate), emptyList(), emptyList()), emptyList())
        assertTrue(r.score >= Matcher.EXECUTE)
        val q = Matcher.match(listOf("找這周黃金的價格一錢多少元"), Config(listOf(gate), emptyList(), emptyList()), emptyList())
        assertTrue(q.parsed is Parsed.Unknown || q.score < Matcher.EXECUTE)
    }

    @Test fun cleanStripsMarkup() {
        assertEquals("台灣銀行今天黃金一錢賣出約一萬五千元。", Ask.clean("**台灣銀行**今天黃金一錢賣出約一萬五千元。"))
        assertEquals("來源：台灣銀行", Ask.clean("來源：[台灣銀行](https://rate.bot.com.tw/gold)"))
        assertEquals("第一點\n第二點", Ask.clean("- 第一點\n\n\n2. 第二點"))
        assertEquals("看這裡", Ask.clean("看這裡 https://example.com/a?b=1"))
    }

    @Test fun systemPromptCarriesDate() {
        assertTrue(Ask.system("2026-11-24（星期二）").contains("2026-11-24（星期二）"))
    }
}
