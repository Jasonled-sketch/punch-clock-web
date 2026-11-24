package com.voicekey.app.core

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.sqrt

/** 16 位元 PCM 的小工具：包成 WAV、算音量。 */
object Wav {
    fun wrap(pcm: ByteArray, rate: Int): ByteArray {
        val out = ByteArrayOutputStream(44 + pcm.size)
        fun i32(v: Int) { out.write(v and 0xff); out.write((v shr 8) and 0xff); out.write((v shr 16) and 0xff); out.write((v shr 24) and 0xff) }
        fun i16(v: Int) { out.write(v and 0xff); out.write((v shr 8) and 0xff) }
        out.write("RIFF".toByteArray()); i32(36 + pcm.size); out.write("WAVE".toByteArray())
        out.write("fmt ".toByteArray()); i32(16); i16(1); i16(1); i32(rate); i32(rate * 2); i16(2); i16(16)
        out.write("data".toByteArray()); i32(pcm.size); out.write(pcm)
        return out.toByteArray()
    }

    fun rms(buf: ByteArray, len: Int): Double {
        var sum = 0.0
        var n = 0
        var i = 0
        while (i + 1 < len) {
            val s = (buf[i].toInt() and 0xff) or (buf[i + 1].toInt() shl 8)
            sum += s.toDouble() * s
            n++
            i += 2
        }
        return if (n == 0) 0.0 else sqrt(sum / n)
    }
}

/**
 * 很簡單的「講完了沒」判斷：一格 20 毫秒，餵音量進來。
 * 先用開頭一小段估環境噪音；音量明顯高過噪音連續幾格＝開始講；講過之後安靜夠久＝講完。
 */
class Vad(
    private val startFrames: Int = 3,
    private val endFrames: Int = 45,
    private val giveUpFrames: Int = 300,
    private val noiseFrames: Int = 10,
) {
    enum class State { WAITING, SPEAKING, ENDED, TIMEOUT }

    var spoke = false
        private set
    private var frames = 0
    private var noise = 0.0
    private var loud = 0
    private var quiet = 0

    fun feed(rms: Double): State {
        frames++
        if (frames <= noiseFrames) {
            noise = maxOf(noise, rms)
            return State.WAITING
        }
        val threshold = maxOf(500.0, noise * 2.5)
        val isLoud = rms > threshold
        if (!spoke) {
            loud = if (isLoud) loud + 1 else 0
            if (loud >= startFrames) { spoke = true; quiet = 0; return State.SPEAKING }
            return if (frames >= giveUpFrames) State.TIMEOUT else State.WAITING
        }
        quiet = if (isLoud) 0 else quiet + 1
        return if (quiet >= endFrames) State.ENDED else State.SPEAKING
    }
}

/** 只為了從回應裡拿出一個字串欄位，不想為此拉一個 JSON 函式庫進純 Kotlin 這層。 */
object JsonLite {
    fun stringField(json: String, name: String): String? {
        val key = "\"$name\""
        var i = json.indexOf(key)
        while (i >= 0) {
            var j = i + key.length
            while (j < json.length && json[j].isWhitespace()) j++
            if (j < json.length && json[j] == ':') {
                j++
                while (j < json.length && json[j].isWhitespace()) j++
                if (j < json.length && json[j] == '"') return readString(json, j + 1)
            }
            i = json.indexOf(key, i + 1)
        }
        return null
    }

    private fun readString(s: String, from: Int): String? {
        val sb = StringBuilder()
        var i = from
        while (i < s.length) {
            val c = s[i]
            when {
                c == '"' -> return sb.toString()
                c == '\\' && i + 1 < s.length -> {
                    i++
                    when (val e = s[i]) {
                        'n' -> sb.append('\n'); 't' -> sb.append('\t'); 'r' -> sb.append('\r')
                        'b' -> sb.append('\b'); 'f' -> sb.append('\u000c')
                        'u' -> { if (i + 4 < s.length) { sb.append(s.substring(i + 1, i + 5).toInt(16).toChar()); i += 4 } }
                        else -> sb.append(e)
                    }
                }
                else -> sb.append(c)
            }
            i++
        }
        return null
    }
}

/** 雲端語音轉文字（OpenAI）。跟公司行事曆「提醒代辦用講的」同一個模型與參數，聽到的結果才會一致。 */
object OpenAiStt {
    const val ENDPOINT = "https://api.openai.com/v1/audio/transcriptions"
    const val MODELS = "https://api.openai.com/v1/models"
    const val MODEL = "gpt-4o-transcribe"

    data class Result(val text: String, val error: String)

    fun transcribe(key: String, wav: ByteArray, prompt: String, endpoint: String = ENDPOINT, model: String = MODEL, timeoutMs: Int = 15000): Result {
        val boundary = "----voicekey" + System.nanoTime()
        val body = ByteArrayOutputStream(wav.size + 2048)
        fun field(name: String, value: String) {
            body.write("--$boundary\r\nContent-Disposition: form-data; name=\"$name\"\r\n\r\n".toByteArray())
            body.write(value.toByteArray()); body.write("\r\n".toByteArray())
        }
        field("model", model); field("language", "zh"); field("response_format", "json"); field("temperature", "0")
        if (prompt.isNotBlank()) field("prompt", prompt)
        body.write("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"speech.wav\"\r\nContent-Type: audio/wav\r\n\r\n".toByteArray())
        body.write(wav); body.write("\r\n--$boundary--\r\n".toByteArray())
        return try {
            val conn = URL(endpoint).openConnection() as HttpURLConnection
            conn.connectTimeout = timeoutMs; conn.readTimeout = timeoutMs
            conn.requestMethod = "POST"; conn.doOutput = true
            conn.setRequestProperty("Authorization", "Bearer $key")
            conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
            conn.setFixedLengthStreamingMode(body.size())
            conn.outputStream.use { body.writeTo(it) }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
            conn.disconnect()
            if (code in 200..299) Result(JsonLite.stringField(text, "text").orEmpty().trim(), "")
            else Result("", errorOf(code))
        } catch (e: IOException) {
            Result("", "連不上雲端語音辨識")
        }
    }

    /** 金鑰能不能用：回空字串＝可以，否則是給人看的原因。 */
    fun checkKey(key: String, url: String = MODELS, timeoutMs: Int = 10000): String = try {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = timeoutMs; conn.readTimeout = timeoutMs
        conn.setRequestProperty("Authorization", "Bearer $key")
        val code = conn.responseCode
        runCatching { (if (code in 200..299) conn.inputStream else conn.errorStream)?.close() }
        conn.disconnect()
        if (code in 200..299) "" else errorOf(code)
    } catch (e: IOException) {
        "連不上 OpenAI，請檢查網路"
    }

    fun errorOf(code: Int): String = when (code) {
        401, 403 -> "OpenAI 金鑰不對或已失效"
        429 -> "OpenAI 額度用完了或用太快"
        else -> "雲端語音辨識失敗（$code）"
    }

    /** 把自己的常用詞給它當提示，人名、地名、指令比較不會聽錯。 */
    fun promptOf(words: List<String>): String {
        val list = words.map { it.trim() }.filter { it.isNotEmpty() }.distinct().take(60)
        return "以下是台灣繁體中文的語音指令。" + if (list.isEmpty()) "" else "常用詞：" + list.joinToString("、") + "。"
    }
}
