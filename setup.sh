#!/usr/bin/env bash
#
# TPC PANEL — one-shot VPS host setup
#   - Node 20 + MongoDB 7 + nginx + certbot + JDK 17
#   - app user, /opt/tpc-panel, .env, systemd (web + worker), nginx vhost
#   - duckdns IP update + Let's Encrypt TLS
#
# Usage:
#   sudo bash setup.sh
#   sudo DOMAIN=shadow-rat.duckdns.org LETSENCRYPT_EMAIL=me@x.com \
#        DUCKDNS_TOKEN=xxxx bash setup.sh
#
set -Eeuo pipefail

APP_NAME="tpc-panel"
APP_DIR="${APP_DIR:-/opt/${APP_NAME}}"
SERVICE_USER="${SERVICE_USER:-tpc}"
NODE_MAJOR="${NODE_MAJOR:-20}"
PORT="${PORT:-8000}"
WEB_WORKERS="${WEB_WORKERS:-2}"
MONGO_DB="${MONGO_DB:-tpc_panel}"

DOMAIN="${DOMAIN:-shadow-rat.duckdns.org}"
VPS_IP="${VPS_IP:-129.121.170.138}"
DUCKDNS_SUBDOMAIN="${DUCKDNS_SUBDOMAIN:-${DOMAIN%%.*}}"
DUCKDNS_TOKEN="${DUCKDNS_TOKEN:-}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-}"
ADMIN_USERNAME="${ADMIN_USERNAME:-ivan}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\033[1;32m[setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

trap 'die "line $LINENO pe fail hua"' ERR

[ "$(id -u)" = "0" ] || die "root chahiye: sudo bash setup.sh"
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

# --------------------------------------------------------------- preflight

[ -f "$SRC_DIR/package.json" ] || die "package.json nahi mila — repo root se chalao"
[ -f "$SRC_DIR/backend/server.js" ] || die "backend/server.js nahi mila"
[ -f "$SRC_DIR/backend/database.js" ] || die "backend/database.js nahi mila"

ARCH="$(dpkg --print-architecture)"
[ "$ARCH" = "amd64" ] || warn "arch=$ARCH — android sdk download amd64 ke liye hai"

# ------------------------------------------------------------ base packages

log "base packages"
apt-get update -y
apt-get install -y --no-install-recommends \
  curl ca-certificates gnupg unzip tar git rsync nginx openssl \
  jq ufw procps iproute2 \
  openjdk-17-jdk-headless

# ------------------------------------------------------------------ swap

if ! swapon --show 2>/dev/null | grep -q .; then
  log "2G swap bana rahe hain (gradle build ke liye)"
  if ! fallocate -l 2G /swapfile 2>/dev/null; then
    dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  fi
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10 >/dev/null
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
else
  log "swap already hai"
fi

# ------------------------------------------------------------------ node

need_node=1
if command -v node >/dev/null 2>&1; then
  cur="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  [ "$cur" -ge "$NODE_MAJOR" ] && need_node=0
fi
if [ "$need_node" = "1" ]; then
  log "node ${NODE_MAJOR} install"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
log "node $(node -v) · npm $(npm -v)"

# --------------------------------------------------------------- mongodb

if ! command -v mongod >/dev/null 2>&1; then
  log "mongodb 7 install"
  curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc \
    | gpg --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg

  CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
  write_repo() {
    echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu $1/mongodb-org/7.0 multiverse" \
      > /etc/apt/sources.list.d/mongodb-org-7.0.list
  }
  write_repo "$CODENAME"
  if ! apt-get update -y >/dev/null 2>&1; then
    warn "codename '$CODENAME' repo fail — jammy pe fallback"
    write_repo jammy
    apt-get update -y
  fi
  apt-get install -y mongodb-org
fi
systemctl enable --now mongod
sleep 3
systemctl is-active --quiet mongod || die "mongod start nahi hua"

# ------------------------------------------------------------------ user

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "user $SERVICE_USER bana rahe hain"
  useradd --system --create-home --shell /bin/bash "$SERVICE_USER"
fi
usermod -aG "$SERVICE_USER" www-data 2>/dev/null || true

# ------------------------------------------------------------------ files

log "files → $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude storage \
  --exclude .env \
  --exclude .session_secret \
  "$SRC_DIR/" "$APP_DIR/"

mkdir -p "$APP_DIR/storage"/{builds,keystores,gradle,.gradle}
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

# -------------------------------------------------------------------- env

if [ ! -f "$APP_DIR/.env" ]; then
  log ".env generate"
  SECRET="$(openssl rand -hex 32)"
  [ -n "$ADMIN_PASSWORD" ] || ADMIN_PASSWORD="$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-14)"

  cat > "$APP_DIR/.env" <<EOF
# ---- core ----
NODE_ENV=production
PORT=${PORT}
HOST=127.0.0.1
APP_VERSION=5.5.0
TRUST_PROXY=1
CLUSTER_PORT_SPREAD=1
WEB_CONCURRENCY=${WEB_WORKERS}

# ---- database ----
MONGO_URL=mongodb://127.0.0.1:27017
DB_NAME=${MONGO_DB}
DB_AUTODETECT=1
MONGO_POOL_SIZE=20
MONGO_MIN_POOL_SIZE=2
MONGO_SELECT_TIMEOUT_MS=15000
MONGO_WATCHDOG_MS=15000
MONGO_RETRIES=30
MONGO_RETRY_DELAY_MS=2000

# ---- session / auth ----
SESSION_SECRET=${SECRET}
COOKIE_NAME=tpc_session
COOKIE_SECURE=0
SESSION_MAX_AGE=2592000
ADMINS=${ADMIN_USERNAME}:${ADMIN_PASSWORD}

# ---- relay (panel ke Relay page se bhi set kar sakte ho) ----
TELE_API_ID=
TELE_API_HASH=
TARGET_CHANNEL_ID=
DEFAULT_FWD_USER=

# ---- builder ----
BUILDER_ENGINE=node
MAX_CONCURRENT_BUILDS=2
BUILD_POLL_MS=1500
BUILD_STALE_MS=3600000
BUILD_TIMEOUT_MS=2400000
DEFAULT_VARIANT=prod
DEFAULT_THEME=mono
REQUIRE_SIGNATURE=1
CLEAN_WORKDIR=0
AUTO_JDK=1
AUTO_SDK=1
AUTO_GRADLE=1
USE_DOCKER=0
GRADLE_BIN=
JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64

# ---- paths ----
STORAGE_ROOT=${APP_DIR}/storage
BUILD_ROOT=${APP_DIR}/storage/builds
KEYSTORE_DIR=${APP_DIR}/storage/keystores
GRADLE_ROOT=${APP_DIR}/storage/gradle
GRADLE_USER_HOME=${APP_DIR}/storage/.gradle
EOF

  # apk_template dhoondh ke TEMPLATE_DIR set karo
  TPL=""
  for c in "$APP_DIR/backend/apk_template" "$APP_DIR/apk_template"; do
    [ -d "$c" ] && TPL="$c" && break
  done
  if [ -n "$TPL" ]; then
    echo "TEMPLATE_DIR=${TPL}" >> "$APP_DIR/.env"
    log "template mila: $TPL"
  else
    warn "apk_template nahi mila — baad me .env me TEMPLATE_DIR set karo"
  fi

  chown "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  printf '%s\n' "$ADMIN_USERNAME" > "$APP_DIR/.admin_user"
  printf '%s\n' "$ADMIN_PASSWORD" > "$APP_DIR/.admin_pass"
  chmod 600 "$APP_DIR/.admin_user" "$APP_DIR/.admin_pass"
else
  log ".env already hai — chhed nahi kiya"
fi

# ------------------------------------------------------------------- npm

log "npm install (production)"
cd "$APP_DIR"
sudo -u "$SERVICE_USER" npm install --omit=dev --no-audit --no-fund
sudo -u "$SERVICE_USER" node -e 'require("./backend/database"); require("./backend/hub"); console.log("modules load OK")'

# -------------------------------------------------------------- systemd

log "systemd units"

cat > "/etc/systemd/system/${APP_NAME}-web.service" <<EOF
[Unit]
Description=${APP_NAME} web (HTTP + WS)
After=network-online.target mongod.service
Wants=mongod.service

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
Environment=NODE_ENV=production
Environment=CLUSTER_PORT_SPREAD=1
ExecStart=/usr/bin/node backend/server.js --workers ${WEB_WORKERS} --proxy-headers --host 127.0.0.1
Restart=always
RestartSec=3
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

cat > "/etc/systemd/system/${APP_NAME}-worker.service" <<EOF
[Unit]
Description=${APP_NAME} APK build worker
After=network-online.target mongod.service
Wants=mongod.service

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
Environment=NODE_ENV=production
Environment=BUILDER_WORKER_MODE=inline
ExecStart=/usr/bin/node backend/server.js --worker --no-listen
Restart=always
RestartSec=5
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# ---------------------------------------------------------------- nginx

log "nginx vhost"
UP=""
for i in $(seq 0 $((WEB_WORKERS - 1))); do
  UP="${UP}    server 127.0.0.1:$((PORT + i));\n"
done

printf "%b" "upstream ${APP_NAME}_up {\n    ip_hash;\n${UP}}\n\n" \
  > "/etc/nginx/sites-available/${APP_NAME}"

cat >> "/etc/nginx/sites-available/${APP_NAME}" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    client_max_body_size 60m;
    client_body_timeout 120s;

    access_log /var/log/nginx/${APP_NAME}.access.log;
    error_log  /var/log/nginx/${APP_NAME}.error.log;

    location = /favicon.ico { access_log off; log_not_found off; }

    location / {
        proxy_pass http://${APP_NAME}_up;
        proxy_http_version 1.1;

        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host \$host;

        proxy_connect_timeout 15s;
        proxy_send_timeout 3600s;
        proxy_read_timeout 3600s;
        proxy_buffering off;
        proxy_request_buffering off;
    }
}
EOF

rm -f /etc/nginx/sites-enabled/default
ln -sf "/etc/nginx/sites-available/${APP_NAME}" "/etc/nginx/sites-enabled/${APP_NAME}"
nginx -t
systemctl reload nginx

# -------------------------------------------------------------- duckdns

if [ -n "$DUCKDNS_TOKEN" ]; then
  log "duckdns IP update → ${VPS_IP}"
  resp="$(curl -fsS --max-time 20 \
    "https://www.duckdns.org/update?domains=${DUCKDNS_SUBDOMAIN}&token=${DUCKDNS_TOKEN}&ip=${VPS_IP}" || echo FAIL)"
  [ "$resp" = "OK" ] && log "duckdns OK" || warn "duckdns response: $resp"
else
  warn "DUCKDNS_TOKEN nahi diya — DNS manually check karo: dig +short ${DOMAIN}"
fi

# ------------------------------------------------------------------ tls

if [ -n "$LETSENCRYPT_EMAIL" ]; then
  log "letsencrypt TLS"
  apt-get install -y certbot python3-certbot-nginx
  if certbot --nginx -d "$DOMAIN" \
      --email "$LETSENCRYPT_EMAIL" --agree-tos --non-interactive --redirect --keep-until-expiring; then
    sed -i 's/^COOKIE_SECURE=.*/COOKIE_SECURE=1/' "$APP_DIR/.env"
    log "TLS laga — COOKIE_SECURE=1"
  else
    warn "certbot fail — 80 open hai? DNS resolve ho raha hai? baad me: certbot --nginx -d $DOMAIN"
  fi
else
  warn "LETSENCRYPT_EMAIL nahi diya — HTTP pe chalega (COOKIE_SECURE=0)"
fi

# ---------------------------------------------------------------- firewall

if ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow OpenSSH  >/dev/null 2>&1 || true
  ufw allow 80/tcp   >/dev/null 2>&1 || true
  ufw allow 443/tcp  >/dev/null 2>&1 || true
  log "ufw rules updated"
else
  warn "ufw inactive — chaho to: ufw allow OpenSSH && ufw allow 80,443/tcp && ufw --force enable"
fi

# ------------------------------------------------------------------ start

log "services start"
systemctl daemon-reload
systemctl enable --now "${APP_NAME}-web.service"
systemctl enable --now "${APP_NAME}-worker.service"

sleep 6

# --------------------------------------------------------------- verify

FAIL=0
for i in $(seq 1 20); do
  if curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/health/live" >/dev/null 2>&1; then
    break
  fi
  [ "$i" = "20" ] && FAIL=1
  sleep 1
done

echo
if [ "$FAIL" = "1" ]; then
  warn "web health fail — logs:"
  journalctl -u "${APP_NAME}-web" -n 40 --no-pager || true
else
  log "health: $(curl -fsS "http://127.0.0.1:${PORT}/health" | jq -c '{status,db:.db.ready,devices_online}' 2>/dev/null || echo ok)"
fi

if [ -f "$APP_DIR/.admin_pass" ]; then
  ADMIN_U="$(cat "$APP_DIR/.admin_user")"
  ADMIN_P="$(cat "$APP_DIR/.admin_pass")"
else
  ADMIN_U="$ADMIN_USERNAME"; ADMIN_P="(dekho $APP_DIR/.env)"
fi

SCHEME="http"
[ -n "$LETSENCRYPT_EMAIL" ] && SCHEME="https"

cat <<EOF

============================================================
 TPC PANEL READY
============================================================
 URL       : ${SCHEME}://${DOMAIN}/admin
 Local     : http://127.0.0.1:${PORT}/health
 Admin     : ${ADMIN_U} / ${ADMIN_P}
 Cred file : ${APP_DIR}/.admin_pass

 Services  : systemctl status ${APP_NAME}-web
             systemctl status ${APP_NAME}-worker
 Logs      : journalctl -u ${APP_NAME}-web -f
 Restart   : systemctl restart ${APP_NAME}-web ${APP_NAME}-worker
 DB        : mongosh ${MONGO_DB} --eval 'db.devices.countDocuments()'

 Relay setup: ${SCHEME}://${DOMAIN}/admin  ->  Relay page
              (TELE_API_ID / TELE_API_HASH daalo, phone verify karo)
============================================================
EOF