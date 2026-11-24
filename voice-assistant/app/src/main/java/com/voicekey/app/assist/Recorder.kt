package com.voicekey.app.assist

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import com.voicekey.app.core.Vad
import com.voicekey.app.core.Wav
import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.util.concurrent.LinkedBlockingQueue

/**
 * 自己錄一段話（16k 單聲道），講完自動停。錄到的聲音只留在記憶體，交給雲端辨識後就丟掉。
 * tee＝同一份聲音同時餵給 Google 辨識（兩段式用）；另開一條線寫，對方不讀也不會卡住錄音。
 */
class Recorder {
    data class Clip(val pcm: ByteArray, val spoke: Boolean)

    companion object {
        const val RATE = 16000
        private const val FRAME = 640   // 20 毫秒
    }

    @Volatile
    private var stopped = false

    fun stop() { stopped = true }

    /** 會卡住直到講完／被叫停／超過上限，請在背景執行緒呼叫。 */
    @SuppressLint("MissingPermission")
    fun record(tee: OutputStream?, maxMs: Long = 14000): Clip {
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = try {
            AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, FRAME * 10))
        } catch (e: Exception) {
            runCatching { tee?.close() }
            return Clip(ByteArray(0), false)
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            runCatching { tee?.close() }
            return Clip(ByteArray(0), false)
        }
        val feeder = tee?.let { Feeder(it) }
        val out = ByteArrayOutputStream()
        val buf = ByteArray(FRAME)
        val vad = Vad()
        try {
            rec.startRecording()
            val t0 = System.currentTimeMillis()
            while (!stopped && System.currentTimeMillis() - t0 < maxMs) {
                val n = rec.read(buf, 0, buf.size)
                if (n <= 0) break
                out.write(buf, 0, n)
                feeder?.offer(buf.copyOf(n))
                val st = vad.feed(Wav.rms(buf, n))
                if (st == Vad.State.ENDED || st == Vad.State.TIMEOUT) break
            }
        } catch (e: Exception) {
            // 錄音中途出狀況：有多少算多少
        } finally {
            runCatching { rec.stop() }
            rec.release()
            feeder?.close()
        }
        return Clip(out.toByteArray(), vad.spoke)
    }

    private class Feeder(private val out: OutputStream) {
        private val queue = LinkedBlockingQueue<ByteArray>()
        private val end = ByteArray(0)
        private val thread = Thread {
            try {
                while (true) {
                    val b = queue.take()
                    if (b === end) break
                    out.write(b)
                }
                out.flush()
            } catch (e: Exception) {
                // 對方關掉了就不寫
            } finally {
                runCatching { out.close() }
            }
        }.apply { isDaemon = true; start() }

        fun offer(b: ByteArray) { queue.offer(b) }
        fun close() { queue.offer(end) }
    }
}
