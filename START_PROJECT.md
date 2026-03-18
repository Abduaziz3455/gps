# Deploy GPS Fleet Dashboard to Production

Server: Ubuntu with nginx already installed
Domain: tbbdispatcher.uz

---

## 1. Connect to your server

```bash
ssh root@your-server-ip
```

## 2. Install Node.js (if not installed)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node -v
```

## 3. Install Docker & Docker Compose (if not installed)

```bash
apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable docker
systemctl start docker
docker --version
```

## 4. Clone the project

```bash
mkdir -p /root
cd /root
git clone https://github.com/khdrvss/gps.git tbb_dispatcher
cd tbb_dispatcher
```

If already cloned:

```bash
cd /root/tbb_dispatcher
git pull origin main
```

## 5. Create .env file

```bash
cp .env.example .env
nano .env
```

Fill in your real credentials:

```
NODE_ENV=production
PORT=8090
API_ORIGIN=https://baku.gps.az
GPS_LOGIN=MadinaAuto
GPS_PASSWORD=YourRealPassword
CORS_ORIGINS=https://tbbdispatcher.uz
```

Save and exit (`Ctrl+X`, `Y`, `Enter`).

## 6. Build and start the app with Docker

```bash
docker compose up -d --build
```

Verify it's running:

```bash
docker compose ps
curl http://127.0.0.1:8090/health
```

You should see `{"status":"ok",...}`.

## 7. Configure nginx

Set up nginx **before** SSL so that certbot can find the `server_name` directive:

```bash
cp nginx.conf /etc/nginx/sites-available/tbbdispatcher.uz
ln -sf /etc/nginx/sites-available/tbbdispatcher.uz /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
```

## 8. Set up SSL certificate

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d tbbdispatcher.uz
```

Certbot will auto-configure SSL in the nginx config.

## 9. Verify deployment

```bash
# Health check
curl https://tbbdispatcher.uz/health

# Dashboard should load
curl -I https://tbbdispatcher.uz/
```

Open in browser: https://tbbdispatcher.uz

## 10. Point your domain DNS

In your domain registrar (for tbbdispatcher.uz), create an A record:

```
Type: A
Name: @
Value: your-server-ip
TTL: 300
```

---

## Useful commands

### View logs

```bash
cd /root/tbb_dispatcher
docker compose logs -f
```

### Restart the app

```bash
docker compose restart
```

### Stop the app

```bash
docker compose down
```

### Update to latest code

```bash
cd /root/tbb_dispatcher
git pull origin main
docker compose up -d --build
```

### Renew SSL (auto-renews, but manual if needed)

```bash
certbot renew
systemctl reload nginx
```
