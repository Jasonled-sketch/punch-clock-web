package com.voicekey.app.ui

import android.Manifest
import android.app.role.RoleManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.service.voice.VoiceInteractionService
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voicekey.app.assist.AssistActivity
import com.voicekey.app.assist.EngineOption
import com.voicekey.app.assist.Speaker
import com.voicekey.app.assist.VoiceOption
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import com.voicekey.app.assist.VkInteractionService
import com.voicekey.app.core.ActionType
import com.voicekey.app.core.AppEntry
import com.voicekey.app.core.Channel
import com.voicekey.app.core.Command
import com.voicekey.app.core.Config
import com.voicekey.app.core.Contact
import com.voicekey.app.core.Matcher
import com.voicekey.app.core.Place
import com.voicekey.app.core.Parsed
import com.voicekey.app.core.Protection
import com.voicekey.app.data.Store
import com.voicekey.app.line.LineCallService

/** 設定頁：權限檢查、聯絡人、指令、密碼、排查工具。 */
class MainActivity : ComponentActivity() {

    private var refresh by mutableIntStateOf(0)
    private var config by mutableStateOf(Config())

    private val askPermissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { refresh++ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        config = Store.config(this)
        setContent {
            MaterialTheme(colorScheme = lightColorScheme(primary = Color(0xFF1F6FEB))) {
                Surface(Modifier.fillMaxSize(), color = Color(0xFFF4F6FA)) { Screen() }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        refresh++
    }

    private fun update(c: Config) {
        config = c
        Store.save(this, c)
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    private fun open(intent: Intent, fallback: Intent? = null) {
        if (runCatching { startActivity(intent) }.isFailure && fallback != null) {
            runCatching { startActivity(fallback) }
        }
    }

    /** 直接跳到本 App 無障礙服務的開關頁；不支援時退回協助工具總頁。 */
    private fun openLineServiceSettings() {
        val component = ComponentName(this, LineCallService::class.java).flattenToString()
        val details = Intent("android.settings.ACCESSIBILITY_DETAILS_SETTINGS")
            .putExtra(Intent.EXTRA_COMPONENT_NAME, component)
        open(details, Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
    }

    private fun appDetails() = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))

    // ---- 狀態檢查 ----

    private fun granted(p: String) = checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    private fun isAssistant(): Boolean {
        val byService = runCatching {
            VoiceInteractionService.isActiveService(this, ComponentName(this, VkInteractionService::class.java))
        }.getOrDefault(false)
        val byRole = runCatching {
            getSystemService(RoleManager::class.java).isRoleHeld(RoleManager.ROLE_ASSISTANT)
        }.getOrDefault(false)
        return byService || byRole
    }

    private fun lineServiceOn(): Boolean {
        if (LineCallService.instance != null) return true
        val enabled = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
        return enabled.contains(ComponentName(this, LineCallService::class.java).flattenToString())
    }

    // ---- 畫面 ----

    @Composable
    private fun Screen() {
        @Suppress("UNUSED_VARIABLE") val tick = refresh
        var editContact by remember { mutableStateOf<Contact?>(null) }
        var editCommand by remember { mutableStateOf<Command?>(null) }
        var editPlace by remember { mutableStateOf<Place?>(null) }
        var showSecret by remember { mutableStateOf(false) }
        var showLog by remember { mutableStateOf(false) }

        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("語音快捷", fontSize = 26.sp, fontWeight = FontWeight.Bold)
            Button(
                onClick = { startActivity(Intent(this@MainActivity, AssistActivity::class.java)) },
                modifier = Modifier.fillMaxWidth().height(56.dp),
            ) { Text("開始說話", fontSize = 18.sp) }

            Section("第一次使用：請把下面四項都打開") {
                val mic = granted(Manifest.permission.RECORD_AUDIO)
                val call = granted(Manifest.permission.CALL_PHONE)
                Check("麥克風", mic, "聽指令用") {
                    askPermissions.launch(arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CALL_PHONE))
                }
                Check("撥打電話", call, "說「打電話給某某」時直接撥出") {
                    askPermissions.launch(arrayOf(Manifest.permission.CALL_PHONE))
                }
                Check("預設數位助理", isAssistant(), "設好後，長按側鍵就會叫出語音快捷") {
                    open(Intent(Settings.ACTION_VOICE_INPUT_SETTINGS), Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS))
                }
                Check("LINE 通話（無障礙）", lineServiceOn(), "代替手指在 LINE 按語音通話") {
                    openLineServiceSettings()
                }
                Text(
                    "按「去開啟」會直接跳到開關頁，把「語音快捷：LINE 通話」打開。" +
                        "沒有跳到開關的話，請在「協助工具 → 已安裝的應用程式」裡找。" +
                        "開關是灰色點不了：先按下方按鈕進「應用程式資訊」，點右上角三個點 →「允許受限制的設定」，再回來開。",
                    fontSize = 13.sp, color = Color(0xFF57606A),
                )
                OutlinedButton(onClick = { open(appDetails()) }) { Text("開啟應用程式資訊") }
                RecognizerPicker()
            }

            Section("聯絡人（說「打給某某」時用）") {
                if (config.contacts.isEmpty()) Hint("還沒有聯絡人。新增後就能說「用賴打給某某」。")
                config.contacts.forEach { c ->
                    ItemRow(
                        title = c.name,
                        sub = listOfNotNull(
                            c.lineName.takeIf { it.isNotBlank() }?.let { "LINE：$it" },
                            c.phone.takeIf { it.isNotBlank() }?.let { "電話：$it" },
                            "預設用${c.defaultChannel.label}",
                        ).joinToString("　"),
                    ) { editContact = c }
                }
                OutlinedButton(onClick = {
                    editContact = Contact(Store.newId(), "", emptyList(), "", "", Channel.LINE)
                }) { Text("＋ 新增聯絡人") }
            }

            Section("地點（說「導航回公司」時用）") {
                config.places.forEach { p ->
                    ItemRow(
                        title = p.name,
                        sub = if (p.address.isBlank()) "⚠ 還沒填地址" else p.address,
                    ) { editPlace = p }
                }
                OutlinedButton(onClick = {
                    editPlace = Place(Store.newId(), "", emptyList(), "")
                }) { Text("＋ 新增地點") }
                Hint("沒存的地方也能說，例如「導航到高雄車站」。說「騎車導航」「走路導航」會換成機車／步行路線。")
            }

            Section("登記行程、知識庫（公司行事曆）") {
                val cal = remember(refresh) { Store.calendarTarget(this@MainActivity, "image/jpeg") }
                Text(
                    if (cal != null) "✅ 已找到公司行事曆" else "⬜ 手機上找不到公司行事曆",
                    color = if (cal != null) Color(0xFF1A7F37) else Color(0xFFCF222E),
                )
                if (cal == null) Hint("請用 Chrome 打開公司行事曆，右上角選單 →「安裝應用程式／加到主畫面」，裝好再回來。")
                Hint("在 LINE 對話或任何畫面上長按側鍵，說「幫我登記行程」，就會把那個畫面交給行事曆讀、把表單填好，你看過再按儲存。")
                Hint("說「幫我登記行程，個人」或「…，公司」，表單會先選好那一本。")
                Hint("也可以直接說內容：「登記行程，明天下午三點去永康估價」。")
                Hint("看到想留下來的畫面：長按側鍵說「存到知識庫」，AI 會整理好放進行事曆「我的工作 → 知識庫」。")
                Hint("拿不到畫面時：到手機設定 → 應用程式 → 選擇預設應用程式 → 數位助理應用程式，把「分析螢幕上的內容／使用螢幕截圖」打開。")
            }

            Section("指令") {
                config.commands.forEach { c ->
                    val warn = if (c.type == ActionType.WEBHOOK && c.target.isBlank()) "　⚠ 還沒填網址" else ""
                    ItemRow(
                        title = c.name,
                        sub = "${c.type.label}　${c.protection.label}$warn",
                    ) { editCommand = c }
                }
                OutlinedButton(onClick = {
                    editCommand = Command(Store.newId(), "", emptyList(), ActionType.OPEN_APP, "")
                }) { Text("＋ 新增指令") }
                Hint("不用新增也能說「打開＋App 名稱」，例如「打開相機」「打開賴」。")
            }

            Section("語音辨識（聽得更準）") { SttSettings() }

            Section("呼喊喚醒（喊一聲就叫出來）") { WakeSettings() }

            Section("語音回覆的聲音") { VoiceSettings() }

            Section("密碼（保護開鐵門這類指令）") {
                val has = Store.secret(this@MainActivity).isNotEmpty()
                Text(if (has) "已設定密碼" else "尚未設定密碼", color = if (has) Color(0xFF1A7F37) else Color(0xFFCF222E))
                OutlinedButton(onClick = { showSecret = true }) { Text(if (has) "更改密碼" else "設定密碼") }
                Hint("可以一口氣說完，例如「開鐵門一二三四」，就不會再問第二次。只說「開鐵門」則會再問密碼。")
                Hint("密碼是用說的，旁邊有人時會被聽到；連續說錯 5 次會鎖 10 分鐘。")
            }

            Section("測試與排查") {
                TextTester()
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { showLog = true }) { Text("看紀錄") }
                    OutlinedButton(onClick = {
                        val s = LineCallService.instance
                        if (s == null) toast("請先開啟 LINE 通話（無障礙）") else {
                            s.dumpLater(6000)
                            toast("6 秒後擷取，請現在切到 LINE 要檢查的畫面")
                        }
                    }) { Text("擷取 LINE 畫面結構") }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = {
                        copy(Store.toJson(config))
                        toast("設定已複製（不含密碼），貼到記事本保存")
                    }) { Text("匯出設定") }
                    OutlinedButton(onClick = {
                        val raw = paste()
                        val parsed = runCatching { Store.fromJson(raw) }.getOrNull()
                        if (parsed == null || raw.isBlank()) toast("剪貼簿裡不是有效的設定") else {
                            update(parsed)
                            toast("已匯入 ${parsed.commands.size} 個指令、${parsed.contacts.size} 位聯絡人")
                        }
                    }) { Text("從剪貼簿匯入") }
                }
            }
            Spacer(Modifier.height(24.dp))
        }

        editContact?.let { c ->
            ContactDialog(
                initial = c,
                isNew = config.contacts.none { it.id == c.id },
                onSave = { saved ->
                    update(config.copy(contacts = config.contacts.filter { it.id != saved.id } + saved))
                    editContact = null
                },
                onDelete = {
                    update(config.copy(contacts = config.contacts.filter { it.id != c.id }))
                    editContact = null
                },
                onDismiss = { editContact = null },
            )
        }
        editCommand?.let { c ->
            CommandDialog(
                initial = c,
                isNew = config.commands.none { it.id == c.id },
                onSave = { saved ->
                    val list = config.commands.toMutableList()
                    val i = list.indexOfFirst { it.id == saved.id }
                    if (i >= 0) list[i] = saved else list.add(saved)
                    update(config.copy(commands = list))
                    editCommand = null
                },
                onDelete = {
                    update(config.copy(commands = config.commands.filter { it.id != c.id }))
                    editCommand = null
                },
                onDismiss = { editCommand = null },
            )
        }
        editPlace?.let { p ->
            PlaceDialog(
                initial = p,
                isNew = config.places.none { it.id == p.id },
                onSave = { saved ->
                    val list = config.places.toMutableList()
                    val i = list.indexOfFirst { it.id == saved.id }
                    if (i >= 0) list[i] = saved else list.add(saved)
                    update(config.copy(places = list))
                    editPlace = null
                },
                onDelete = {
                    update(config.copy(places = config.places.filter { it.id != p.id }))
                    editPlace = null
                },
                onDismiss = { editPlace = null },
            )
        }
        if (showSecret) SecretDialog { showSecret = false }
        if (showLog) LogDialog { showLog = false }
    }

    @Composable
    private fun Section(title: String, content: @Composable () -> Unit) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(title, fontWeight = FontWeight.Bold, fontSize = 17.sp)
                content()
            }
        }
    }

    @Composable
    private fun Hint(text: String) = Text(text, fontSize = 13.sp, color = Color(0xFF57606A))

    @Composable
    private fun Check(title: String, ok: Boolean, sub: String, onFix: () -> Unit) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(if (ok) "✅" else "⬜", fontSize = 18.sp)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(title, fontSize = 16.sp)
                Text(sub, fontSize = 13.sp, color = Color(0xFF57606A))
            }
            if (!ok) TextButton(onClick = onFix) { Text("去開啟") }
        }
    }

    @Composable
    private fun ItemRow(title: String, sub: String, onClick: () -> Unit) {
        Column(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 6.dp)) {
            Text(title.ifBlank { "（未命名）" }, fontSize = 16.sp)
            Text(sub, fontSize = 13.sp, color = Color(0xFF57606A))
        }
        HorizontalDivider()
    }

    @Composable
    private fun RecognizerPicker() {
        val all = remember(refresh) { Store.recognizers(this) }
        var current by remember(refresh) { mutableStateOf(Store.recognizer(this)) }
        var open by remember { mutableStateOf(false) }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("辨識引擎：", fontSize = 14.sp)
            Box {
                TextButton(onClick = { open = true }) { Text(current?.let(::engineName) ?: "找不到，請安裝 Google App") }
                DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                    all.forEach { c ->
                        DropdownMenuItem(text = { Text(engineName(c)) }, onClick = {
                            Store.setRecognizer(this@MainActivity, c)
                            current = c
                            open = false
                        })
                    }
                }
            }
        }
    }

    private val pickKeyword = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@registerForActivityResult
        val ok = runCatching {
            val bytes = contentResolver.openInputStream(uri)!!.use { it.readBytes() }
            require(bytes.size in 500..2_000_000)
            com.voicekey.app.assist.WakeService.keywordFile(this).writeBytes(bytes)
            val name = contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
            Store.setWakeName(this, name ?: "喚醒詞檔案")
        }.isSuccess
        toast(if (ok) "喚醒詞檔案已存好" else "這個檔案讀不了，請選 .ppn 檔")
        refresh++
    }

    /** 手機已經配對過的藍牙裝置（位址, 名稱）；沒權限或沒開藍牙回空的。 */
    @android.annotation.SuppressLint("MissingPermission")
    private fun pairedBluetooth(): List<Pair<String, String>> = runCatching {
        val adapter = getSystemService(android.bluetooth.BluetoothManager::class.java)?.adapter
        adapter?.bondedDevices.orEmpty().map { it.address to (it.name ?: it.address) }.sortedBy { it.second }
    }.getOrDefault(emptyList())

    @Composable
    private fun WakeSettings() {
        val W = com.voicekey.app.assist.WakeService
        @Suppress("UNUSED_VARIABLE") val tick = refresh
        val levels = listOf("不容易誤觸" to 0.35f, "一般" to 0.5f, "容易叫醒" to 0.7f)
        var key by remember { mutableStateOf("") }
        var saved by remember(refresh) { mutableStateOf(Store.picoKey(this)) }
        var sens by remember { mutableStateOf(Store.wakeSensitivity(this)) }
        var on by remember(refresh) { mutableStateOf(Store.wakeEnabled(this)) }
        val hasFile = W.keywordFile(this).exists()

        Text(
            when {
                on && W.running -> "✅ 正在聽喚醒詞"
                on -> "⬜ 有打開但還沒在聽" + (if (W.lastError.isNotEmpty()) "：" + W.lastError else "")
                else -> "⬜ 沒有開"
            },
            color = if (on && W.running) Color(0xFF1A7F37) else Color(0xFFCF222E),
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("開啟呼喊喚醒", Modifier.weight(1f))
            Switch(checked = on, onCheckedChange = { want ->
                if (!want) { Store.setWakeEnabled(this@MainActivity, false); W.stop(this@MainActivity); on = false; refresh++; return@Switch }
                if (android.os.Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS)) askPermissions.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS, Manifest.permission.RECORD_AUDIO))
                val problem = W.start(this@MainActivity)
                if (problem.isNotEmpty()) { toast(problem); return@Switch }
                Store.setWakeEnabled(this@MainActivity, true); on = true
                window.decorView.postDelayed({ refresh++ }, 1500)
            })
        }
        HorizontalDivider()
        Text(if (saved.isBlank()) "⬜ 還沒有 Picovoice AccessKey" else "✅ 已存 AccessKey（結尾 ${saved.takeLast(4)}）", color = if (saved.isBlank()) Color(0xFFCF222E) else Color(0xFF1A7F37))
        OutlinedTextField(
            value = key, onValueChange = { key = it }, label = { Text("貼上 Picovoice AccessKey") },
            singleLine = true, modifier = Modifier.fillMaxWidth(),
            visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        )
        OutlinedButton(onClick = {
            if (key.trim().length < 20) toast("AccessKey 看起來不完整") else { Store.setPicoKey(this@MainActivity, key); saved = key.trim(); key = ""; toast("已存好") }
        }) { Text("儲存 AccessKey") }
        Text(if (hasFile) "✅ 喚醒詞檔案：${Store.wakeName(this)}" else "⬜ 還沒有選喚醒詞檔案", color = if (hasFile) Color(0xFF1A7F37) else Color(0xFFCF222E))
        OutlinedButton(onClick = { pickKeyword.launch(arrayOf("*/*")) }) { Text(if (hasFile) "換一個喚醒詞檔案（.ppn）" else "選喚醒詞檔案（.ppn）") }
        Picker("靈敏度（改了要關掉再開才生效）", levels.minByOrNull { kotlin.math.abs(it.second - sens) }!!.first, levels.map { it.first }) { i ->
            sens = levels[i].second
            Store.setWakeSensitivity(this, sens)
        }
        HorizontalDivider()
        Text("自動開關（不用整天開著）", fontWeight = FontWeight.Bold)
        var charge by remember { mutableStateOf(Store.autoCharge(this)) }
        var btName by remember(refresh) { mutableStateOf(Store.autoBtName(this)) }
        var btOpen by remember { mutableStateOf(false) }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("插上充電就開始聽，拔掉就停", Modifier.weight(1f))
            Switch(checked = charge, onCheckedChange = { charge = it; Store.setAutoCharge(this@MainActivity, it) })
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("連上這台藍牙就開始聽：", Modifier.weight(1f))
            Box {
                TextButton(onClick = {
                    if (android.os.Build.VERSION.SDK_INT >= 31 && !granted(Manifest.permission.BLUETOOTH_CONNECT)) {
                        askPermissions.launch(arrayOf(Manifest.permission.BLUETOOTH_CONNECT)); toast("請先允許「附近的裝置」，再按一次")
                    } else btOpen = true
                }) { Text(btName.ifBlank { "不使用" }) }
                DropdownMenu(expanded = btOpen, onDismissRequest = { btOpen = false }) {
                    DropdownMenuItem(text = { Text("不使用") }, onClick = { Store.setAutoBt(this@MainActivity, "", ""); btName = ""; btOpen = false })
                    pairedBluetooth().forEach { (addr, name) ->
                        DropdownMenuItem(text = { Text(name) }, onClick = { Store.setAutoBt(this@MainActivity, addr, name); btName = name; btOpen = false })
                    }
                }
            }
        }
        Hint("選車子的藍牙：上車連上就自動開始聽，下車斷線就自動停。清單是手機已經配對過的裝置。")
        Hint("自動開關要語音快捷是「預設數位助理」才有效（這樣系統才准它在背景自己打開麥克風）。萬一被擋，會跳一則通知「點一下開始聽喚醒詞」，點它就好。")
        HorizontalDivider()
        Hint("怎麼拿到這兩樣：到 Picovoice Console 註冊（免費方案）→ 首頁複製 AccessKey → 進 Porcupine，語言選「中文」，打你想喊的詞（例如「小幫手」），平台選 Android，按下載。下載的壓縮檔解開，裡面那個 .ppn 就是喚醒詞檔案。")
        Hint("喚醒詞是在手機本機辨識，聲音不會傳出去；但通知列會一直有一則通知，螢幕上方的麥克風綠點也會常亮，會多耗一些電。")
        Hint("三星會自動關掉背景 App：請到手機設定 → 應用程式 → 語音快捷 → 電池，選「不受限制」。")
        Hint("要先把語音快捷設成「預設數位助理」，喊了才跳得出畫面。重開機後如果沒有自己接著聽，打開這一頁再開一次。")
    }

    @Composable
    private fun SttSettings() {
        val scope = rememberCoroutineScope()
        val modes = listOf("google" to "只用手機內建（最快）", "both" to "兩段式：內建先聽，沒把握再送雲端", "cloud" to "一律送雲端（最準，多等 1～2 秒）")
        var mode by remember { mutableStateOf(Store.sttMode(this)) }
        var saved by remember { mutableStateOf(Store.openAiKey(this)) }
        var input by remember { mutableStateOf("") }
        var checking by remember { mutableStateOf(false) }
        var learnedCount by remember(refresh) { mutableIntStateOf(Store.learned(this).size) }

        Picker("辨識方式", modes.first { it.first == mode }.second, modes.map { it.second }) { i ->
            mode = modes[i].first
            Store.setSttMode(this, mode)
            if (mode != "google" && saved.isBlank()) toast("還沒有填 OpenAI 金鑰，會先照舊用手機內建")
        }
        Text(
            if (saved.isBlank()) "⬜ 還沒有 OpenAI 金鑰" else "✅ 已存金鑰（結尾 ${saved.takeLast(4)}）",
            color = if (saved.isBlank()) Color(0xFFCF222E) else Color(0xFF1A7F37),
        )
        OutlinedTextField(
            value = input, onValueChange = { input = it },
            label = { Text("貼上 OpenAI API 金鑰（sk- 開頭）") },
            singleLine = true, modifier = Modifier.fillMaxWidth(),
            visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(enabled = !checking, onClick = {
                val k = input.trim()
                if (k.length < 20) { toast("金鑰看起來不完整"); return@OutlinedButton }
                checking = true
                scope.launch {
                    val problem = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { com.voicekey.app.core.OpenAiStt.checkKey(k) }
                    checking = false
                    if (problem.isEmpty()) { Store.setOpenAiKey(this@MainActivity, k); saved = k; input = ""; toast("金鑰可以用，已存好") }
                    else toast(problem)
                }
            }) { Text(if (checking) "檢查中…" else "檢查並儲存") }
            if (saved.isNotBlank()) OutlinedButton(onClick = { Store.setOpenAiKey(this@MainActivity, ""); saved = ""; toast("金鑰已移除") }) { Text("移除金鑰") }
        }
        Hint("金鑰只存在這支手機，不會隨「匯出設定」帶出去。用的是跟公司行事曆「提醒代辦用講的」同一個辨識模型。")
        Hint("「好／取消」和密碼一律用手機內建辨識，密碼的聲音不會送到雲端。")
        Hint("兩段式如果反而聽不到或變慢，改選「一律送雲端」或「只用手機內建」。")
        HorizontalDivider()
        Text("已經記住 $learnedCount 種你的說法")
        Hint("它不確定時會反問「你是要…對嗎？」，你答「對」之後就會記住，下次同一句話直接做。")
        if (learnedCount > 0) OutlinedButton(onClick = { Store.clearLearned(this@MainActivity); learnedCount = 0; toast("已清除") }) { Text("清除記住的說法") }
    }

    @Composable
    private fun VoiceSettings() {
        val scope = rememberCoroutineScope()
        var enginePkg by remember { mutableStateOf(Store.ttsEngine(this)) }
        var speaker by remember { mutableStateOf(Speaker(this, enginePkg)) }
        var engines by remember { mutableStateOf<List<EngineOption>>(emptyList()) }
        var voices by remember { mutableStateOf<List<VoiceOption>>(emptyList()) }
        var voiceId by remember { mutableStateOf(Store.ttsVoice(this)) }
        var rate by remember { mutableStateOf(Store.ttsRate(this)) }
        val rates = listOf("慢" to 0.85f, "正常" to 1.0f, "稍快" to 1.15f, "快" to 1.3f)

        DisposableEffect(speaker) { onDispose { speaker.shutdown() } }
        LaunchedEffect(speaker) {
            engines = speaker.engines()
            voices = speaker.voices()
        }
        fun preview() {
            scope.launch { speaker.say("好，幫你用 LINE 打給小關。這是目前的聲音。") }
        }

        if (engines.size > 1) {
            Picker(
                "語音引擎",
                engines.firstOrNull { it.pkg == enginePkg }?.label ?: "手機預設",
                engines.map { it.label },
            ) { i ->
                enginePkg = engines[i].pkg
                Store.setTtsEngine(this, enginePkg)
                voiceId = null
                voices = emptyList()
                speaker = Speaker(this, enginePkg)
            }
        }
        if (voices.isEmpty()) {
            Hint("這個引擎沒有列出可選的中文聲音，會用它的預設聲音。")
        } else {
            Picker(
                "聲音（選了會馬上試聽）",
                voices.firstOrNull { it.id == voiceId }?.label ?: "預設",
                voices.map { it.label },
            ) { i ->
                voiceId = voices[i].id
                Store.setTtsVoice(this, voiceId)
                speaker.applyVoice(voiceId)
                preview()
            }
        }
        Picker("語速", rates.minByOrNull { kotlin.math.abs(it.second - rate) }!!.first, rates.map { it.first }) { i ->
            rate = rates[i].second
            Store.setTtsRate(this, rate)
            speaker.setRate(rate)
            preview()
        }
        OutlinedButton(onClick = { preview() }) { Text("試聽") }
        Hint("想要更多聲音：手機「設定」搜尋「文字轉語音」，進去可以換引擎、下載其他語音。")
    }

    private fun engineName(c: ComponentName): String =
        runCatching {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(c.packageName, 0)).toString()
        }.getOrDefault(c.packageName)

    @Composable
    private fun TextTester() {
        var text by remember { mutableStateOf("") }
        var result by remember { mutableStateOf("") }
        OutlinedTextField(
            value = text, onValueChange = { text = it },
            label = { Text("打字測試：輸入一句話看會做什麼") },
            singleLine = true, modifier = Modifier.fillMaxWidth(),
        )
        OutlinedButton(onClick = {
            val r = Matcher.match(listOf(text), config, Store.apps(this))
            result = when {
                r.parsed is Parsed.Unknown -> "聽不懂" + (r.parsed.reason.takeIf { it.isNotEmpty() }?.let { "：$it" } ?: "")
                r.score >= Matcher.EXECUTE -> "會直接執行：${Matcher.describe(r.parsed)}（相似度 ${"%.0f".format(r.score * 100)}%）"
                else -> "會先反問：你是說「${Matcher.describe(r.parsed)}」嗎？（相似度 ${"%.0f".format(r.score * 100)}%）"
            }
        }) { Text("測試（不會真的執行）") }
        OutlinedButton(onClick = {
            if (text.isBlank()) toast("請先輸入一句話") else {
                AssistActivity.pendingText = text
                startActivity(Intent(this@MainActivity, AssistActivity::class.java))
            }
        }) { Text("打字執行（會真的做，確認與密碼照常要用說的）") }
        if (result.isNotEmpty()) Text(result, fontSize = 14.sp)
    }

    // ---- 對話框 ----

    @Composable
    private fun ContactDialog(
        initial: Contact, isNew: Boolean,
        onSave: (Contact) -> Unit, onDelete: () -> Unit, onDismiss: () -> Unit,
    ) {
        var name by remember { mutableStateOf(initial.name) }
        var aliases by remember { mutableStateOf(initial.aliases.joinToString("、")) }
        var lineName by remember { mutableStateOf(initial.lineName) }
        var phone by remember { mutableStateOf(initial.phone) }
        var channel by remember { mutableStateOf(initial.defaultChannel) }
        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text(if (isNew) "新增聯絡人" else "編輯聯絡人") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Field("你平常怎麼叫他（例：小關）", name) { name = it }
                    Field("其他叫法，用、分開（可不填）", aliases) { aliases = it }
                    Field("他在你 LINE 好友裡的名稱（要一字不差）", lineName) { lineName = it }
                    Field("電話號碼（可不填）", phone, KeyboardType.Phone) { phone = it }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("沒特別說時用：")
                        Channel.entries.forEach { ch ->
                            TextButton(onClick = { channel = ch }) {
                                Text(
                                    (if (channel == ch) "● " else "○ ") + ch.label,
                                    fontWeight = if (channel == ch) FontWeight.Bold else FontWeight.Normal,
                                )
                            }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    if (name.isBlank()) toast("請填名稱") else onSave(
                        initial.copy(
                            name = name.trim(), aliases = split(aliases),
                            lineName = lineName.trim(), phone = phone.trim(), defaultChannel = channel,
                        ),
                    )
                }) { Text("儲存") }
            },
            dismissButton = {
                Row {
                    if (!isNew) TextButton(onClick = onDelete) { Text("刪除", color = Color(0xFFCF222E)) }
                    TextButton(onClick = onDismiss) { Text("取消") }
                }
            },
        )
    }

    @Composable
    private fun CommandDialog(
        initial: Command, isNew: Boolean,
        onSave: (Command) -> Unit, onDelete: () -> Unit, onDismiss: () -> Unit,
    ) {
        var name by remember { mutableStateOf(initial.name) }
        var triggers by remember { mutableStateOf(initial.triggers.joinToString("、")) }
        var type by remember { mutableStateOf(initial.type) }
        var target by remember { mutableStateOf(initial.target) }
        var post by remember { mutableStateOf(initial.method.equals("POST", true)) }
        var body by remember { mutableStateOf(initial.body) }
        var protection by remember { mutableStateOf(initial.protection) }
        var requireUnlock by remember { mutableStateOf(initial.requireUnlock) }
        var pickApp by remember { mutableStateOf(false) }

        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text(if (isNew) "新增指令" else "編輯指令") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Field("指令名稱（例：開公司鐵門）", name) { name = it }
                    Field("可以怎麼說，用、分開", triggers) { triggers = it }
                    Picker("做什麼", type.label, ActionType.entries.map { it.label }) { type = ActionType.entries[it] }
                    when (type) {
                        ActionType.WEBHOOK -> {
                            Field("網址（易微聯 Webhook 等）", target, KeyboardType.Uri) { target = it }
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text("用 POST 送出")
                                Spacer(Modifier.width(8.dp))
                                Switch(checked = post, onCheckedChange = { post = it })
                            }
                            if (post) Field("POST 內容（JSON，可空白）", body) { body = it }
                        }
                        ActionType.OPEN_APP -> {
                            OutlinedButton(onClick = { pickApp = true }) {
                                Text(if (target.isBlank()) "選擇 App" else "已選：$target")
                            }
                        }
                        ActionType.OPEN_URL -> Field("連結", target, KeyboardType.Uri) { target = it }
                        ActionType.CALL_PHONE -> Field("電話號碼", target, KeyboardType.Phone) { target = it }
                        ActionType.LINE_CALL -> Field("LINE 好友名稱（要一字不差）", target) { target = it }
                    }
                    Picker("安全保護", protection.label, Protection.entries.map { it.label }) {
                        protection = Protection.entries[it]
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("手機要先解鎖才能執行", Modifier.weight(1f))
                        Switch(checked = requireUnlock, onCheckedChange = { requireUnlock = it })
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    if (name.isBlank()) toast("請填指令名稱") else onSave(
                        initial.copy(
                            name = name.trim(), triggers = split(triggers), type = type, target = target.trim(),
                            method = if (post) "POST" else "GET", body = body,
                            protection = protection, requireUnlock = requireUnlock,
                        ),
                    )
                }) { Text("儲存") }
            },
            dismissButton = {
                Row {
                    if (!isNew) TextButton(onClick = onDelete) { Text("刪除", color = Color(0xFFCF222E)) }
                    TextButton(onClick = onDismiss) { Text("取消") }
                }
            },
        )
        if (pickApp) AppPicker(onPick = { app ->
            target = app.pkg
            if (name.isBlank()) name = "打開${app.label}"
            if (triggers.isBlank()) triggers = "打開${app.label}、開啟${app.label}"
            pickApp = false
        }, onDismiss = { pickApp = false })
    }

    @Composable
    private fun AppPicker(onPick: (AppEntry) -> Unit, onDismiss: () -> Unit) {
        val apps = remember { Store.apps(this) }
        var filter by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text("選擇 App") },
            text = {
                Column {
                    Field("搜尋", filter) { filter = it }
                    Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
                        apps.filter { filter.isBlank() || it.label.contains(filter, true) }.forEach { app ->
                            Text(
                                app.label,
                                Modifier.fillMaxWidth().clickable { onPick(app) }.padding(vertical = 10.dp),
                                fontSize = 16.sp,
                            )
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
        )
    }

    @Composable
    private fun PlaceDialog(
        initial: Place, isNew: Boolean,
        onSave: (Place) -> Unit, onDelete: () -> Unit, onDismiss: () -> Unit,
    ) {
        var name by remember { mutableStateOf(initial.name) }
        var aliases by remember { mutableStateOf(initial.aliases.joinToString("、")) }
        var address by remember { mutableStateOf(initial.address) }
        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text(if (isNew) "新增地點" else "編輯地點") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Field("你怎麼稱呼這裡（例：公司、A館、岡山倉庫）", name) { name = it }
                    Field("其他叫法，用、分開（可不填）", aliases) { aliases = it }
                    Field("地址或地標名稱", address) { address = it }
                    Hint("最準的是座標：在 Google 地圖長按那個位置，上方會出現像「22.6273, 120.3014」的數字，複製貼上即可。")
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    if (name.isBlank()) toast("請填名稱") else onSave(
                        initial.copy(name = name.trim(), aliases = split(aliases), address = address.trim()),
                    )
                }) { Text("儲存") }
            },
            dismissButton = {
                Row {
                    if (!isNew) TextButton(onClick = onDelete) { Text("刪除", color = Color(0xFFCF222E)) }
                    TextButton(onClick = onDismiss) { Text("取消") }
                }
            },
        )
    }

    @Composable
    private fun SecretDialog(onDismiss: () -> Unit) {
        var a by remember { mutableStateOf("") }
        var b by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text("設定密碼") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Hint("建議 4 到 6 位數字，執行受保護的指令時要用說的。")
                    Field("密碼", a, KeyboardType.Number) { a = it }
                    Field("再輸入一次", b, KeyboardType.Number) { b = it }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    when {
                        a.trim().length < 4 -> toast("至少 4 個字")
                        a.trim() != b.trim() -> toast("兩次輸入不一樣")
                        else -> {
                            Store.setSecret(this@MainActivity, a)
                            toast("密碼已設定")
                            refresh++
                            onDismiss()
                        }
                    }
                }) { Text("儲存") }
            },
            dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
        )
    }

    @Composable
    private fun LogDialog(onDismiss: () -> Unit) {
        var log by remember { mutableStateOf(Store.readLog(this).takeLast(30_000)) }
        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text("執行紀錄") },
            text = {
                Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState(), reverseScrolling = true)) {
                    Text(log.ifBlank { "目前沒有紀錄" }, fontSize = 12.sp, fontFamily = FontFamily.Monospace, lineHeight = 16.sp)
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    copy(log)
                    toast("紀錄已複製")
                }) { Text("複製") }
            },
            dismissButton = {
                Row {
                    TextButton(onClick = {
                        Store.clearLog(this@MainActivity)
                        log = ""
                    }) { Text("清除") }
                    TextButton(onClick = onDismiss) { Text("關閉") }
                }
            },
        )
    }

    @Composable
    private fun Field(label: String, value: String, keyboard: KeyboardType = KeyboardType.Text, onChange: (String) -> Unit) {
        OutlinedTextField(
            value = value, onValueChange = onChange, label = { Text(label) },
            singleLine = true, modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = keyboard),
        )
    }

    @Composable
    private fun Picker(label: String, current: String, options: List<String>, onPick: (Int) -> Unit) {
        var open by remember { mutableStateOf(false) }
        Column {
            Text(label, fontSize = 13.sp, color = Color(0xFF57606A))
            Box {
                OutlinedButton(onClick = { open = true }, modifier = Modifier.fillMaxWidth()) { Text(current) }
                DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                    options.forEachIndexed { i, o ->
                        DropdownMenuItem(text = { Text(o) }, onClick = { onPick(i); open = false })
                    }
                }
            }
        }
    }

    private fun split(s: String): List<String> =
        s.split('、', ',', '，', '\n').map { it.trim() }.filter { it.isNotEmpty() }.distinct()

    private fun copy(text: String) {
        (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
            .setPrimaryClip(ClipData.newPlainText("語音快捷", text))
    }

    private fun paste(): String =
        (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
            .primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString().orEmpty()
}
