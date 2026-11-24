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
    private val ruru = Contact("4", "陳如如", emptyList(), "陳如如", "", Channel.LINE)
    private val office = Place("p1", "公司", listOf("A館"), "22.6273,120.3014")
    private val home = Place("p2", "家", emptyList(), "")
    private val config = Config(listOf(gate), listOf(guan, wang, chen, ruru), listOf(office, home))
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

    @Test fun lineCallWordOrder() {
        val call = m("打LINE給陳如如").parsed as Parsed.Call
        assertEquals(ruru, call.contact)
        assertEquals(Channel.LINE, call.channel)
    }

    private fun nav(s: String) = m(s).parsed as Parsed.Navigate

    @Test fun navigateSavedPlace() {
        val n = nav("開啟地圖導航回公司")
        assertEquals(office, n.place)
        assertEquals("22.6273,120.3014", n.query)
        assertEquals("d", n.mode)
        assertEquals(office, nav("導航到公司").place)
        assertEquals(office, nav("帶我回公司").place)
        assertEquals(office, nav("導航去A館").place)
    }

    @Test fun navigateFreeText() {
        val n = nav("導航到高雄車站")
        assertEquals(null, n.place)
        assertEquals("高雄車站", n.query)
        assertEquals("高雄車站", nav("到高雄車站怎麼走").query)
        assertEquals("w", nav("走路導航到捷運站").mode)
        assertEquals("l", nav("騎車導航回公司").mode)
    }

    @Test fun navigateNoDestinationOpensMaps() {
        assertEquals("", nav("打開導航").label)
    }

    @Test fun placeWithoutAddressStillMatches() {
        val n = nav("導航回家")
        assertEquals(home, n.place)
    }

    @Test fun openMapsStillOpensApp() {
        assertTrue(m("打開地圖").parsed is Parsed.Open)
    }

    @Test fun lineNameNormalize() {
        assertEquals(Names.norm("陳如如"), Names.norm("陳 如如 🌸"))
        assertEquals(Names.norm("Ruru Chen"), Names.norm("ｒｕｒｕ　chen"))
        assertTrue(Names.norm("陳如如") != Names.norm("陳如如的老公"))
    }

    @Test fun navigateUnsavedPlaces() {
        assertEquals("大內二溪朝天宮", nav("導航到大內二溪朝天宮").query)
        assertEquals("台東金樽安檢所", nav("導航去台東金樽安檢所").query)
        assertEquals("台東金樽安檢所", nav("帶我去台東金樽安檢所").query)
        assertEquals("大內二溪朝天宮", nav("開啟地圖導航到大內二溪朝天宮").query)
    }

    @Test fun gateWithPasswordInOneSentence() {
        val r = m("開鐵門1234")
        assertEquals(gate, (r.parsed as Parsed.Run).command)
        assertTrue(r.score >= Matcher.EXECUTE)
        assertTrue(m("開啟公司鐵門一二三四").score >= Matcher.EXECUTE)
    }

    @Test fun inlineSecret() {
        assertEquals(Spoken.Inline.MATCH, Spoken.inlineSecret(listOf("開鐵門1234"), "1234"))
        assertEquals(Spoken.Inline.MATCH, Spoken.inlineSecret(listOf("開鐵門一二三四"), "1234"))
        assertEquals(Spoken.Inline.MATCH, Spoken.inlineSecret(listOf("開鐵門 密碼 1 2 3 4"), "1234"))
        assertEquals(Spoken.Inline.MATCH, Spoken.inlineSecret(listOf("聽錯", "開鐵門1234"), "1234"))
        assertEquals(Spoken.Inline.NONE, Spoken.inlineSecret(listOf("開鐵門"), "1234"))
        assertEquals(Spoken.Inline.NONE, Spoken.inlineSecret(listOf("開一下鐵門"), "1234"))
        assertEquals(Spoken.Inline.WRONG, Spoken.inlineSecret(listOf("開鐵門9999"), "1234"))
        assertEquals(Spoken.Inline.WRONG, Spoken.inlineSecret(listOf("開鐵門12345"), "1234"))
        assertEquals(Spoken.Inline.NONE, Spoken.inlineSecret(listOf("開鐵門1234"), ""))
    }

    @Test fun redactHidesPassword() {
        assertEquals("開鐵門●●●●", Spoken.redact("開鐵門1234", "1234"))
        assertEquals("開鐵門●●●●", Spoken.redact("開鐵門一二三四", "1234"))
        assertEquals("開鐵門", Spoken.redact("開鐵門", "1234"))
        assertEquals("開一下鐵門", Spoken.redact("開一下鐵門", "1234"))
        assertEquals("開鐵門●●●●", Spoken.redact("開鐵門芝麻開門", "芝麻開門"))
    }

    @Test fun unclearAnswerIsNeitherYesNorNo() {
        assertFalse(Spoken.isYes(listOf("關閉")))
        assertFalse(Spoken.isNo(listOf("關閉")))
        assertTrue(Spoken.isYes(listOf("好的")))
        assertTrue(Spoken.isYes(listOf("沒問題")))
        assertTrue(Spoken.isYes(listOf("OK")))
    }

    private fun sch(s: String) = m(s).parsed as Parsed.Schedule

    @Test fun scheduleFromScreen() {
        assertEquals("", sch("幫我登記行程").detail)
        assertEquals("個人", sch("幫我登記行程 個人").calendar)
        assertEquals("", sch("幫我登記行程 個人").detail)
        assertEquals("公司", sch("登記行程，公司").calendar)
        assertEquals("公司", sch("把這個登記到公司行事曆").calendar)
        assertEquals("", sch("把這個登記到公司行事曆").detail)
        assertEquals("個人", sch("幫我加到我的行事曆").calendar)
    }

    @Test fun scheduleWithSpokenDetail() {
        val a = sch("登記行程，公司，明天下午三點去永康估價")
        assertEquals("公司", a.calendar)
        assertEquals("明天下午三點去永康估價", a.detail)
        assertEquals("後天早上九點岡山倉庫盤點", sch("幫我把後天早上九點岡山倉庫盤點登記到行事曆").detail)
        assertEquals("", sch("登記行程").calendar)
    }

    @Test fun openCalendarIsNotSchedule() {
        assertFalse(m("打開行事曆").parsed is Parsed.Schedule)
        assertFalse(m("今天行程很滿").parsed is Parsed.Schedule)
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
