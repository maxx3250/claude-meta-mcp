# Deployment (v0.2)

A typical production deployment behind nginx with pm2 as the process manager. Adapt to your stack as needed.

For the Meta Developer App + System User token side, see [`META_APP_SETUP.md`](./META_APP_SETUP.md).

## Requirements

- Node.js ≥ 20
- A public DNS name pointing at your server (HTTPS is required by Claude)
- A working Meta System User token (see [`META_APP_SETUP.md`](./META_APP_SETUP.md))

## 1. Clone and build

```bash
cd /var/www
git clone https://github.com/maxx3250/claude-meta-mcp.git connector
cd connector
npm ci
npm run build
```

## 2. Configure

```bash
cp .env.example .env
# generate the bearer token clients will send to /mcp
echo "AUTH_TOKEN=$(openssl rand -hex 32)" >> .env
# edit .env and fill in META_ACCESS_TOKEN, PUBLIC_URL
```

## 3. Run via pm2

The repository ships an example pm2 config at [`ecosystem.config.cjs`](../ecosystem.config.cjs). Adjust the `cwd` if your install path differs.

```bash
pm2 start ecosystem.config.cjs
pm2 save
# optionally enable on boot
pm2 startup systemd
```

Logs:

```bash
pm2 logs claude-meta-mcp
```

### Alternative: systemd

If you prefer systemd over pm2, drop a unit file at `/etc/systemd/system/claude-meta-mcp.service`:

```ini
[Unit]
Description=claude-meta-mcp
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/connector
ExecStart=/usr/bin/node --env-file=/var/www/connector/.env --enable-source-maps /var/www/connector/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now claude-meta-mcp
```

## 4. Reverse proxy (nginx)

```nginx
server {
    listen 80;
    server_name connector.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name connector.example.com;

    ssl_certificate     /etc/letsencrypt/live/connector.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/connector.example.com/privkey.pem;

    server_tokens off;

    # Streamable HTTP can keep connections open longer than the nginx default
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    proxy_buffering    off;

    location / {
        proxy_pass http://127.0.0.1:3210;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization     $http_authorization;
        # Prevent request smuggling
        proxy_set_header Transfer-Encoding "";
    }
}
```

Get a Let's Encrypt certificate:

```bash
certbot --nginx -d connector.example.com
```

## 5. Add to Claude

The connector exposes a raw Bearer-auth endpoint at `/mcp`. **claude.ai web requires OAuth 2.1**, while **Claude Desktop and other MCP clients** can use the Bearer endpoint directly. Pick the option that matches your client.

### Option A — Claude Desktop (Bearer auth, simplest)

1. Open **Claude Desktop → Settings → Developer → Edit Config**.
2. Add an entry:
   ```json
   {
     "mcpServers": {
       "meta": {
         "url": "https://connector.example.com/mcp",
         "transport": "http",
         "headers": { "Authorization": "Bearer YOUR_AUTH_TOKEN" }
       }
     }
   }
   ```
3. Restart Claude Desktop. The tools should appear under "meta".

### Option B — claude.ai web (OAuth 2.1 + DCR)

claude.ai will only connect to remote MCP servers that advertise OAuth 2.1 discovery. To support that, run a thin OAuth shim in front of the connector. A reference implementation lives at <https://github.com/markusstoeger/mcp-oauth-shim> *(or your own).*

The shim:
- Implements `/.well-known/oauth-authorization-server`, `/authorize`, `/token`, `/register`, `/jwks.json`
- Validates Claude's PKCE flow + DCR registration
- On success, forwards `/mcp` traffic to the connector with the upstream Bearer header injected
- Authenticates the human in `/authorize` against an htpasswd file (so a third party can't register their own client and use your connector)

When the shim is in front:

1. claude.ai → **Settings → Connectors → Add custom connector**
2. URL: `https://connector.example.com/mcp` (the shim's public URL)
3. Save. claude.ai discovers the OAuth endpoints automatically.
4. A login popup asks for the htpasswd user/password — enter it once.
5. The tools appear in the connector.

(If you don't want to run the shim, you can run a private MCP gateway like supergateway in your own Claude Desktop instance, but that won't work with claude.ai web.)

## 6. Verify

```bash
# health
curl https://connector.example.com/health
# → {"status":"ok",...}

# unauthenticated request should be rejected
curl -i -X POST https://connector.example.com/mcp -H 'Content-Type: application/json' -d '{}'
# → HTTP/1.1 401 Unauthorized

# tools/list with auth
curl -X POST https://connector.example.com/mcp \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# → JSON listing all tools (56 in v0.5)
```

## 7. Updating

```bash
cd /var/www/connector
git pull
npm ci
npm run build
pm2 reload claude-meta-mcp --update-env
```

## 8. Operational notes

**Meta token expiry.** System User tokens with "Never" expiry don't expire automatically. Rotate them periodically anyway (see [`META_APP_SETUP.md`](./META_APP_SETUP.md) §9). If you used a user access token instead of a System User token, plan for a 60-day rotation.

**Backup.** Nothing to back up in v0.2 — the service is stateless. Just keep `.env` safe (Meta token + Bearer secret).

**Monitoring.** Hit `/health` from your uptime checker. Alert on non-200 responses or pm2 restart loops.

## 9. Upload page & asset store (v0.6)

Set `UPLOAD_DIR` (and `HOST=127.0.0.1`) in `.env`, create the directory, then route two prefixes in nginx. The connector refuses `/upload` requests that do not arrive over loopback, so the `auth_basic` here **is** the login — reuse the htpasswd file of the OAuth shim so people have one password:

```nginx
    location ^~ /upload {
        auth_basic "Meta Connector";
        auth_basic_user_file /etc/nginx/.htpasswd_connector;   # must be readable by the nginx user (www-data)
        client_max_body_size 100M;
        proxy_request_buffering off;
        proxy_pass http://127.0.0.1:3210;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Transfer-Encoding "";
    }

    # Public, unguessable asset URLs (Meta fetches Instagram media from here).
    location ^~ /assets/ {
        proxy_pass http://127.0.0.1:3210;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Transfer-Encoding "";
    }
```

Place both blocks **before** the catch-all `location /` that forwards to the OAuth shim. Then:

```bash
mkdir -p /var/lib/claude-meta-mcp/assets
chgrp www-data /etc/nginx/.htpasswd_connector && chmod 640 /etc/nginx/.htpasswd_connector
nginx -t && systemctl reload nginx
pm2 restart claude-meta-mcp --update-env
curl -i https://connector.example.com/upload          # → 401 without login
```

ChatGPT additionally needs a **refresh of the app** (Plugins → your app → refresh) to pick up the new `file` parameters; it then shows a file picker for `upload_ad_image`, `upload_ad_video` and `create_instagram_post`.
