package com.voicekey.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** JSON 樣本都是真的引擎（Vosk 中文小模型）對一段真人錄音吐出來的格式。 */
class WakeTest {
    @Test fun phrasesAreCleaned() {
        assertEquals(listOf("小幫手"), Wake.phrases("小幫手"))
        assertEquals(listOf("小幫手", "阿福管家"), Wake.phrases("小幫手、阿福管家"))
        assertEquals(listOf("小幫手"), Wake.phrases(" 小幫手 ，"))
        assertEquals(listOf("小幫手"), Wake.phrases("小幫手、小幫手"))
        assertEquals(emptyList<String>(), Wake.phrases("嘿"))
        assertEquals(emptyList<String>(), Wake.phrases(""))
        assertEquals(3, Wake.phrases("一二三、四五六、七八九、十一十二").size)
    }

    @Test fun problemsAreExplained() {
        assertEquals("", Wake.problem("小幫手"))
        assertEquals("", Wake.problem("小幫手、阿福管家"))
        assertTrue(Wake.problem("").contains("請打"))
        assertTrue(Wake.problem("Hey 小幫手").contains("只能用中文字"))
        assertTrue(Wake.problem("小幫手2號").contains("只能用中文字"))
        assertTrue(Wake.problem("嘿").contains("至少"))
        assertTrue(Wake.problem("一二三四五六七").contains("最多"))
        assertTrue(Wake.problem("一二、三四、五六、七八").contains("最多設"))
    }

    @Test fun grammarSpellsEachCharacterAndAlwaysHasUnk() {
        assertEquals("[\"小 帮 手\", \"[unk]\"]", Wake.grammar(listOf("小帮手")))
        assertEquals("[\"小 帮 手\", \"管 家\", \"[unk]\"]", Wake.grammar(listOf("小帮手", "管家")))
    }

    @Test fun wholePhraseHits() {
        val final = """{ "result" : [{ "conf" : 1.000000, "end" : 1.33, "start" : 0.45, "word" : "[unk]" }, { "conf" : 1.0, "end" : 1.71, "start" : 1.41, "word" : "房" }, { "conf" : 1.0, "end" : 1.86, "start" : 1.71, "word" : "地" }, { "conf" : 1.0, "end" : 2.22, "start" : 1.86, "word" : "产" }], "text" : "[unk] 房 地 产 [unk]" }"""
        assertTrue(Wake.hit(final, listOf("房地产")))
        assertEquals("[unk]房地产[unk]", Wake.heard(final))
        assertTrue(Wake.hit("""{ "partial" : "[unk] 房 地 产" }""", listOf("房地产")))
        assertTrue(Wake.hit("""{ "text" : "房 地 产" }""", listOf("小帮手", "房地产")))
    }

    @Test fun partialOrBrokenPhraseDoesNotHit() {
        // 真的引擎行為：喚醒詞設「黄地产」、實際講「房地产」→ 只認到後兩個字
        assertFalse(Wake.hit("""{ "text" : "[unk] 地 产 [unk]" }""", listOf("黄地产")))
        // 中間夾了別的聲音
        assertFalse(Wake.hit("""{ "text" : "小 [unk] 帮 手" }""", listOf("小帮手")))
        // 完全沒講
        assertFalse(Wake.hit("""{ "result" : [{ "conf" : 1.0, "end" : 3.75, "start" : 0.67, "word" : "[unk]" }], "text" : "[unk]" }""", listOf("小帮手")))
        assertFalse(Wake.hit("""{ "text" : "" }""", listOf("小帮手")))
        assertFalse(Wake.hit("""{ "partial" : "" }""", listOf("小帮手")))
        assertFalse(Wake.hit("""{ "text" : "小 帮 手" }""", emptyList()))
    }

    @Test fun quietHours() {
        // 0:00～7:00（Jason 舉的例子）
        assertTrue(Wake.inQuiet(0, 0, 420))
        assertTrue(Wake.inQuiet(419, 0, 420))
        assertFalse(Wake.inQuiet(420, 0, 420))
        assertFalse(Wake.inQuiet(23 * 60 + 59, 0, 420))
        // 跨過半夜：23:00～07:00
        assertTrue(Wake.inQuiet(23 * 60, 23 * 60, 420))
        assertTrue(Wake.inQuiet(30, 23 * 60, 420))
        assertFalse(Wake.inQuiet(12 * 60, 23 * 60, 420))
        assertFalse(Wake.inQuiet(22 * 60 + 59, 23 * 60, 420))
        // 起訖一樣＝沒有休息時段
        assertFalse(Wake.inQuiet(100, 300, 300))
        assertEquals("00:00", Wake.clock(0))
        assertEquals("07:00", Wake.clock(420))
        assertEquals("23:30", Wake.clock(23 * 60 + 30))
    }
}
