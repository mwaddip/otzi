#!/usr/bin/env bash
set -euo pipefail

# ── Constants ────────────────────────────────────────────────────────────────
REPO="mwaddip/otzi"
NODE_MIN="20"
GO_MIN="1.23"
IS_ROOT=$([[ $EUID -eq 0 ]] && echo true || echo false)

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

info()  { echo -e "${BLUE}::${NC} $*"; }
ok()    { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}!${NC} $*"; }
err()   { echo -e "${RED}✗${NC} $*" >&2; }
die()   { err "$@"; exit 1; }

# ── Argument parsing ────────────────────────────────────────────────────────
MODE="download"
YES=false
BACKEND_PORT=3100
DOMAIN=""

usage() {
  cat <<'EOF'
Usage: install.sh [OPTIONS]

Options:
  --build       Build from source instead of downloading a release
  --deps        Check and install build dependencies (Node 20, Go 1.23)
  --uninstall   Remove Ötzi Vault and its services
  --port PORT   Backend port (default: 3100)
  --domain NAME Domain name for web server config
  --yes, -y     Skip confirmation prompts
  --help, -h    Show this help

Examples:
  ./install.sh                                      # user-level install
  ./install.sh --domain vault.example.com           # with domain
  sudo ./install.sh --domain vault.example.com      # system-wide install
  ./install.sh --deps                               # check dependencies
  ./install.sh --build --port 9080                  # build from source
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --build)     MODE=build; shift ;;
    --deps)      MODE=deps; shift ;;
    --uninstall) MODE=uninstall; shift ;;
    --port)      BACKEND_PORT="$2"; shift 2 ;;
    --domain)    DOMAIN="$2"; shift 2 ;;
    --yes|-y)    YES=true; shift ;;
    --help|-h)   usage ;;
    *) die "Unknown option: $1 (use --help for usage)" ;;
  esac
done

# ── Paths (root vs user) ─────────────────────────────────────────────────
if $IS_ROOT; then
  INSTALL_DIR="/opt/otzi"
  DATA_DIR="/var/lib/otzi"
  SERVICE_USER="otzi"
else
  INSTALL_DIR="${HOME}/.otzi"
  DATA_DIR="${HOME}/.otzi/data"
  SERVICE_USER=""
fi

# ── Deferred root commands (collected when running without sudo) ──────────
ROOT_CMDS=()
add_root_cmd() { ROOT_CMDS+=("$1"); }

print_root_commands() {
  if [[ ${#ROOT_CMDS[@]} -eq 0 ]]; then return; fi
  echo ""
  warn "The following commands require root and were skipped:"
  echo ""
  for cmd in "${ROOT_CMDS[@]}"; do
    echo "  sudo $cmd"
  done
  echo ""
  info "Run them manually, or re-run this script with sudo for a fully automated install."
}

# ── Non-root disclaimer ──────────────────────────────────────────────────
if ! $IS_ROOT && [[ "$MODE" != "deps" ]] && [[ "$MODE" != "uninstall" ]]; then
  echo ""
  echo -e "${BOLD}Running without root${NC}"
  echo ""
  echo "  The following steps require root and will be skipped:"
  echo "  - Creating a system user (otzi)"
  echo "  - Installing systemd services (system-wide)"
  echo "  - Configuring nginx/apache reverse proxy"
  echo "  - Installing dependencies (--deps mode)"
  echo ""
  echo "  Files will be installed to: ${INSTALL_DIR}"
  echo "  Data directory: ${DATA_DIR}"
  echo "  User-level systemd services will be used if available."
  echo ""
  if ! $YES; then
    echo -en "${YELLOW}?${NC} Continue without root? [y/N] "
    read -r answer
    [[ "$answer" =~ ^[Yy]$ ]] || { info "Aborted. Re-run with sudo for full install."; exit 0; }
  fi
fi

# ── Distro detection ───────────────────────────────────────────────────────
DISTRO="unknown"
DISTRO_FAMILY="unknown"
PKG=""

detect_distro() {
  if [[ -f /etc/os-release ]]; then
    # shellcheck source=/dev/null
    . /etc/os-release
    case "${ID:-}" in
      ubuntu|debian|linuxmint|pop)
        DISTRO="$ID"; DISTRO_FAMILY="debian"; PKG="apt" ;;
      fedora)
        DISTRO="fedora"; DISTRO_FAMILY="rhel"; PKG="dnf" ;;
      centos|rhel|rocky|alma)
        DISTRO="$ID"; DISTRO_FAMILY="rhel"
        command -v dnf &>/dev/null && PKG="dnf" || PKG="yum" ;;
      arch|manjaro|endeavouros)
        DISTRO="$ID"; DISTRO_FAMILY="arch"; PKG="pacman" ;;
      alpine)
        DISTRO="alpine"; DISTRO_FAMILY="alpine"; PKG="apk" ;;
      *)
        DISTRO="${ID:-unknown}"; DISTRO_FAMILY="unknown" ;;
    esac
  fi
}

detect_distro

# ── Confirmation helper ────────────────────────────────────────────────────
confirm() {
  local msg="$1"
  if $YES; then return 0; fi
  echo -en "${YELLOW}?${NC} ${msg} [y/N] "
  read -r answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

# ── Version helpers ─────────────────────────────────────────────────────────
version_ge() {
  printf '%s\n%s\n' "$2" "$1" | sort -V -C
}

check_node() {
  if command -v node &>/dev/null; then
    local ver
    ver=$(node -v | sed 's/^v//')
    local major=${ver%%.*}
    if [[ $major -ge $NODE_MIN ]]; then
      ok "Node.js $ver (>= $NODE_MIN required)"
      return 0
    else
      warn "Node.js $ver found, but >= $NODE_MIN required"
      return 1
    fi
  else
    warn "Node.js not found"
    return 1
  fi
}

check_go() {
  if command -v go &>/dev/null; then
    local ver
    ver=$(go version | grep -oP '\d+\.\d+(\.\d+)?' | head -1)
    if version_ge "$ver" "$GO_MIN"; then
      ok "Go $ver (>= $GO_MIN required)"
      return 0
    else
      warn "Go $ver found, but >= $GO_MIN required"
      return 1
    fi
  else
    warn "Go not found"
    return 1
  fi
}

# ── Dependency installation ─────────────────────────────────────────────────
install_node() {
  if ! $IS_ROOT; then die "Installing Node.js requires root. Run: sudo $0 --deps"; fi
  info "Installing Node.js ${NODE_MIN}.x..."
  case $DISTRO_FAMILY in
    debian)
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN}.x" | bash -
      apt-get install -y nodejs ;;
    rhel)
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MIN}.x" | bash -
      $PKG install -y nodejs ;;
    arch)
      pacman -Sy --noconfirm nodejs npm ;;
    alpine)
      apk add --no-cache nodejs npm ;;
    *)
      die "Cannot auto-install Node.js on $DISTRO. Install Node.js $NODE_MIN+ manually." ;;
  esac
  ok "Node.js installed: $(node -v)"
}

install_go() {
  if ! $IS_ROOT; then die "Installing Go requires root. Run: sudo $0 --deps"; fi
  info "Installing Go ${GO_MIN}..."
  case $DISTRO_FAMILY in
    debian)
      apt-get update -qq
      apt-get install -y golang-go 2>/dev/null || {
        local gotar="go${GO_MIN}.linux-amd64.tar.gz"
        curl -fsSL "https://go.dev/dl/${gotar}" -o "/tmp/${gotar}"
        rm -rf /usr/local/go
        tar -C /usr/local -xzf "/tmp/${gotar}"
        ln -sf /usr/local/go/bin/go /usr/local/bin/go
        rm "/tmp/${gotar}"
      } ;;
    rhel)
      $PKG install -y golang ;;
    arch)
      pacman -Sy --noconfirm go ;;
    alpine)
      apk add --no-cache go ;;
    *)
      die "Cannot auto-install Go on $DISTRO. Install Go $GO_MIN+ manually." ;;
  esac
  ok "Go installed: $(go version)"
}

do_deps() {
  info "Checking build dependencies..."
  echo ""

  local need_node=false need_go=false
  check_node || need_node=true
  check_go   || need_go=true

  echo ""
  if ! $need_node && ! $need_go; then
    ok "All dependencies satisfied"
    return 0
  fi

  if ! $IS_ROOT; then
    warn "Installing dependencies requires root."
    echo ""
    $need_node && echo "  sudo $0 --deps   # or install Node.js $NODE_MIN+ manually"
    $need_go   && echo "  sudo $0 --deps   # or install Go $GO_MIN+ manually"
    echo ""
    return 1
  fi

  local actions=""
  $need_node && actions="${actions}  - Install Node.js ${NODE_MIN}.x via ${PKG:-system package manager}\n"
  $need_go   && actions="${actions}  - Install Go ${GO_MIN} via ${PKG:-system package manager}\n"

  echo -e "\nThe following will be installed:\n${actions}"
  confirm "Proceed?" || { info "Aborted."; exit 0; }

  $need_node && install_node
  $need_go   && install_go

  echo ""
  ok "Dependencies installed successfully"
}

# ── Architecture detection ──────────────────────────────────────────────────
detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) die "Unsupported architecture: $(uname -m)" ;;
  esac
}

# ── Download mode ───────────────────────────────────────────────────────────
do_download() {
  local arch
  arch=$(detect_arch)

  command -v curl &>/dev/null || die "curl is required. Install it first."
  command -v tar  &>/dev/null || die "tar is required. Install it first."
  command -v node &>/dev/null || die "Node.js is required. Run: $0 --deps"

  info "Fetching latest release from GitHub..."
  local tag
  tag=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
        | grep -oP '"tag_name":\s*"\K[^"]+')
  [[ -n "$tag" ]] || die "Could not determine latest release. Check https://github.com/${REPO}/releases"

  local version="${tag#v}"
  local tarball="otzi-${tag}-linux-${arch}.tar.gz"
  local url="https://github.com/${REPO}/releases/download/${tag}/${tarball}"

  info "Downloading ${tarball}..."
  local tmpdir
  tmpdir=$(mktemp -d)
  trap "rm -rf '$tmpdir'" EXIT

  curl -fsSL "$url" -o "${tmpdir}/${tarball}" || die "Download failed."
  info "Extracting to ${INSTALL_DIR}..."
  mkdir -p "$INSTALL_DIR"
  tar xzf "${tmpdir}/${tarball}" -C "$INSTALL_DIR"
  echo "$version" > "${INSTALL_DIR}/version.txt"

  ok "Ötzi ${version} installed to ${INSTALL_DIR}"
}

# ── Build mode ──────────────────────────────────────────────────────────────
do_build() {
  check_node || die "Node.js ${NODE_MIN}+ required. Run: $0 --deps"
  check_go   || die "Go ${GO_MIN}+ required. Run: $0 --deps"

  local repo_dir=""
  if [[ -f "package.json" ]] && grep -q '"otzi"' package.json 2>/dev/null; then
    repo_dir="$(pwd)"
    info "Building from source in ${repo_dir}..."
  else
    info "Source not found in current directory. Cloning from GitHub..."
    local tmpdir
    tmpdir=$(mktemp -d)
    git clone --depth 1 "https://github.com/${REPO}.git" "${tmpdir}/otzi"
    repo_dir="${tmpdir}/otzi"
    trap "rm -rf '$tmpdir'" EXIT
  fi

  info "Building frontend..."
  (cd "$repo_dir" && npm ci && npm run build)

  info "Building backend..."
  (cd "$repo_dir/backend" && npm ci && npx tsc)

  info "Building relay..."
  (cd "$repo_dir/relay" && CGO_ENABLED=0 go build -ldflags="-s -w" -o relay .)

  info "Installing to ${INSTALL_DIR}..."
  mkdir -p "$INSTALL_DIR"
  cp -r "$repo_dir/dist" "$INSTALL_DIR/dist"
  mkdir -p "$INSTALL_DIR/backend"
  cp -r "$repo_dir/backend/dist/"* "$INSTALL_DIR/backend/"
  cp -r "$repo_dir/backend/node_modules" "$INSTALL_DIR/backend/node_modules"
  cp "$repo_dir/relay/relay" "$INSTALL_DIR/relay"
  chmod +x "$INSTALL_DIR/relay"

  local version
  version=$(cd "$repo_dir" && git describe --tags --always 2>/dev/null || echo "source")
  echo "$version" > "${INSTALL_DIR}/version.txt"

  ok "Ötzi built and installed to ${INSTALL_DIR}"
}

# ── Service setup ───────────────────────────────────────────────────────────
setup_services() {
  # Check port availability
  if command -v ss &>/dev/null && ss -tlnp 2>/dev/null | grep -q ":${BACKEND_PORT} "; then
    warn "Port ${BACKEND_PORT} is already in use"
    if ! $YES; then
      echo -en "${YELLOW}?${NC} Choose a different port [${BACKEND_PORT}]: "
      read -r alt_port
      [[ -n "$alt_port" ]] && BACKEND_PORT="$alt_port"
    fi
  fi

  local relay_port=$((BACKEND_PORT + 1))
  local node_bin
  node_bin=$(command -v node)

  # Data directory
  mkdir -p "$DATA_DIR"

  if $IS_ROOT; then
    # ── System-wide setup ──

    # Create system user
    if ! id "$SERVICE_USER" &>/dev/null; then
      useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin \
              --create-home "$SERVICE_USER" 2>/dev/null || true
      ok "Created system user: ${SERVICE_USER}"
    fi
    chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

    # System-level systemd services
    cat > /etc/systemd/system/otzi-relay.service <<EOF
[Unit]
Description=Ötzi Relay
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
ExecStart=${INSTALL_DIR}/relay -addr :${relay_port}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

    cat > /etc/systemd/system/otzi.service <<EOF
[Unit]
Description=Ötzi Vault Backend
After=network.target otzi-relay.service
Requires=otzi-relay.service

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
Environment=NODE_ENV=production
Environment=PORT=${BACKEND_PORT}
Environment=RELAY_PORT=${relay_port}
Environment=DATA_DIR=${DATA_DIR}
ExecStart=${node_bin} backend/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable --now otzi-relay otzi
    ok "System services started"

  else
    # ── User-level setup ──

    local user_service_dir="${HOME}/.config/systemd/user"
    if command -v systemctl &>/dev/null && systemctl --user status &>/dev/null 2>&1; then
      mkdir -p "$user_service_dir"

      cat > "${user_service_dir}/otzi-relay.service" <<EOF
[Unit]
Description=Ötzi Relay

[Service]
Type=simple
ExecStart=${INSTALL_DIR}/relay -addr :${relay_port}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

      cat > "${user_service_dir}/otzi.service" <<EOF
[Unit]
Description=Ötzi Vault Backend
After=otzi-relay.service
Requires=otzi-relay.service

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
Environment=NODE_ENV=production
Environment=PORT=${BACKEND_PORT}
Environment=RELAY_PORT=${relay_port}
Environment=DATA_DIR=${DATA_DIR}
ExecStart=${node_bin} backend/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

      systemctl --user daemon-reload
      systemctl --user enable --now otzi-relay otzi
      ok "User services started"

      # Linger so services survive logout
      if ! loginctl show-user "$(whoami)" 2>/dev/null | grep -q "Linger=yes"; then
        add_root_cmd "loginctl enable-linger $(whoami)"
        warn "Services will stop on logout. Run the root command below to enable linger."
      fi
    else
      warn "User-level systemd not available."
      echo ""
      echo "  Start manually:"
      echo "    ${INSTALL_DIR}/relay -addr :${relay_port} &"
      echo "    PORT=${BACKEND_PORT} RELAY_PORT=${relay_port} DATA_DIR=${DATA_DIR} node ${INSTALL_DIR}/backend/server.js"
      echo ""
    fi
  fi

  info "Backend listening on http://localhost:${BACKEND_PORT}"

  # Health check
  local retries=5
  while [[ $retries -gt 0 ]]; do
    if curl -sf "http://localhost:${BACKEND_PORT}/api/status" &>/dev/null; then
      ok "Health check passed"
      break
    fi
    retries=$((retries - 1))
    sleep 2
  done
  [[ $retries -eq 0 ]] && warn "Health check failed — service may still be starting"

  # Write hosting seed
  if [[ -n "$DOMAIN" ]]; then
    local ssl=true
    [[ "$BACKEND_PORT" == "80" ]] && ssl=false
    cat > "${DATA_DIR}/hosting-seed.json" <<SEED
{"domain":"${DOMAIN}","port":443,"httpsEnabled":${ssl}}
SEED
    $IS_ROOT && chown "$SERVICE_USER:$SERVICE_USER" "${DATA_DIR}/hosting-seed.json"
    ok "Hosting config seeded: ${DOMAIN}"
  fi
}

# ── Web server configuration ───────────────────────────────────────────────
configure_webserver() {
  echo ""
  info "Detecting web server..."

  local server_name="${DOMAIN:-localhost}"

  # ── Nginx ──
  if command -v nginx &>/dev/null || pgrep -x nginx &>/dev/null; then
    ok "Nginx detected"

    # Determine config path
    local nginx_conf=""
    if [[ -d /etc/nginx/sites-available ]]; then
      nginx_conf="/etc/nginx/sites-available/otzi"
    elif [[ -d /etc/nginx/conf.d ]]; then
      nginx_conf="/etc/nginx/conf.d/otzi.conf"
    fi

    if [[ -z "$nginx_conf" ]]; then
      warn "Could not find nginx config directory (/etc/nginx/sites-available or /etc/nginx/conf.d)"
      echo ""
      echo "  Manually add this server block to your nginx config:"
      echo ""
      echo "  server {"
      echo "      listen 80;"
      echo "      server_name ${server_name};"
      echo "      location / {"
      echo "          proxy_pass http://127.0.0.1:${BACKEND_PORT};"
      echo "          proxy_http_version 1.1;"
      echo "          proxy_set_header Upgrade \$http_upgrade;"
      echo "          proxy_set_header Connection \"upgrade\";"
      echo "          proxy_set_header Host \$host;"
      echo "          proxy_read_timeout 3600s;
        proxy_buffering off;"
      echo "      }"
      echo "  }"
      echo ""
      return 0
    fi

    local nginx_config="server {
    listen 80;
    server_name ${server_name};

    location / {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \"upgrade\";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
        proxy_buffering off;
    }
}"

    if $IS_ROOT; then
      echo "$nginx_config" > "$nginx_conf"
      ok "Wrote ${nginx_conf}"

      if [[ -d /etc/nginx/sites-enabled ]] && [[ "$nginx_conf" == */sites-available/* ]]; then
        ln -sf "$nginx_conf" /etc/nginx/sites-enabled/otzi
      fi

      if nginx -t &>/dev/null 2>&1; then
        systemctl reload nginx 2>/dev/null && ok "Nginx reloaded" || warn "Failed to reload nginx"
      else
        warn "Nginx config test failed. Run: sudo nginx -t"
      fi
    else
      add_root_cmd "bash -c 'cat > ${nginx_conf} << '\\''CONF'\\''
${nginx_config}
CONF'"
      if [[ -d /etc/nginx/sites-enabled ]] && [[ "$nginx_conf" == */sites-available/* ]]; then
        add_root_cmd "ln -sf ${nginx_conf} /etc/nginx/sites-enabled/otzi"
      fi
      add_root_cmd "nginx -t && systemctl reload nginx"
      info "Nginx config prepared (requires root to write)"
    fi
    return 0
  fi

  # ── Apache ──
  local apache_cmd="" apache_svc=""
  if command -v apachectl &>/dev/null || pgrep -x apache2 &>/dev/null; then
    apache_cmd="apachectl"; apache_svc="apache2"
  elif command -v httpd &>/dev/null || pgrep -x httpd &>/dev/null; then
    apache_cmd="httpd"; apache_svc="httpd"
  fi

  if [[ -n "$apache_cmd" ]]; then
    ok "Apache detected (${apache_svc})"

    local apache_conf=""
    if [[ -d /etc/apache2/sites-available ]]; then
      apache_conf="/etc/apache2/sites-available/otzi.conf"
    elif [[ -d /etc/httpd/conf.d ]]; then
      apache_conf="/etc/httpd/conf.d/otzi.conf"
    fi

    if [[ -z "$apache_conf" ]]; then
      warn "Could not find Apache config directory"
      echo ""
      echo "  Manually add this VirtualHost to your Apache config:"
      echo ""
      echo "  <VirtualHost *:80>"
      echo "      ServerName ${server_name}"
      echo "      ProxyPreserveHost On"
      echo "      ProxyPass / http://127.0.0.1:${BACKEND_PORT}/"
      echo "      ProxyPassReverse / http://127.0.0.1:${BACKEND_PORT}/"
      echo "      RewriteEngine On"
      echo "      RewriteCond %{HTTP:Upgrade} =websocket [NC]"
      echo "      RewriteRule /(.*) ws://127.0.0.1:${BACKEND_PORT}/\$1 [P,L]"
      echo "  </VirtualHost>"
      echo ""
      return 0
    fi

    local apache_config="<VirtualHost *:80>
    ServerName ${server_name}
    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:${BACKEND_PORT}/
    ProxyPassReverse / http://127.0.0.1:${BACKEND_PORT}/

    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule /(.*) ws://127.0.0.1:${BACKEND_PORT}/\$1 [P,L]
</VirtualHost>"

    if $IS_ROOT; then
      echo "$apache_config" > "$apache_conf"
      ok "Wrote ${apache_conf}"

      if command -v a2enmod &>/dev/null; then
        a2enmod proxy proxy_http proxy_wstunnel rewrite &>/dev/null 2>&1 || true
        a2ensite otzi &>/dev/null 2>&1 || true
        ok "Enabled Apache modules and site"
      fi

      systemctl reload "$apache_svc" 2>/dev/null && ok "Apache reloaded" || warn "Failed to reload Apache"
    else
      add_root_cmd "bash -c 'echo \"${apache_config}\" > ${apache_conf}'"
      if command -v a2enmod &>/dev/null; then
        add_root_cmd "a2enmod proxy proxy_http proxy_wstunnel rewrite"
        add_root_cmd "a2ensite otzi"
      fi
      add_root_cmd "systemctl reload ${apache_svc}"
      info "Apache config prepared (requires root to write)"
    fi
    return 0
  fi

  # ── Neither ──
  echo ""
  warn "No web server detected (nginx or apache)"
  echo ""
  echo "  Ötzi is running on http://localhost:${BACKEND_PORT}"
  echo ""
  echo "  To expose on port 80/443, install nginx or apache and re-run this script."
  echo "  Manual proxy config: forward to http://127.0.0.1:${BACKEND_PORT}"
  echo "  WebSocket path: /ws (requires upgrade headers)"
  echo ""
}

# ── Uninstall ───────────────────────────────────────────────────────────────
do_uninstall() {
  info "Uninstalling Ötzi Vault..."
  echo ""

  confirm "This will stop services and remove ${INSTALL_DIR}. Continue?" || {
    info "Aborted."; exit 0
  }

  # Stop services
  if $IS_ROOT; then
    systemctl stop otzi otzi-relay 2>/dev/null || true
    systemctl disable otzi otzi-relay 2>/dev/null || true
    rm -f /etc/systemd/system/otzi.service /etc/systemd/system/otzi-relay.service
    systemctl daemon-reload
  else
    systemctl --user stop otzi otzi-relay 2>/dev/null || true
    systemctl --user disable otzi otzi-relay 2>/dev/null || true
    rm -f "${HOME}/.config/systemd/user/otzi.service" "${HOME}/.config/systemd/user/otzi-relay.service"
    systemctl --user daemon-reload 2>/dev/null || true
  fi
  ok "Removed services"

  # Remove install directory
  if [[ -d "$INSTALL_DIR" ]]; then
    rm -rf "$INSTALL_DIR"
    ok "Removed ${INSTALL_DIR}"
  fi

  # Remove web server configs (root only)
  if $IS_ROOT; then
    for f in /etc/nginx/sites-available/otzi /etc/nginx/sites-enabled/otzi \
             /etc/nginx/conf.d/otzi.conf \
             /etc/apache2/sites-available/otzi.conf /etc/httpd/conf.d/otzi.conf; do
      [[ -f "$f" ]] && rm -f "$f" && ok "Removed $f"
    done
    systemctl reload nginx 2>/dev/null || true
    systemctl reload apache2 2>/dev/null || systemctl reload httpd 2>/dev/null || true
    if id otzi &>/dev/null; then
      userdel otzi 2>/dev/null || true
      ok "Removed system user"
    fi
  fi

  echo ""
  ok "Ötzi uninstalled"
  echo ""
  warn "Data directory preserved: ${DATA_DIR}"
  echo "  To remove all data: rm -rf ${DATA_DIR}"
  echo ""
}

# ── Main ────────────────────────────────────────────────────────────────────
main() {
  echo ""
  echo -e "${BOLD}Ötzi Vault Installer${NC}"
  echo ""

  case $MODE in
    deps)
      do_deps
      ;;
    download)
      do_download
      setup_services
      configure_webserver
      print_root_commands
      echo ""
      ok "Installation complete!"
      ;;
    build)
      do_build
      setup_services
      configure_webserver
      print_root_commands
      echo ""
      ok "Installation complete!"
      ;;
    uninstall)
      do_uninstall
      ;;
  esac
}

main
