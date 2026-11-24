package com.voicekey.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.ServerSocket

class SttTest {
    @Test fun wavHeader() {
        val wav = Wav.wrap(ByteArray(3200), 16000)
        assertEquals(44 + 3200, wav.size)
        assertEquals("RIFF", String(wav, 0, 4))
        assertEquals("WAVE", String(wav, 8, 4))
        assertEquals("data", String(wav, 36, 4))
        // 取樣率 16000＝0x3E80，小端序
        assertEquals(0x80, wav[24].toInt() and 0xff)
        assertEquals(0x3E, wav[25].toInt() and 0xff)
        // 資料長度
        assertEquals(3200, (wav[40].toInt() and 0xff) or ((wav[41].toInt() and 0xff) shl 8))
    }

    @Test fun rmsOfSilenceAndTone() {
        assertEquals(0.0, Wav.rms(ByteArray(640), 640), 0.001)
        val loud = ByteArray(640) { i -> if (i % 2 == 0) 0x00 else 0x20 }   // 每個取樣 0x2000＝8192
        assertEquals(8192.0, Wav.rms(loud, 640), 1.0)
    }

    private fun run(vad: Vad, vararg segments: Pair<Int, Double>): Vad.State {
        var st = Vad.State.WAITING
        for ((n, level) in segments) repeat(n) { st = vad.feed(level) }
        return st
    }

    @Test fun vadEndsAfterSpeechThenSilence() {
        val v = Vad()
        assertEquals(Vad.State.SPEAKING, run(v, 10 to 100.0, 20 to 5000.0))
        assertTrue(v.spoke)
        assertEquals(Vad.State.SPEAKING, run(v, 30 to 100.0))   // 停頓 0.6 秒還不算講完
        assertEquals(Vad.State.SPEAKING, run(v, 5 to 5000.0))   // 又繼續講
        assertEquals(Vad.State.ENDED, run(v, 45 to 100.0))      // 安靜 0.9 秒＝講完
    }

    @Test fun vadGivesUpWhenNobodySpeaks() {
        val v = Vad()
        assertEquals(Vad.State.TIMEOUT, run(v, 300 to 120.0))
        assertFalse(v.spoke)
    }

    @Test fun vadIgnoresSteadyNoiseAndShortClicks() {
        val v = Vad()
        // 環境本來就吵（車上）：同樣的音量不算人聲
        assertEquals(Vad.State.WAITING, run(v, 10 to 1500.0, 50 to 1600.0))
        // 一兩格的碰撞聲不算開始講
        assertEquals(Vad.State.WAITING, run(v, 2 to 9000.0, 5 to 1500.0))
        assertFalse(v.spoke)
        assertEquals(Vad.State.SPEAKING, run(v, 4 to 9000.0))
    }

    @Test fun jsonStringField() {
        assertEquals("開鐵門", JsonLite.stringField("""{"text":"開鐵門","usage":{"x":1}}""", "text"))
        assertEquals("他說\"好\"\n第二行", JsonLite.stringField("""{ "text" : "他說\"好\"\n第二行" }""", "text"))
        assertEquals("導航", JsonLite.stringField("""{"text":"導航"}""", "text"))
        assertEquals(null, JsonLite.stringField("""{"error":{"message":"bad"}}""", "text"))
        assertEquals("", JsonLite.stringField("""{"text":""}""", "text"))
    }

    @Test fun promptCarriesVocabulary() {
        val p = OpenAiStt.promptOf(listOf("小關", " 岡山倉庫 ", "", "小關", "開鐵門"))
        assertTrue(p.startsWith("以下是台灣繁體中文的語音指令。"))
        assertTrue(p.contains("常用詞：小關、岡山倉庫、開鐵門。"))
        assertEquals("以下是台灣繁體中文的語音指令。", OpenAiStt.promptOf(emptyList()))
    }

    /** 一次只回一種答案的小型假伺服器（安卓的單元測試環境沒有 JDK 內建的 HttpServer） */
    private class Fake(val status: Int, val reply: String) {
        @Volatile var auth = ""
        @Volatile var contentType = ""
        @Volatile var body = ByteArray(0)
        private val socket = ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))
        private val thread = Thread {
            try {
                while (true) {
                    socket.accept().use { c ->
                        val input = c.getInputStream()
                        val head = ByteArrayOutputStream()
                        while (true) {
                            val b = input.read(); if (b < 0) break
                            head.write(b)
                            val h = head.toByteArray(); val n = h.size
                            if (n >= 4 && h[n - 4] == 13.toByte() && h[n - 3] == 10.toByte() && h[n - 2] == 13.toByte() && h[n - 1] == 10.toByte()) break
                        }
                        val lines = head.toString("ISO-8859-1").split("\r\n")
                        fun header(name: String) = lines.firstOrNull { it.startsWith("$name:", ignoreCase = true) }?.substringAfter(':')?.trim().orEmpty()
                        auth = header("Authorization"); contentType = header("Content-Type")
                        val len = header("Content-Length").toIntOrNull() ?: 0
                        val data = ByteArray(len); var got = 0
                        while (got < len) { val r = input.read(data, got, len - got); if (r < 0) break; got += r }
                        body = data
                        val out = reply.toByteArray()
                        c.getOutputStream().apply {
                            write("HTTP/1.1 $status X\r\nContent-Type: application/json\r\nContent-Length: ${out.size}\r\nConnection: close\r\n\r\n".toByteArray())
                            write(out); flush()
                        }
                    }
                }
            } catch (e: Exception) { /* 關掉了 */ }
        }.apply { isDaemon = true; start() }
        val url get() = "http://127.0.0.1:${socket.localPort}/v1/audio/transcriptions"
        fun stop() { runCatching { socket.close() } }
    }

    @Test fun transcribeSendsAudioAndReadsText() {
        val f = Fake(200, """{"text":" 導航到大內二溪朝天宮 ","usage":{"input_tokens":50}}""")
        try {
            val wav = Wav.wrap(ByteArray(3200) { 7 }, 16000)
            val r = OpenAiStt.transcribe("sk-test-key", wav, OpenAiStt.promptOf(listOf("朝天宮")), endpoint = f.url)
            assertEquals("導航到大內二溪朝天宮", r.text)
            assertEquals("", r.error)
            assertEquals("Bearer sk-test-key", f.auth)
            assertTrue(f.contentType.startsWith("multipart/form-data; boundary="))
            val sent = String(f.body, Charsets.ISO_8859_1)
            val utf8 = String(f.body, Charsets.UTF_8)
            assertTrue(sent.contains("name=\"model\"\r\n\r\ngpt-4o-transcribe\r\n"))
            assertTrue(sent.contains("name=\"language\"\r\n\r\nzh\r\n"))
            assertTrue(sent.contains("name=\"temperature\"\r\n\r\n0\r\n"))
            assertTrue(utf8.contains("常用詞：朝天宮。"))
            assertTrue(sent.contains("filename=\"speech.wav\"\r\nContent-Type: audio/wav\r\n\r\nRIFF"))
            assertTrue(sent.trimEnd().endsWith("--"))
        } finally { f.stop() }
    }

    @Test fun transcribeErrorsAreReadable() {
        for ((code, msg) in listOf(401 to "OpenAI 金鑰不對或已失效", 429 to "OpenAI 額度用完了或用太快", 500 to "雲端語音辨識失敗（500）")) {
            val f = Fake(code, """{"error":{"message":"sk-test-key leaked?"}}""")
            try {
                val r = OpenAiStt.transcribe("sk-test-key", Wav.wrap(ByteArray(320), 16000), "", endpoint = f.url)
                assertEquals("", r.text)
                assertEquals(msg, r.error)
                assertFalse("錯誤訊息不能帶出金鑰", r.error.contains("sk-test-key"))
            } finally { f.stop() }
        }
        val dead = OpenAiStt.transcribe("k", Wav.wrap(ByteArray(320), 16000), "", endpoint = "http://127.0.0.1:1/x", timeoutMs = 2000)
        assertEquals("連不上雲端語音辨識", dead.error)
    }

    @Test fun checkKey() {
        val ok = Fake(200, "{}")
        try { assertEquals("", OpenAiStt.checkKey("sk-good", url = ok.url)); assertEquals("Bearer sk-good", ok.auth) } finally { ok.stop() }
        val bad = Fake(401, "{}")
        try { assertEquals("OpenAI 金鑰不對或已失效", OpenAiStt.checkKey("sk-bad", url = bad.url)) } finally { bad.stop() }
    }

    // ── 記住你的說法 ──
    private val gate = Command("g", "開公司鐵門", listOf("開鐵門"), ActionType.WEBHOOK, "http://x", protection = Protection.PASSWORD)
    private val guan = Contact("c1", "小關", emptyList(), "小關", "0912", Channel.LINE)
    private val config = Config(listOf(gate), listOf(guan))

    @Test fun learnedPhraseRunsDirectly() {
        val heard = "把那個大門弄開"
        assertTrue(Matcher.match(listOf(heard), config, emptyList()).parsed is Parsed.Unknown)
        val learned = mapOf(Matcher.phraseKey(heard) to Matcher.targetOf(Parsed.Run(gate)))
        val r = Matcher.match(listOf(heard), config, emptyList(), learned)
        assertEquals(gate, (r.parsed as Parsed.Run).command)
        assertEquals(1.0, r.score, 0.0)
        // 同音字、捲舌不捲舌聽成別的字也算同一句
        assertEquals(gate, (Matcher.match(listOf("把那個大們弄開"), config, emptyList(), learned).parsed as Parsed.Run).command)
        // 沒學過的句子不受影響
        assertTrue(Matcher.match(listOf("把那個窗戶弄開"), config, emptyList(), learned).parsed is Parsed.Unknown)
    }

    @Test fun learnedTargets() {
        assertEquals("cmd:g", Matcher.targetOf(Parsed.Run(gate)))
        assertEquals("line:c1", Matcher.targetOf(Parsed.Call(guan, Channel.LINE)))
        assertEquals("phone:c1", Matcher.targetOf(Parsed.Call(guan, Channel.PHONE)))
        assertEquals("", Matcher.targetOf(Parsed.Navigate("公司", null, "公司", "d")))
        val learned = mapOf(Matcher.phraseKey("找一下阿關") to "phone:c1", Matcher.phraseKey("舊的指令") to "cmd:deleted")
        val call = Matcher.match(listOf("找一下阿關"), config, emptyList(), learned).parsed as Parsed.Call
        assertEquals(Channel.PHONE, call.channel)
        // 指令後來被刪掉：記住的說法失效，不會亂做
        assertTrue(Matcher.match(listOf("舊的指令"), config, emptyList(), learned).parsed is Parsed.Unknown)
    }
}
