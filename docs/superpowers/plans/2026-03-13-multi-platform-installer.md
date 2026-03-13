# Multi-Platform Installer Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable 1-command deployment of PERMAFROST Vault on bare Linux, Docker, and Windows without Docker.

**Architecture:** A single `install.sh` bash script handles all Linux deployment modes (download pre-built, build from source, install deps, uninstall). A GitHub Actions workflow produces release tarballs on tagged pushes. A `start.bat` covers Windows. The README is updated with platform-specific oneliners.

**Tech Stack:** Bash, GitHub Actions, systemd, nginx/apache config generation

---

## Chunk 1: install.sh

### Task 1: Script skeleton and argument parsing

**Files:**
- Create: `install.sh`

- [ ] **Step 1: Create install.sh with constants, colors, argument parsing, distro detection**

```bash
#!/usr/bin/env bash
set -euo pipefail

# ── Constants ────────────────────────────────────────────────────────────────
REPO="mwaddip/otzi"
INSTALL_DIR="/opt/permafrost"
DATA_DIR="/var/lib/permafrost"
SERVICE_USER="permafrost"
NODE_MIN="20"
GO_MIN="1.23"

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

usage() {
  cat <<'EOF'
Usage: install.sh [OPTIONS]

Options:
  --build       Build from source instead of downloading a release
  --deps        Check and install build dependencies (Node 20, Go 1.23)
  --uninstall   Remove PERMAFROST Vault and its services
  --yes, -y     Skip confirmation prompts
  --help, -h    Show this help

Examples:
  curl -sL https://github.com/mwaddip/otzi/releases/latest/download/install.sh | sudo bash
  sudo ./install.sh --deps && sudo ./install.sh --build
  sudo ./install.sh --uninstall
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --build)     MODE=build; shift ;;
    --deps)      MODE=deps; shift ;;
    --uninstall) MODE=uninstall; shift ;;
    --yes|-y)    YES=true; shift ;;
    --help|-h)   usage ;;
    *) die "Unknown option: $1 (use --help for usage)" ;;
  esac
done

# ── Root check ──────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "This script must be run as root (use sudo)"

# ── Distro detection ───────────────────────────────────────────────────────
DISTRO="unknown"
DISTRO_FAMILY="unknown"
PKG=""

detect_distro() {
  if [[ -f /etc/os-release ]]; then
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
```

- [ ] **Step 2: Verify script parses without error**

Run: `bash -n install.sh`
Expected: No output (clean parse)

- [ ] **Step 3: Commit**

```bash
git add install.sh
git commit -m "feat: install.sh skeleton with arg parsing and distro detection"
```

---

### Task 2: Version checking and dependency installation (`--deps`)

**Files:**
- Modify: `install.sh`

- [ ] **Step 1: Add version checking functions**

Append after the `confirm()` function:

```bash
# ── Version helpers ─────────────────────────────────────────────────────────
version_ge() {
  # Returns 0 if $1 >= $2 (dotted version comparison)
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
```

- [ ] **Step 2: Add dependency installation function**

Append after the version helpers:

```bash
# ── Dependency installation ─────────────────────────────────────────────────
install_node() {
  info "Installing Node.js ${NODE_MIN}.x..."
  case $DISTRO_FAMILY in
    debian)
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN}.x" | bash -
      apt-get install -y nodejs
      ;;
    rhel)
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MIN}.x" | bash -
      $PKG install -y nodejs
      ;;
    arch)
      pacman -Sy --noconfirm nodejs npm
      ;;
    alpine)
      apk add --no-cache nodejs npm
      ;;
    *)
      die "Cannot auto-install Node.js on $DISTRO. Install Node.js $NODE_MIN+ manually."
      ;;
  esac
  ok "Node.js installed: $(node -v)"
}

install_go() {
  info "Installing Go ${GO_MIN}..."
  case $DISTRO_FAMILY in
    debian)
      apt-get update -qq
      apt-get install -y golang-go 2>/dev/null || {
        # If repo version is too old, use the official tarball
        local gotar="go${GO_MIN}.linux-amd64.tar.gz"
        curl -fsSL "https://go.dev/dl/${gotar}" -o "/tmp/${gotar}"
        rm -rf /usr/local/go
        tar -C /usr/local -xzf "/tmp/${gotar}"
        ln -sf /usr/local/go/bin/go /usr/local/bin/go
        rm "/tmp/${gotar}"
      }
      ;;
    rhel)
      $PKG install -y golang
      ;;
    arch)
      pacman -Sy --noconfirm go
      ;;
    alpine)
      apk add --no-cache go
      ;;
    *)
      die "Cannot auto-install Go on $DISTRO. Install Go $GO_MIN+ manually."
      ;;
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
```

- [ ] **Step 3: Verify script parses**

Run: `bash -n install.sh`
Expected: No output

- [ ] **Step 4: Commit**

```bash
git add install.sh
git commit -m "feat: install.sh --deps mode for Node/Go installation"
```

---

### Task 3: Download mode (default)

**Files:**
- Modify: `install.sh`

- [ ] **Step 1: Add architecture detection and download function**

Append after `do_deps()`:

```bash
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

  # Check for required tools
  command -v curl &>/dev/null || die "curl is required. Install it first."
  command -v tar  &>/dev/null || die "tar is required. Install it first."
  command -v node &>/dev/null || die "Node.js is required to run the backend. Run: sudo $0 --deps"

  info "Fetching latest release from GitHub..."
  local tag
  tag=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
        | grep -oP '"tag_name":\s*"\K[^"]+')
  [[ -n "$tag" ]] || die "Could not determine latest release. Check https://github.com/${REPO}/releases"

  local version="${tag#v}"
  local tarball="permafrost-${tag}-linux-${arch}.tar.gz"
  local url="https://github.com/${REPO}/releases/download/${tag}/${tarball}"

  info "Downloading ${tarball}..."
  local tmpdir
  tmpdir=$(mktemp -d)
  trap "rm -rf '$tmpdir'" EXIT

  curl -fsSL "$url" -o "${tmpdir}/${tarball}" || die "Download failed. Does the release exist?"
  info "Extracting to ${INSTALL_DIR}..."
  mkdir -p "$INSTALL_DIR"
  tar xzf "${tmpdir}/${tarball}" -C "$INSTALL_DIR"
  echo "$version" > "${INSTALL_DIR}/version.txt"

  ok "PERMAFROST ${version} installed to ${INSTALL_DIR}"
}
```

- [ ] **Step 2: Verify script parses**

Run: `bash -n install.sh`

- [ ] **Step 3: Commit**

```bash
git add install.sh
git commit -m "feat: install.sh download mode — fetch pre-built release"
```

---

### Task 4: Build mode (`--build`)

**Files:**
- Modify: `install.sh`

- [ ] **Step 1: Add build-from-source function**

Append after `do_download()`:

```bash
# ── Build mode ──────────────────────────────────────────────────────────────
do_build() {
  check_node || die "Node.js ${NODE_MIN}+ required. Run: sudo $0 --deps"
  check_go   || die "Go ${GO_MIN}+ required. Run: sudo $0 --deps"

  # Detect repo root — either CWD or need to clone
  local repo_dir=""
  if [[ -f "package.json" ]] && grep -q '"opnet-permafrost"' package.json 2>/dev/null; then
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

  # Write version from git tag or package.json
  local version
  version=$(cd "$repo_dir" && git describe --tags --always 2>/dev/null || echo "source")
  echo "$version" > "${INSTALL_DIR}/version.txt"

  ok "PERMAFROST built and installed to ${INSTALL_DIR}"
}
```

- [ ] **Step 2: Verify script parses**

Run: `bash -n install.sh`

- [ ] **Step 3: Commit**

```bash
git add install.sh
git commit -m "feat: install.sh --build mode — build from source"
```

---

### Task 5: Systemd service setup

**Files:**
- Modify: `install.sh`

- [ ] **Step 1: Add service setup function**

Append after `do_build()`:

```bash
# ── Service setup ───────────────────────────────────────────────────────────
setup_services() {
  # Create system user
  if ! id "$SERVICE_USER" &>/dev/null; then
    useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin \
            --create-home "$SERVICE_USER" 2>/dev/null || true
    ok "Created system user: ${SERVICE_USER}"
  else
    ok "System user ${SERVICE_USER} already exists"
  fi

  # Data directory
  mkdir -p "$DATA_DIR"
  chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
  ok "Data directory: ${DATA_DIR}"

  # Find node binary path
  local node_bin
  node_bin=$(command -v node)

  # Relay service
  cat > /etc/systemd/system/permafrost-relay.service <<EOF
[Unit]
Description=PERMAFROST Relay
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
ExecStart=${INSTALL_DIR}/relay -addr :8081
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  # Backend service
  cat > /etc/systemd/system/permafrost.service <<EOF
[Unit]
Description=PERMAFROST Vault Backend
After=network.target permafrost-relay.service
Requires=permafrost-relay.service

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
Environment=NODE_ENV=production
Environment=PORT=8080
Environment=RELAY_PORT=8081
Environment=DATA_DIR=${DATA_DIR}
ExecStart=${node_bin} backend/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now permafrost-relay permafrost

  ok "Services started: permafrost-relay, permafrost"
  info "Backend listening on http://localhost:8080"
}
```

- [ ] **Step 2: Verify script parses**

Run: `bash -n install.sh`

- [ ] **Step 3: Commit**

```bash
git add install.sh
git commit -m "feat: install.sh systemd service setup"
```

---

### Task 6: Web server detection and configuration

**Files:**
- Modify: `install.sh`

- [ ] **Step 1: Add web server configuration function**

Append after `setup_services()`:

```bash
# ── Web server configuration ───────────────────────────────────────────────
configure_webserver() {
  echo ""
  info "Detecting web server..."

  # ── Nginx ──
  if command -v nginx &>/dev/null; then
    ok "Nginx detected"

    local nginx_conf=""
    if [[ -d /etc/nginx/sites-available ]]; then
      nginx_conf="/etc/nginx/sites-available/permafrost"
    elif [[ -d /etc/nginx/conf.d ]]; then
      nginx_conf="/etc/nginx/conf.d/permafrost.conf"
    else
      warn "Nginx config directory not found, skipping"
      return 0
    fi

    cat > "$nginx_conf" <<'NGINX'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
    }
}
NGINX
    ok "Wrote ${nginx_conf}"

    # Symlink if using sites-available/sites-enabled pattern
    if [[ -d /etc/nginx/sites-enabled ]] && [[ "$nginx_conf" == */sites-available/* ]]; then
      ln -sf "$nginx_conf" /etc/nginx/sites-enabled/permafrost

      # Remove default site if it would conflict
      if [[ -L /etc/nginx/sites-enabled/default ]]; then
        rm /etc/nginx/sites-enabled/default
        info "Removed default nginx site (was conflicting on port 80)"
      fi
    fi

    if nginx -t &>/dev/null; then
      systemctl reload nginx
      ok "Nginx reloaded — PERMAFROST available on http://localhost"
    else
      warn "Nginx config test failed. Check: nginx -t"
    fi
    return 0
  fi

  # ── Apache ──
  local apache_cmd=""
  local apache_svc=""
  if command -v apachectl &>/dev/null; then
    apache_cmd="apachectl"
    apache_svc="apache2"
  elif command -v httpd &>/dev/null; then
    apache_cmd="httpd"
    apache_svc="httpd"
  fi

  if [[ -n "$apache_cmd" ]]; then
    ok "Apache detected (${apache_cmd})"

    local apache_conf=""
    if [[ -d /etc/apache2/sites-available ]]; then
      apache_conf="/etc/apache2/sites-available/permafrost.conf"
    elif [[ -d /etc/httpd/conf.d ]]; then
      apache_conf="/etc/httpd/conf.d/permafrost.conf"
    else
      warn "Apache config directory not found, skipping"
      return 0
    fi

    cat > "$apache_conf" <<'APACHE'
<VirtualHost *:80>
    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:8080/
    ProxyPassReverse / http://127.0.0.1:8080/

    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule /(.*) ws://127.0.0.1:8080/$1 [P,L]
</VirtualHost>
APACHE
    ok "Wrote ${apache_conf}"

    # Enable required modules (Debian/Ubuntu style)
    if command -v a2enmod &>/dev/null; then
      a2enmod proxy proxy_http proxy_wstunnel rewrite &>/dev/null
      a2ensite permafrost &>/dev/null
      # Disable default site if it conflicts
      a2dissite 000-default &>/dev/null || true
      ok "Enabled Apache modules and site"
    fi

    systemctl reload "$apache_svc" 2>/dev/null || true
    ok "Apache reloaded — PERMAFROST available on http://localhost"
    return 0
  fi

  # ── Neither ──
  echo ""
  warn "No web server detected (nginx or apache)"
  echo ""
  echo "  PERMAFROST is running on http://localhost:8080"
  echo ""
  echo "  To expose on port 80/443, install nginx or apache and re-run this script,"
  echo "  or use the Docker image which includes Caddy:"
  echo ""
  echo "    docker run -d -p 80:80 -v permafrost-data:/data ghcr.io/${REPO}:latest"
  echo ""
  echo "  Manual proxy config: forward to http://127.0.0.1:8080"
  echo "  WebSocket path: /ws (requires upgrade headers)"
  echo ""
}
```

- [ ] **Step 2: Verify script parses**

Run: `bash -n install.sh`

- [ ] **Step 3: Commit**

```bash
git add install.sh
git commit -m "feat: install.sh nginx/apache auto-detection and config"
```

---

### Task 7: Uninstall mode and main entrypoint

**Files:**
- Modify: `install.sh`

- [ ] **Step 1: Add uninstall function and main entrypoint**

Append after `configure_webserver()`:

```bash
# ── Uninstall ───────────────────────────────────────────────────────────────
do_uninstall() {
  info "Uninstalling PERMAFROST Vault..."
  echo ""

  confirm "This will stop services and remove ${INSTALL_DIR}. Continue?" || {
    info "Aborted."
    exit 0
  }

  # Stop and disable services
  if systemctl is-active --quiet permafrost 2>/dev/null; then
    systemctl stop permafrost
    ok "Stopped permafrost service"
  fi
  if systemctl is-active --quiet permafrost-relay 2>/dev/null; then
    systemctl stop permafrost-relay
    ok "Stopped permafrost-relay service"
  fi

  systemctl disable permafrost permafrost-relay 2>/dev/null || true
  rm -f /etc/systemd/system/permafrost.service
  rm -f /etc/systemd/system/permafrost-relay.service
  systemctl daemon-reload
  ok "Removed systemd services"

  # Remove install directory
  if [[ -d "$INSTALL_DIR" ]]; then
    rm -rf "$INSTALL_DIR"
    ok "Removed ${INSTALL_DIR}"
  fi

  # Remove web server configs
  local removed_web=false
  if [[ -f /etc/nginx/sites-available/permafrost ]]; then
    rm -f /etc/nginx/sites-enabled/permafrost
    rm -f /etc/nginx/sites-available/permafrost
    systemctl reload nginx 2>/dev/null || true
    ok "Removed nginx config"
    removed_web=true
  fi
  if [[ -f /etc/nginx/conf.d/permafrost.conf ]]; then
    rm -f /etc/nginx/conf.d/permafrost.conf
    systemctl reload nginx 2>/dev/null || true
    ok "Removed nginx config"
    removed_web=true
  fi
  if [[ -f /etc/apache2/sites-available/permafrost.conf ]]; then
    a2dissite permafrost 2>/dev/null || true
    rm -f /etc/apache2/sites-available/permafrost.conf
    systemctl reload apache2 2>/dev/null || true
    ok "Removed apache config"
    removed_web=true
  fi
  if [[ -f /etc/httpd/conf.d/permafrost.conf ]]; then
    rm -f /etc/httpd/conf.d/permafrost.conf
    systemctl reload httpd 2>/dev/null || true
    ok "Removed apache config"
    removed_web=true
  fi

  # Remove system user
  if id "$SERVICE_USER" &>/dev/null; then
    userdel "$SERVICE_USER" 2>/dev/null || true
    ok "Removed system user: ${SERVICE_USER}"
  fi

  echo ""
  ok "PERMAFROST uninstalled"
  echo ""
  warn "Data directory preserved: ${DATA_DIR}"
  echo "  To remove all data: sudo rm -rf ${DATA_DIR}"
  echo ""
}

# ── Main ────────────────────────────────────────────────────────────────────
main() {
  echo ""
  echo -e "${BOLD}PERMAFROST Vault Installer${NC}"
  echo ""

  case $MODE in
    deps)
      do_deps
      ;;
    download)
      do_download
      setup_services
      configure_webserver
      echo ""
      ok "Installation complete!"
      ;;
    build)
      do_build
      setup_services
      configure_webserver
      echo ""
      ok "Installation complete!"
      ;;
    uninstall)
      do_uninstall
      ;;
  esac
}

main
```

- [ ] **Step 2: Mark script executable and verify it parses**

Run: `chmod +x install.sh && bash -n install.sh`
Expected: No output

- [ ] **Step 3: Commit**

```bash
git add install.sh
git commit -m "feat: install.sh uninstall mode and main entrypoint"
```

---

## Chunk 2: Windows launcher, GitHub Actions, and README

### Task 8: Windows launcher

**Files:**
- Create: `start.bat`

- [ ] **Step 1: Create start.bat**

```batch
@echo off
title PERMAFROST Vault
echo.
echo   PERMAFROST Vault
echo   ────────────────
echo.

where node >nul 2>&1 || (
    echo   ERROR: Node.js is not installed or not in PATH.
    echo   Download it from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo   Starting relay...
start /B relay.exe -addr :8081

echo   Starting backend on http://localhost:8080
echo.
echo   Open http://localhost:8080 in your browser.
echo   Press Ctrl+C to stop.
echo.

node backend\server.js
```

- [ ] **Step 2: Commit**

```bash
git add start.bat
git commit -m "feat: add Windows start.bat launcher"
```

---

### Task 9: GitHub Actions release workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create the release workflow**

```yaml
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - uses: actions/setup-go@v5
        with:
          go-version: '1.23'

      - name: Build frontend
        run: npm ci && npm run build

      - name: Build backend
        run: cd backend && npm ci && npx tsc

      - name: Build relay (linux/amd64)
        run: |
          cd relay
          CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o relay .

      - name: Build relay (windows/amd64)
        run: |
          cd relay
          CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o relay.exe .

      - name: Package linux-amd64
        run: |
          TAG=${GITHUB_REF#refs/tags/}
          mkdir -p staging
          cp -r dist staging/dist
          mkdir -p staging/backend
          cp -r backend/dist/* staging/backend/
          cp -r backend/node_modules staging/backend/node_modules
          cp relay/relay staging/relay
          chmod +x staging/relay
          echo "${TAG#v}" > staging/version.txt
          tar czf "permafrost-${TAG}-linux-amd64.tar.gz" -C staging .

      - name: Package windows-amd64
        run: |
          TAG=${GITHUB_REF#refs/tags/}
          mkdir -p staging-win
          cp -r dist staging-win/dist
          mkdir -p staging-win/backend
          cp -r backend/dist/* staging-win/backend/
          cp -r backend/node_modules staging-win/backend/node_modules
          cp relay/relay.exe staging-win/relay.exe
          cp start.bat staging-win/start.bat
          echo "${TAG#v}" > staging-win/version.txt
          cd staging-win && zip -r "../permafrost-${TAG}-windows-amd64.zip" . && cd ..

      - name: Create release
        uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
          files: |
            permafrost-*.tar.gz
            permafrost-*.zip
            install.sh
```

- [ ] **Step 2: Commit**

```bash
mkdir -p .github/workflows
git add .github/workflows/release.yml
git commit -m "feat: GitHub Actions release workflow for linux + windows"
```

---

### Task 10: Update README with install oneliners

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the "Docker deployment" section with a comprehensive "Install" section**

In `README.md`, replace everything from `## Docker deployment` down to (but not including) `## Architecture` with:

```markdown
## Install

### Linux (one command)

```bash
curl -sL https://github.com/mwaddip/otzi/releases/latest/download/install.sh | sudo bash
```

Downloads the latest release, installs to `/opt/permafrost`, creates systemd
services, and configures nginx or apache if detected.

### Docker

```bash
docker run -d -p 80:80 -p 443:443 -v permafrost-data:/data ghcr.io/mwaddip/otzi:latest
```

Or with Docker Compose:

```bash
git clone https://github.com/mwaddip/otzi && cd otzi && docker compose up -d
```

### Build from source

```bash
git clone https://github.com/mwaddip/otzi && cd otzi
sudo ./install.sh --deps     # install Node 20 + Go 1.23
sudo ./install.sh --build    # build and install as systemd services
```

### Windows

Download the [latest release](https://github.com/mwaddip/otzi/releases/latest)
zip, extract, and run `start.bat`. Requires [Node.js](https://nodejs.org/) in
your PATH. Open http://localhost:8080 in your browser.

### Installer options

| Command | Description |
|---------|-------------|
| `sudo ./install.sh` | Download latest release and install |
| `sudo ./install.sh --build` | Build from source and install |
| `sudo ./install.sh --deps` | Install build dependencies (Node 20, Go 1.23) |
| `sudo ./install.sh --uninstall` | Stop services, remove files |
| `sudo ./install.sh --yes` | Skip confirmation prompts |

<details>
<summary>Docker details</summary>

#### Ports

| Port | Service | Description |
|------|---------|-------------|
| **80** | Caddy | HTTP — serves the frontend and proxies `/api` + `/ws` to the backend |
| **443** | Caddy | HTTPS — active when a domain is configured with Let's Encrypt |
| **8080** | Backend | Direct access (bypasses Caddy) |

#### Custom domain and HTTPS

The Docker image includes [Caddy](https://caddyserver.com/) with automatic
Let's Encrypt HTTPS. Configure from **Settings > Hosting** in the UI, or:

```bash
curl -X POST http://localhost:8080/api/hosting \
  -H 'Content-Type: application/json' \
  -d '{"domain": "vault.example.com", "httpsEnabled": true}'
```

#### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Backend HTTP port |
| `RELAY_PORT` | `8081` | Internal relay WebSocket port |
| `DATA_DIR` | `/data` | Persistent data directory |
| `CADDYFILE_PATH` | `/etc/caddy/Caddyfile` | Caddy configuration file |
| `XDG_DATA_HOME` | `/data/caddy` | Caddy certificate/data storage |

</details>

### Storage modes

| Mode | Description |
|------|-------------|
| **Persistent** | Config stored as plaintext JSON. For trusted environments. |
| **Encrypted Persistent** | Config encrypted with AES-256-GCM on disk. Password required on each restart. |
| **Encrypted Portable** | Config downloaded to your machine. Upload + password each session. Nothing stored on the server. |
```

- [ ] **Step 2: Add `docs/superpowers/` to .gitignore**

Append to `.gitignore`:
```
docs/superpowers/
```

- [ ] **Step 3: Commit**

```bash
git add README.md .gitignore
git commit -m "docs: add install oneliners and multi-platform instructions"
```

---

### Task 11: Integration test

- [ ] **Step 1: Verify install.sh works end-to-end in a Docker container**

```bash
docker run --rm -v "$(pwd)/install.sh:/install.sh:ro" node:20-alpine sh -c "
  apk add --no-cache bash curl tar &&
  bash -n /install.sh &&
  echo 'Parse OK' &&
  bash /install.sh --help
"
```

Expected: Clean parse, help text printed.

- [ ] **Step 2: Verify GitHub Actions workflow is valid YAML**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))" && echo "Valid YAML"
```

- [ ] **Step 3: Final commit — tag for first release**

```bash
git add -A
git commit -m "feat: multi-platform installer, release workflow, Windows launcher"
git push
```

Optionally tag a release to test the workflow:
```bash
git tag v1.0.0
git push origin v1.0.0
```
