#!/bin/sh
# Start relay on 8081 (relay defaults to 8080, override to avoid conflict with backend)
relay -addr :8081 &

# Write default Caddyfile (reverse proxy :80 → backend:8080)
# The backend hosting route will overwrite this when domain is configured
cat > /etc/caddy/Caddyfile <<'EOF'
:80 {
  reverse_proxy localhost:8080
}
EOF

# Start Caddy reverse proxy (serves ports 80/443, proxies to backend:8080)
caddy run --config /etc/caddy/Caddyfile &

# Start Node.js backend on 8080 (serves frontend + API, proxies /ws to relay:8081)
exec node backend/server.js
