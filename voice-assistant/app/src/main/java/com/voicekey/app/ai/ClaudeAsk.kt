package com.voicekey.app.ai

import com.anthropic.client.AnthropicClient
import com.anthropic.client.okhttp.AnthropicOkHttpClient
import com.anthropic.core.JsonValue
import com.anthropic.errors.AnthropicIoException
import com.anthropic.errors.AnthropicServiceException
import com.anthropic.errors.BadRequestException
import com.anthropic.errors.InternalServerException
import com.anthropic.errors.NotFoundException
import com.anthropic.errors.PermissionDeniedException
import com.anthropic.errors.RateLimitException
import com.anthropic.errors.UnauthorizedException
import com.anthropic.models.beta.messages.BetaMessage
import com.anthropic.models.beta.messages.BetaOutputConfig
import com.anthropic.models.beta.messages.BetaStopReason
import com.anthropic.models.beta.messages.BetaUserLocation
import com.anthropic.models.beta.messages.BetaWebSearchTool20260209
import com.anthropic.models.beta.messages.MessageCreateParams
import com.voicekey.app.core.Ask
import java.time.Duration

/**
 * 問答：指令比對不到、或擺明是在問問題時，把那句話交給 Claude 回答；需要最新資訊它會自己上網查。
 * 金鑰是使用者貼在手機上的，只存在手機。
 */
object ClaudeAsk {
    data class Reply(val text: String, val error: String = "")

    /** 設定頁可選的模型：第一個是預設。 */
    val MODELS = listOf(
        "claude-opus-5-5" to "Opus 5.5（最準）",
        "claude-sonnet-5-5" to "Sonnet 5.5（比較快、比較省）",
    )

    private const val FALLBACK_BETA = "server-side-fallback-2026-07-01"
    private const val MAX_RESUMES = 3

    /** 只有測試版會設：把請求導到假的伺服器，在沒有金鑰的模擬器上跑完整流程。 */
    @Volatile
    var testBaseUrl: String? = null

    private fun client(key: String): AnthropicClient {
        val b = AnthropicOkHttpClient.builder()
            .apiKey(key)
            .timeout(Duration.ofSeconds(90))
            .maxRetries(1)
        testBaseUrl?.let { b.baseUrl(it) }
        return b.build()
    }

    /** 問一題。today 例如「2026-11-24（星期二）」。 */
    fun ask(key: String, model: String, question: String, today: String): Reply {
        val client = try { client(key) } catch (e: Exception) { return Reply("", "問答元件啟動失敗（${e.javaClass.simpleName}）") }
        try {
            val params = MessageCreateParams.builder()
                .model(model)
                .maxTokens(16000L)
                .system(Ask.system(today))
                // 一兩句話的口頭回答：用低的思考量換速度
                .outputConfig(BetaOutputConfig.builder().effort(BetaOutputConfig.Effort.LOW).build())
                .addTool(
                    BetaWebSearchTool20260209.builder()
                        .maxUses(3L)
                        .userLocation(BetaUserLocation.builder().country("TW").timezone("Asia/Taipei").build())
                        .build(),
                )
                // 模型的安全分類器偶爾會誤擋正常問題：讓伺服器自動改用建議的備援模型再答一次
                .addBeta(FALLBACK_BETA)
                .putAdditionalBodyProperty("fallbacks", JsonValue.from("default"))
                .addUserMessage(question)

            var message = client.beta().messages().create(params.build())
            // 伺服器端的搜尋迴圈跑太多輪會先停下來（pause_turn）：把它的回覆原封不動接回去再送一次，就會從停下來的地方繼續
            var resumes = 0
            while (message.stopReason().orElse(null) == BetaStopReason.PAUSE_TURN && resumes++ < MAX_RESUMES) {
                params.addMessage(message)
                message = client.beta().messages().create(params.build())
            }
            if (message.stopReason().orElse(null) == BetaStopReason.REFUSAL) return Reply("", "這個問題我沒辦法回答")
            val text = Ask.clean(finalText(message))
            return if (text.isEmpty()) Reply("", "沒有查到可以回答的內容，換個問法試試") else Reply(text)
        } catch (e: UnauthorizedException) {
            return Reply("", "Claude 金鑰不對或已經失效，請到設定頁重新貼上")
        } catch (e: PermissionDeniedException) {
            return Reply("", "這把 Claude 金鑰沒有權限用這個功能")
        } catch (e: NotFoundException) {
            return Reply("", "這把金鑰不能用選的這個模型，請到設定頁換一個")
        } catch (e: RateLimitException) {
            return Reply("", "問得太頻繁或用量到上限了，等一下再問")
        } catch (e: BadRequestException) {
            return Reply("", "Claude 不接受這個請求，可能是帳戶餘額不足，請到 Anthropic 後台看一下")
        } catch (e: InternalServerException) {
            return Reply("", "Claude 那邊暫時忙不過來，等一下再問")
        } catch (e: AnthropicServiceException) {
            // 402 帳戶沒有餘額也會到這裡
            return Reply("", if (e.statusCode() == 402) "Claude 帳戶沒有餘額了，請到 Anthropic 後台儲值" else "Claude 回了錯誤（${e.statusCode()}）")
        } catch (e: AnthropicIoException) {
            return Reply("", "網路不通，問不到答案")
        } catch (e: Exception) {
            return Reply("", "問答出錯（${e.javaClass.simpleName}）")
        } finally {
            runCatching { client.close() }
        }
    }

    /** ok＝可以存；message 是給人看的說明（空字串＝沒問題）。 */
    data class Check(val ok: Boolean, val message: String)

    /** 檢查金鑰能不能用這個模型（不花錢）。金鑰明確不對才擋；Claude 那邊暫時有狀況時先讓人存。 */
    fun check(key: String, model: String): Check {
        val client = try { client(key) } catch (e: Exception) { return Check(false, "問答元件啟動失敗（${e.javaClass.simpleName}）") }
        return try {
            client.models().retrieve(model)
            Check(true, "")
        } catch (e: UnauthorizedException) {
            Check(false, "金鑰不對，請確認是 sk-ant- 開頭、整串都有貼到")
        } catch (e: PermissionDeniedException) {
            Check(false, "這把金鑰沒有權限")
        } catch (e: NotFoundException) {
            Check(false, "這把金鑰不能用這個模型，請換一個模型再試")
        } catch (e: AnthropicIoException) {
            Check(false, "網路不通，沒辦法檢查")
        } catch (e: AnthropicServiceException) {
            Check(true, "Claude 那邊暫時回了錯誤（${e.statusCode()}），金鑰先存好了，等一下問一題試試")
        } catch (e: Exception) {
            Check(true, "沒辦法確認金鑰（${e.javaClass.simpleName}），先存好了，問一題試試")
        } finally {
            runCatching { client.close() }
        }
    }

    /**
     * 真正的答案＝最後一次用工具之後的那些文字。
     * 回覆裡會夾著「我來查一下」這種查之前講的話、搜尋的呼叫與結果、思考區塊；答案本身還會被引用來源切成好幾塊文字，要接起來。
     */
    private fun finalText(message: BetaMessage): String {
        val sb = StringBuilder()
        for (block in message.content()) {
            when {
                block.isText() -> sb.append(block.asText().text())
                block.isThinking() || block.isRedactedThinking() -> {}
                else -> sb.setLength(0)
            }
        }
        return sb.toString()
    }
}
