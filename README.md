# CinemaRoom

在 Discord 語音頻道裡一起看影片和直播的 **Discord Activity（活動）**：

- **bilibili**：影片、直播，含彈幕
- **niconico**：影片、直播，含留言
- **YouTube 直播**：聊天室疊在畫面上（側邊欄，或切換成彈幕）

大家看到的是同一個畫面：誰都可以加入、跳過、暫停、拖進度，其他人會跟著同步。音量各自調整，不影響別人。

## 運作方式

```
Discord 語音頻道的「活動」
  └─ Activity 網頁（public/）── Discord 代理 ── 你的 HTTPS 網址 ── 這個伺服器（NUC）
                                                                  ├─ yt-dlp 抓影片／直播
                                                                  ├─ ffmpeg 切成 HLS（不重新編碼）
                                                                  └─ 抓彈幕／留言／聊天室，同步給大家
```

- 影片一律轉成 HLS 小片段（fMP4），每個人的 Discord 各自播放，伺服器只同步「播放／暫停／進度」，一般誤差在零點幾秒內。
- 優先抓 H.264＋AAC 的版本，所以只是重新封裝，NUC 的 CPU 負擔很小。
- 錄好的影片第一次播放要等幾秒準備；同一部影片之後再播（兩小時內）就直接用快取。
- 直播中斷會自動重連幾次，真的結束了才換下一個。

## 需要的東西

- 一台長時間開機的 Linux 主機（Debian／Ubuntu），例如家裡的 NUC
- 一個 **HTTPS 網址**指到它（Discord 只接受 https 的 Activity），例如 `watch.example.com`
- Node.js 22.12 以上、ffmpeg、yt-dlp（安裝腳本會處理）

## 1. Discord 開發者後台

在 [Discord Developer Portal](https://discord.com/developers/applications) 選你的應用程式（可以直接用 DJ Bot 那一個）：

1. **OAuth2**
   - 記下 **Client ID**，按 **Reset Secret** 拿到 **Client Secret**（只顯示一次）。
   - **Redirects** 加一個 `https://127.0.0.1`（Activity 用不到，但後台要求至少要有一個）。
2. **Activities → URL Mappings**
   - **Root Mapping**：`/` → 你的網址，**不要加 `https://`**，例如 `watch.example.com`
3. **Activities → Settings**
   - 打開 **Enable Activities**。
   - 支援的平台勾 Web／桌面版；手機版要用也一起勾。
4. 應用程式要已經加進你的伺服器（DJ Bot 那個應用本來就在）。

## 2. 安裝到伺服器

```sh
git clone https://github.com/Akiraoo/SimplePlayer-Discord-CinemaRoom.git
cd SimplePlayer-Discord-CinemaRoom
cp .env.example .env
nano .env        # 填 DISCORD_CLIENT_ID、DISCORD_CLIENT_SECRET
sudo sh deploy/install-debian.sh
```

安裝到 `/opt/cinemaroom`，以 `cinemaroom` 使用者跑成 systemd 服務 `cinemaroom`，預設只聽 `127.0.0.1:3090`。

```sh
journalctl -u cinemaroom -f      # 看紀錄
sudo systemctl restart cinemaroom
```

更新：`git pull` 之後再跑一次 `sudo sh deploy/install-debian.sh`（`.env` 和 cookie 會保留）。

### B 站需要 cookie

B 站目前要登入的 cookie，加上模擬瀏覽器才讀得到（和 DJ Bot 一樣）：

```sh
sudo cp ~/cookies.txt /opt/cinemaroom/cookies.txt
sudo chown cinemaroom:cinemaroom /opt/cinemaroom/cookies.txt
sudo chmod 600 /opt/cinemaroom/cookies.txt
```

`.env`：

```
YTDLP_COOKIES=/opt/cinemaroom/cookies.txt
YTDLP_ARGS=--impersonate chrome
```

niconico 的會員限定、高畫質影片也要登入：把 nicovideo.jp 的 cookie 一起匯出、貼進同一個 cookies.txt。niconico **直播的留言**刻意不用帳號連線（同一個帳號同時只能看一次，影片本身已經佔用了）。

## 3. HTTPS（反向代理）

把你的網址轉到 `127.0.0.1:3090`，**要支援 WebSocket**。Caddy 最簡單（自動申請憑證）：

```
watch.example.com {
    reverse_proxy 127.0.0.1:3090
}
```

nginx：

```nginx
server {
    listen 443 ssl;
    server_name watch.example.com;
    # ssl_certificate / ssl_certificate_key …

    location / {
        proxy_pass http://127.0.0.1:3090;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 1h;
        proxy_buffering off;
    }
}
```

## 使用

1. 進語音頻道 → 「活動」（火箭圖示）→ 選你的應用程式。
2. 第一次會要你授權（只拿名稱，用來顯示誰在看、誰加的影片）。
3. 右上角 ☰ 打開清單，貼上網址按「加入」。
4. 下方：播放／暫停、上一個／下一個、進度條、「彈」開關彈幕、音量。YouTube 直播時多一個按鈕，切換聊天室是「側邊」還是「彈幕」。

## 設定（.env）

| 名稱 | 說明 |
|---|---|
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | 開發者後台 OAuth2 的 ID 和 Secret |
| `HOST` / `PORT` | 聽哪裡，預設 `127.0.0.1:3090` |
| `YTDLP` / `FFMPEG` | 路徑（留白＝用系統裡的） |
| `YTDLP_COOKIES` | cookies.txt（Netscape 格式），B 站必要 |
| `YTDLP_ARGS` | 額外的 yt-dlp 參數，預設 `--impersonate chrome` |
| `CACHE_DIR` / `CACHE_MAX_GB` | 快取位置和上限（服務版固定在 `/var/cache/cinemaroom`） |
| `MAX_HEIGHT` | 最高畫質，預設 1080 |
| `MAX_QUEUE` | 每個房間的清單上限 |
| `ALLOWED_GUILDS` | 只允許這些伺服器使用（伺服器 ID，逗號分隔），留白＝不限 |

## 注意

- **只有瀏覽器能播的格式**：找不到 H.264 時會改抓其他格式（HEVC、AV1），有些裝置可能播不了。
- **頻寬**：每個觀眾各自從你的伺服器讀影片，上傳頻寬要夠（1080p 約 2～6 Mbps／人）。
- **cookie 會過期**：B 站突然讀不到，通常是 cookie 失效了，重新匯出換掉就好。
- 沒有在 Discord 裡開啟的話，頁面會提示要從「活動」開啟。

## 開發

```sh
npm install
npm test                      # 彈幕／留言解析的測試
DEV_TOKEN=test npm start      # 本機測試：http://127.0.0.1:3090/?dev=test&room=r1
npm run vendor                # 更新 public/vendor（Discord SDK、hls.js）
```

`DEV_TOKEN` 只用來在 Discord 外面測試，**正式環境不要設定**。

## 授權

Apache License 2.0。內附 [hls.js](https://github.com/video-dev/hls.js)（Apache 2.0）與 [Discord Embedded App SDK](https://github.com/discord/embedded-app-sdk)（MIT）。
