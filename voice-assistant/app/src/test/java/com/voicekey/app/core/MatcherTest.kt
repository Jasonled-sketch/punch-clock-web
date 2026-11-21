package com.voicekey.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MatcherTest {
    private val gate = Command(
        id = "gate", name = "開公司鐵門",
        triggers = listOf("開鐵門", "開啟公司鐵門", "打開鐵門", "開公司鐵門"),
        type = ActionType.WEBHOOK, target = "https://example.invalid/x",
        protection = Protection.PASSWORD, requireUnlock = true,
    )
    private val guan = Contact("1", "小關", listOf("關先生"), "小關", "0912345678", Channel.LINE)
    private val wang = Contact("2", "王大明", listOf("大明"), "王大明", "", Channel.LINE)
    private val chen = Contact("3", "陳會計", emptyList(), "", "0223456789", Channel.LINE)
    private val config = Config(listOf(gate), listOf(guan, wang, chen))
    private val apps = listOf(
        AppEntry("LINE", "jp.naver.line.android"),
        AppEntry("YouTube", "com.google.android.youtube"),
        AppEntry("相機", "com.sec.android.app.camera"),
        AppEntry("地圖", "com.google.android.apps.maps"),
    )

    private fun m(vararg heard: String) = Matcher.match(heard.toList(), config, apps)

    @Test fun gateExact() {
        val r = m("開啟公司鐵門")
        assertEquals(gate, (r.parsed as Parsed.Run).command)
        assertTrue(r.score >= Matcher.EXECUTE)
    }

    @Test fun gateHomophone() {
        // 語音辨識把「鐵門」聽成同音字
        val r = m("開帖們")
        assertEquals(gate, (r.parsed as Parsed.Run).command)
        assertTrue(r.score >= Matcher.EXECUTE)
    }

    @Test fun gateWithFiller() {
        val r = m("幫我開一下鐵門")
        assertEquals(gate, (r.parsed as Parsed.Run).command)
        assertTrue(r.score >= Matcher.ASK)
    }

    @Test fun lineCallHomophoneName() {
        val r = m("用賴打給小觀")
        val call = r.parsed as Parsed.Call
        assertEquals(guan, call.contact)
        assertEquals(Channel.LINE, call.channel)
        assertTrue(r.score >= Matcher.EXECUTE)
    }

    @Test fun defaultChannelIsLine() {
        val call = m("打給王大明").parsed as Parsed.Call
        assertEquals(wang, call.contact)
        assertEquals(Channel.LINE, call.channel)
    }

    @Test fun phoneKeywordPicksPhone() {
        val call = m("打電話給小關").parsed as Parsed.Call
        assertEquals(Channel.PHONE, call.channel)
    }

    @Test fun fallsBackWhenNoLineName() {
        val call = m("打給陳會計").parsed as Parsed.Call
        assertEquals(chen, call.contact)
        assertEquals(Channel.PHONE, call.channel)
    }

    @Test fun aliasWorks() {
        val call = m("LINE 打給大明").parsed as Parsed.Call
        assertEquals(wang, call.contact)
    }

    @Test fun secondCandidateRescues() {
        val r = m("今天天氣很好", "打給小關")
        assertEquals(guan, (r.parsed as Parsed.Call).contact)
    }

    @Test fun unknownContact() {
        val r = m("打給林志玲")
        assertTrue(r.parsed is Parsed.Unknown)
    }

    @Test fun unrelatedSentence() {
        assertTrue(m("今天天氣很好").parsed is Parsed.Unknown)
        assertTrue(m("明天開會").parsed is Parsed.Unknown)
    }

    @Test fun openApps() {
        assertEquals("com.google.android.youtube", (m("打開 YouTube").parsed as Parsed.Open).app.pkg)
        assertEquals("jp.naver.line.android", (m("打開賴").parsed as Parsed.Open).app.pkg)
        assertEquals("com.sec.android.app.camera", (m("開啟相機").parsed as Parsed.Open).app.pkg)
    }

    @Test fun gateBeatsOpenApp() {
        assertTrue(m("打開鐵門").parsed is Parsed.Run)
    }

    @Test fun yesNo() {
        assertTrue(Spoken.isYes(listOf("確定")))
        assertTrue(Spoken.isYes(listOf("缺定")))
        assertTrue(Spoken.isYes(listOf("對")))
        assertFalse(Spoken.isYes(listOf("不要")))
        assertFalse(Spoken.isYes(listOf("不是")))
        assertFalse(Spoken.isYes(listOf("取消")))
        assertFalse(Spoken.isYes(listOf("嗯")))
    }

    @Test fun password() {
        assertTrue(Spoken.secretMatches(listOf("1234"), "1234"))
        assertTrue(Spoken.secretMatches(listOf("一二三四"), "1234"))
        assertTrue(Spoken.secretMatches(listOf("1 2 3 4"), "1234"))
        assertTrue(Spoken.secretMatches(listOf("密碼是1234"), "1234"))
        assertTrue(Spoken.secretMatches(listOf("衣二三四"), "1234"))
        assertTrue(Spoken.secretMatches(listOf("聽錯了", "1234"), "1234"))
        assertFalse(Spoken.secretMatches(listOf("1235"), "1234"))
        assertFalse(Spoken.secretMatches(listOf("12345"), "1234"))
        assertFalse(Spoken.secretMatches(listOf("123"), "1234"))
        assertFalse(Spoken.secretMatches(listOf("確定"), "1234"))
        assertFalse(Spoken.secretMatches(listOf("1234"), ""))
        assertTrue(Spoken.secretMatches(listOf("芝麻開門"), "芝麻開門"))
        assertFalse(Spoken.secretMatches(listOf("西瓜開門"), "芝麻開門"))
    }
}
