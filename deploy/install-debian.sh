#!/bin/sh
# Installs (or updates) CinemaRoom as a systemd service on Debian / Ubuntu.
# Run as root from the project folder:  sudo sh deploy/install-debian.sh
set -eu
export DEBIAN_FRONTEND=noninteractive

APP=/opt/cinemaroom
SRC=$(cd "$(dirname "$0")/.." && pwd)

[ "$(id -u)" = 0 ] || { echo "請用 root 執行（sudo sh deploy/install-debian.sh）"; exit 1; }

echo "== 套件：ffmpeg、curl"
apt-get update
apt-get install -y ffmpeg curl ca-certificates

need_node=1
if command -v node >/dev/null 2>&1; then
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' && need_node=0
fi
if [ $need_node = 1 ]; then
  echo "== 安裝 Node.js 24（NodeSource）"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
echo "   node $(node -v)"

# the same yt-dlp the DJ bot uses (its timer keeps it up to date); installed if missing
if ! /usr/local/bin/yt-dlp --version >/dev/null 2>&1; then
  echo "== 安裝 yt-dlp"
  curl -fL --progress-bar -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
  chmod 755 /usr/local/bin/yt-dlp
fi
echo "   yt-dlp $(/usr/local/bin/yt-dlp --version)"

echo "== 使用者 cinemaroom"
id cinemaroom >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin cinemaroom

echo "== 複製程式到 $APP"
mkdir -p "$APP"
if [ "$SRC" != "$APP" ]; then
  for f in package.json package-lock.json README.md LICENSE .env.example; do
    [ -f "$SRC/$f" ] && cp "$SRC/$f" "$APP/"
  done
  rm -rf "$APP/src" "$APP/public" "$APP/deploy"
  cp -r "$SRC/src" "$SRC/public" "$SRC/deploy" "$APP/"
  if [ -f "$SRC/.env" ]; then cp "$SRC/.env" "$APP/.env"; fi
fi
[ -f "$APP/.env" ] || { cp "$APP/.env.example" "$APP/.env"; echo "   已建立 $APP/.env，請填好再啟動"; }
sed -i 's/\r$//' "$APP/.env"
# the cache folder is the service's own (/var/cache/cinemaroom), not ./cache
sed -i 's#^CACHE_DIR=\./cache$#CACHE_DIR=#' "$APP/.env"

echo "== npm install"
cd "$APP"
npm ci --omit=dev --no-audit --no-fund
chown -R cinemaroom:cinemaroom "$APP"
chmod 600 "$APP/.env"
[ -f "$APP/cookies.txt" ] && chmod 600 "$APP/cookies.txt"

echo "== systemd"
install -m 644 deploy/cinemaroom.service /etc/systemd/system/cinemaroom.service
systemctl daemon-reload
systemctl enable cinemaroom >/dev/null
systemctl restart cinemaroom

sleep 2
systemctl --no-pager --lines=10 status cinemaroom || true
echo
echo "完成。看紀錄：journalctl -u cinemaroom -f    重開：systemctl restart cinemaroom"
