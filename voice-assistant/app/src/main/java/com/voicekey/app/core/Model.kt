package com.voicekey.app.core

enum class ActionType(val label: String) {
    WEBHOOK("呼叫網址（鐵門、智慧裝置）"),
    OPEN_APP("打開 App"),
    OPEN_URL("開啟連結"),
    CALL_PHONE("撥打電話號碼"),
    LINE_CALL("LINE 語音通話"),
}

enum class Protection(val label: String) {
    NONE("不用確認"),
    CONFIRM("兩段式：要再說「確定」"),
    PASSWORD("兩段式：要說出密碼"),
}

enum class Channel(val label: String) { LINE("LINE"), PHONE("電話") }

data class Command(
    val id: String,
    val name: String,
    val triggers: List<String>,
    val type: ActionType,
    val target: String,
    val method: String = "GET",
    val body: String = "",
    val protection: Protection = Protection.NONE,
    val requireUnlock: Boolean = false,
)

data class Contact(
    val id: String,
    val name: String,
    val aliases: List<String>,
    val lineName: String,
    val phone: String,
    val defaultChannel: Channel = Channel.LINE,
)

data class Place(
    val id: String,
    val name: String,
    val aliases: List<String>,
    val address: String,
)

data class Config(
    val commands: List<Command> = emptyList(),
    val contacts: List<Contact> = emptyList(),
    val places: List<Place> = emptyList(),
)

data class AppEntry(val label: String, val pkg: String)
