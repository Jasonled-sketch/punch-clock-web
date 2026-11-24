package com.voicekey.app.core

/** 「打開音樂」「打開相機」這種通稱：手機裡 App 的名字不一定叫這個，改開手機預設的那一種 App。 */
object Generic {
    const val PREFIX = "kind:"

    /** kind → 可以怎麼叫 */
    val KINDS: List<Pair<String, List<String>>> = listOf(
        "music" to listOf("音樂", "歌", "音樂播放器"),
        "camera" to listOf("相機", "照相機", "拍照"),
        "gallery" to listOf("相簿", "照片", "圖片庫", "媒體瀏覽器"),
        "maps" to listOf("地圖"),   // 「導航」另外有導航指令在處理
        "browser" to listOf("瀏覽器", "網頁", "上網"),
        "calculator" to listOf("計算機", "計算器"),
        "contacts" to listOf("聯絡人", "通訊錄", "電話簿"),
        "dialer" to listOf("電話", "撥號", "撥號鍵盤"),
        "messages" to listOf("簡訊", "訊息"),
        "email" to listOf("信箱", "郵件", "電子郵件"),
        "clock" to listOf("時鐘", "鬧鐘"),
        "settings" to listOf("設定", "手機設定"),
        "files" to listOf("檔案", "我的檔案", "檔案管理"),
    )

    /** 給比對用的假 App 清單（排在真的 App 後面：真的有叫這個名字的 App 就開那個） */
    val entries: List<AppEntry> = KINDS.flatMap { (kind, names) -> names.map { AppEntry(it, PREFIX + kind) } }

    fun kindOf(pkg: String): String? = pkg.takeIf { it.startsWith(PREFIX) }?.removePrefix(PREFIX)

    /** 媒體控制："play"／"pause"／"next"／"prev"；不是就回 null。 */
    fun media(text: String): String? {
        val t = text.replace(Regex("[\\s，。,.！!？?、]"), "")
        return when {
            listOf("下一首", "下一曲", "切歌", "換一首").any { t.contains(it) } -> "next"
            listOf("上一首", "上一曲").any { t.contains(it) } -> "prev"
            listOf("暫停", "停止播放", "音樂停", "音樂關掉", "關掉音樂", "關音樂", "不要放了", "停止音樂").any { t.contains(it) } -> "pause"
            listOf("播放音樂", "放音樂", "播音樂", "繼續播放", "繼續播", "聽音樂", "放歌", "播歌", "來點音樂", "放首歌").any { t.contains(it) } -> "play"
            else -> null
        }
    }

    fun mediaLabel(kind: String): String = when (kind) {
        "next" -> "下一首"
        "prev" -> "上一首"
        "pause" -> "暫停播放"
        else -> "播放音樂"
    }
}
