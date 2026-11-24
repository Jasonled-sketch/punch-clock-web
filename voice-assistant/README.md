# 語音快捷（安卓語音指令 App）

長按側鍵或點桌面圖示 → 說指令 → 直接執行。只在「自己的指令、聯絡人、手機裡的 App」中挑最像的一個，
並用讀音比對，所以語音辨識聽成同音字時仍然對得上。

## 能做的事

| 說法 | 動作 |
|---|---|
| 「用賴打給小關」「打給小關」 | 開 LINE、搜尋好友、按語音通話（需開啟無障礙服務） |
| 「打電話給小關」 | 直接撥電話 |
| 「開鐵門」 | 呼叫設定好的網址（易微聯 Webhook 等），可設兩段式確認或口說密碼 |
| 「打開相機」「打開賴」 | 開啟 App |

所有設定（聯絡人、指令、密碼）只存在手機本機，不在這個 repo 裡。

## 結構

- `core/`：純 Kotlin 的比對邏輯（拼音化、模糊比對、確定／取消、口說密碼），有單元測試
- `assist/`：聆聽畫面、預設數位助理的接口、快速面板按鈕
- `line/`：代替手指操作 LINE 的無障礙服務
- `actions/`：實際執行動作
- `ui/`：設定頁

## 打包

需要 JDK 17 以上與 Android SDK（platform 35、build-tools 35）。

呼喊喚醒用的中文語音模型很大（約 66MB），不進版控。打包前先下載解壓到 assets：

```bash
curl -L -o /tmp/vosk-cn.zip https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip
unzip -q /tmp/vosk-cn.zip -d /tmp
mkdir -p app/src/main/assets/vosk-model-small-cn
cp -r /tmp/vosk-model-small-cn-0.22/. app/src/main/assets/vosk-model-small-cn/
```

模型與引擎（Vosk）都是 Apache-2.0，不用帳號、不用金鑰。

```bash
echo "sdk.dir=/path/to/android-sdk" > local.properties
gradle :app:testDebugUnitTest   # 比對邏輯測試
gradle :app:assembleRelease     # 產出 app/build/outputs/apk/release/app-release.apk
```

簽章金鑰不進版控。要讓新版能直接覆蓋安裝舊版，請在本資料夾放 `keystore.properties`
（`storeFile`、`storePassword`、`keyAlias`、`keyPassword`）並每次用同一把金鑰；沒有這個檔就會用 debug 金鑰簽。
