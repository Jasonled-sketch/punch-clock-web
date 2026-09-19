# Traccar 設定（路線 B）

定位器連進 Traccar，Traccar 把位置轉發給 `../src/traccar.js`，後面流程跟路線 A 完全一樣。

## 一、改兩個地方

編輯 `traccar.xml`：

1. `forward.url` 換成你的服務網址，結尾要是 `/traccar/position`
2. `forward.header` 冒號後面換成一組隨機密碼

同一組密碼填進接收服務的 `TRACCAR_INGEST_TOKEN`。兩邊不一致會被拒收，服務 log 會寫「X-Ingest-Token 不符」。

產生密碼：

```bash
openssl rand -hex 24
```

## 二、跑起來

### 自己的主機或 VPS

```bash
cd gps/traccar
docker compose up -d
```

開 `http://你的IP:8082`，預設帳密 `admin` / `admin`，**第一次登入立刻改掉**。

### Railway

1. 新建 service，選 Docker image，填 `traccar/traccar:latest`
2. **掛 Volume** 到 `/opt/traccar/data`。不掛的話每次重新部署，所有裝置設定和歷史軌跡都會消失
3. Settings → Networking：
   - 加一個 Domain，Target Port 填 `8082`（管理介面）
   - 再開 TCP Proxy，Target Port 填 `5023`（定位器連這個）
   - 這兩個可以同時存在，Railway 支援一個 service 同時有 Domain 和 TCP Proxy
4. Railway 會給你一組像 `shuttle.proxy.rlwy.net:15140` 的位址。**定位器要連的是這組，不是 5023。**
   5023 是容器內部的埠，外面看到的是 Railway 分配的那個號碼
5. `traccar.xml` 在 Railway 上沒辦法直接掛檔案，改用環境變數覆蓋（Traccar 支援 `CONFIG_USE_ENVIRONMENT_VARIABLES=true`），或自己包一層 Dockerfile 把 xml COPY 進去

## 三、把定位器指過來

在 Traccar 後台先新增裝置：Settings → Devices → 新增，**Identifier 填 IMEI**，**Name 填車牌**。
服務會直接把 Name 當車牌寫進 Ragic。

然後發簡訊給定位器的門號（指令因廠牌而異，向賣家索取正確格式）：

```
SERVER,1,shuttle.proxy.rlwy.net,15140,0#
```

自架主機的話就填你的網域和 5023。

## 四、確認資料有進來

1. Traccar 後台看得到車子的點 → 定位器到 Traccar 這段通了
2. 接收服務的 log 有訊息 → 轉發這段通了
3. Ragic 長出記錄 → 全線通了

卡在第 2 步最常見的原因：`forward.type` 沒設成 `json`（預設是 url，我們的服務讀不到），
或是 token 兩邊不一致。

## 五、注意事項

**速度單位是節。**
Traccar 內部一律用節，1 節 = 1.852 公里。接收服務預設會自動換算。
只有在你改過 Traccar 設定讓它送公里時，才把服務的 `TRACCAR_SPEED_UNIT` 設成 `kmh`。

**H2 資料庫只適合小車隊。**
超過二三十台車或要留長期軌跡，換成 PostgreSQL。Traccar 支援，改 `database.*` 四行即可。

**5023 埠是對全世界開的。**
任何人知道你的位址和一組 IMEI 就能灌假位置進 Traccar。這是 GT06 協定本身沒有驗證機制的問題，
不是設定錯誤。在意的話用 Railway 的 TCP Proxy（位址不好猜）或防火牆限制來源 IP。
