# Multi-Platform Installer Design

**Date:** 2026-03-13
**Status:** Approved

## Summary

Add a universal install script, GitHub Actions release workflow, and Windows
launcher so PERMAFROST Vault can be deployed in 1-3 commands on any platform
without Docker.

## Deliverables

### 1. `install.sh` — Universal Linux Installer

Single bash script, four modes controlled by flags:

```
install.sh              # Download pre-built release, install, configure
install.sh --build      # Build from source instead of downloading
install.sh --deps       # Check/install build dependencies (Node 20, Go 1.23)
install.sh --uninstall  # Remove everything cleanly
```

#### Dependency Installer (`--deps`)

Detects distro from `/etc/os-release` and installs Node 20 + Go 1.23 via the
appropriate package manager:

| Distro | Node | Go |
|--------|------|----|
| Ubuntu/Debian | NodeSource apt repo | golang-go or snap |
| Fedora/RHEL/CentOS | NodeSource rpm repo | dnf install golang |
| Arch/Manjaro | pacman -S nodejs npm | pacman -S go |
| Alpine | apk add nodejs npm | apk add go |

Checks current versions first. Only installs if missing or too old. Prints
what it will do and asks for confirmation (unless `--yes` flag is passed).

#### Download Mode (default)

1. Detect architecture (`uname -m` → `amd64`)
2. Fetch latest release tag from GitHub API
3. Download `permafrost-<version>-linux-amd64.tar.gz` from GitHub Releases
4. Extract to `/opt/permafrost/`:
   ```
   /opt/permafrost/
   ├── dist/           # Frontend static files
   ├── backend/        # Compiled JS + node_modules
   ├── relay           # Go binary
   └── version.txt     # Installed version for upgrade checks
   ```
5. Proceed to service setup (step 6 below)

#### Build Mode (`--build`)

1. Verify Node 20+ and Go 1.23+ are installed (exit with hint to run
   `--deps` if missing)
2. Run from the repo root (or clone if run standalone):
   ```
   npm ci && npm run build
   cd backend && npm ci && npx tsc && cd ..
   cd relay && CGO_ENABLED=0 go build -ldflags="-s -w" -o relay . && cd ..
   ```
3. Copy artifacts to `/opt/permafrost/` (same layout as download mode)
4. Proceed to service setup

#### Service Setup (both modes)

6. Create system user: `useradd --system --home /var/lib/permafrost permafrost`
7. Create data directory: `/var/lib/permafrost` owned by `permafrost`
8. Install two systemd units:

   **`/etc/systemd/system/permafrost-relay.service`**
   ```ini
   [Unit]
   Description=PERMAFROST Relay
   After=network.target

   [Service]
   Type=simple
   User=permafrost
   ExecStart=/opt/permafrost/relay -addr :8081
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```

   **`/etc/systemd/system/permafrost.service`**
   ```ini
   [Unit]
   Description=PERMAFROST Vault Backend
   After=network.target permafrost-relay.service
   Requires=permafrost-relay.service

   [Service]
   Type=simple
   User=permafrost
   WorkingDirectory=/opt/permafrost
   Environment=NODE_ENV=production
   Environment=PORT=8080
   Environment=RELAY_PORT=8081
   Environment=DATA_DIR=/var/lib/permafrost
   ExecStart=/usr/bin/node backend/server.js
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```

9. `systemctl daemon-reload && systemctl enable --now permafrost-relay permafrost`

#### Web Server Detection

10. Check for Apache and Nginx:

**Nginx detected** (`nginx -v` succeeds):

Write `/etc/nginx/sites-available/permafrost`:
```nginx
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
```
Symlink to `sites-enabled/`, remove default if it conflicts, `nginx -t && systemctl reload nginx`.

**Apache detected** (`apachectl -v` or `httpd -v` succeeds):

Write `/etc/apache2/sites-available/permafrost.conf` (or `/etc/httpd/conf.d/permafrost.conf`):
```apache
<VirtualHost *:80>
    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:8080/
    ProxyPassReverse / http://127.0.0.1:8080/

    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule /(.*)  ws://127.0.0.1:8080/$1 [P,L]
</VirtualHost>
```
Enable required modules (`proxy`, `proxy_http`, `proxy_wstunnel`, `rewrite`),
enable site, `systemctl reload apache2`.

**Neither detected:**

Print:
```
No web server detected. PERMAFROST is running on http://localhost:8080

To expose it on port 80/443, install nginx or apache, or use the
Docker image which includes Caddy:

  docker run -d -p 80:80 -v permafrost-data:/data ghcr.io/mwaddip/otzi:latest

Manual proxy config — forward to http://127.0.0.1:8080
WebSocket path: /ws (requires upgrade headers)
```

#### Uninstall (`--uninstall`)

```
systemctl stop permafrost permafrost-relay
systemctl disable permafrost permafrost-relay
rm /etc/systemd/system/permafrost*.service
systemctl daemon-reload
rm -rf /opt/permafrost
# Preserve /var/lib/permafrost (data) — print reminder
# Remove web server config if it exists
userdel permafrost
```

### 2. GitHub Actions Release Workflow

**File:** `.github/workflows/release.yml`

**Trigger:** Push of tag matching `v*` (e.g., `v1.0.0`)

**Jobs:**

1. **build-linux-amd64**
   - `runs-on: ubuntu-latest`
   - Install Node 20, Go 1.23
   - `npm ci && npm run build` (frontend)
   - `cd backend && npm ci && npx tsc` (backend)
   - `cd relay && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o relay .`
   - Package: `tar czf permafrost-${TAG}-linux-amd64.tar.gz dist/ backend/dist/ backend/node_modules/ relay`

2. **build-windows-amd64**
   - Same build steps for frontend + backend (JS is universal)
   - `GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o relay.exe .`
   - Include `start.bat`
   - Package: `zip permafrost-${TAG}-windows-amd64.zip dist/ backend/dist/ backend/node_modules/ relay.exe start.bat`

3. **release**
   - Create GitHub Release with:
     - `permafrost-${TAG}-linux-amd64.tar.gz`
     - `permafrost-${TAG}-windows-amd64.zip`
     - `install.sh`
   - Auto-generate release notes from commits

### 3. Windows Launcher

**`start.bat`:**
```batch
@echo off
echo Starting PERMAFROST Vault...
start /B relay.exe -addr :8081
node backend\server.js
```

Starts relay in background, runs backend in foreground. User opens
`http://localhost:8080` in their browser.

### 4. README Updates

Add a "Quick Install" section at the top of the deployment docs:

```markdown
## Install

### Linux (one command)
curl -sL https://github.com/mwaddip/otzi/releases/latest/download/install.sh | sudo bash

### Docker
docker run -d -p 80:80 -v permafrost-data:/data ghcr.io/mwaddip/otzi:latest

### Docker Compose
git clone https://github.com/mwaddip/otzi && cd otzi && docker compose up -d

### Build from source
git clone https://github.com/mwaddip/otzi && cd otzi
sudo ./install.sh --deps    # install Node 20 + Go 1.23
sudo ./install.sh --build   # build and install

### Windows
Download the latest release zip, extract, and run start.bat.
Open http://localhost:8080 in your browser.
```

Keep existing Docker details in a collapsed section below.

## Out of Scope

- arm64 builds (trivial to add later — Go cross-compiles, JS is universal)
- macOS support (no systemd; users can run manually or use Docker)
- Windows service installation (just a foreground launcher for now)
- Auto-update mechanism
- HTTPS via install script (users configure via Settings UI or use Docker with Caddy)

## File Inventory

| File | New/Modified |
|------|-------------|
| `install.sh` | New |
| `start.bat` | New |
| `.github/workflows/release.yml` | New |
| `README.md` | Modified |
| `.gitignore` | Modified (add `docs/superpowers/`) |
