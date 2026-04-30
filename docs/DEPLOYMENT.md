# Deployment — Deaton Outreach Automation

## Overview

The application runs on a single Linux VPS as a Node.js process managed by PM2, with Caddy as a reverse proxy providing automatic HTTPS for the unsubscribe endpoint.

---

## VPS Requirements

| Resource | Minimum | Recommended |
|---|---|---|
| CPU | 1 vCPU | 1 vCPU |
| RAM | 512 MB | 1 GB |
| Disk | 10 GB | 20 GB |
| OS | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |
| Network | Public IPv4 address | Public IPv4 address |

Suitable providers: DigitalOcean ($4–6/mo), Vultr ($3.50–6/mo), Linode ($5/mo), Hetzner ($3.50/mo).

---

## Domain and DNS Setup

The unsubscribe endpoint needs a publicly reachable domain with HTTPS.

**Option A (recommended)**: Use a subdomain of an existing domain.
- Subdomain: `unsub.deatonengineering.us`
- DNS: Add an A record pointing `unsub.deatonengineering.us` to the VPS IP address.

**Option B**: Use the VPS IP directly (not recommended — no TLS without a domain).

**DNS record to create:**
```
Type: A
Host: unsub
Value: <VPS IP address>
TTL: 3600
```

---

## Step-by-Step Server Setup

### 1. Initial Server Hardening

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Create a dedicated application user (do not run the app as root)
sudo adduser deaton --disabled-password
sudo usermod -aG sudo deaton

# Configure SSH key authentication
# (Copy your public key to the server first)
sudo mkdir -p /home/deaton/.ssh
sudo cp ~/.ssh/authorized_keys /home/deaton/.ssh/
sudo chown -R deaton:deaton /home/deaton/.ssh
sudo chmod 700 /home/deaton/.ssh
sudo chmod 600 /home/deaton/.ssh/authorized_keys

# Disable SSH password authentication
sudo sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart sshd

# Install and configure fail2ban
sudo apt install fail2ban -y
sudo systemctl enable fail2ban
sudo systemctl start fail2ban

# Configure firewall
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP (Caddy redirect)
sudo ufw allow 443/tcp   # HTTPS (Caddy)
sudo ufw enable
```

### 2. Install Node.js 20 LTS

```bash
# Install Node.js 20 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify installation
node --version   # Should show v20.x.x
npm --version    # Should show 10.x.x
```

### 3. Install PM2 (Process Manager)

```bash
# Install PM2 globally
sudo npm install -g pm2

# Configure PM2 to start on boot
pm2 startup systemd -u deaton --hp /home/deaton
# (Run the command it outputs)
```

### 4. Install Caddy (Reverse Proxy)

```bash
# Install Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy -y
```

### 5. Configure Caddy

Create the Caddyfile:

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
unsub.deatonengineering.us {
    reverse_proxy localhost:3000
}
EOF

# Reload Caddy
sudo systemctl reload caddy
```

Caddy automatically provisions a TLS certificate via Let's Encrypt. No manual cert management needed.

### 6. Deploy the Application

```bash
# Switch to the deaton user
sudo su - deaton

# Create application directory
mkdir -p /home/deaton/app
cd /home/deaton/app

# Clone the repository (or copy files)
# git clone <repo-url> .
# OR: scp files from local machine

# Install dependencies
npm install --production

# Build TypeScript
npm run build

# Create data directories
mkdir -p data/state data/logs

# Create credentials directory
mkdir -p credentials
# Copy the Google service account JSON key into credentials/
# scp service-account.json deaton@<vps-ip>:/home/deaton/app/credentials/

# Set credential file permissions
chmod 600 credentials/service-account.json
```

### 7. Configure Environment

```bash
# Create .env file
cp .env.example .env
nano .env
# Fill in all required values (see ENVIRONMENT_VARIABLES.md)

# Set .env file permissions
chmod 600 .env
```

### 8. Start the Application

```bash
# Start with PM2
pm2 start dist/main.js --name deaton-outreach

# Save PM2 process list (so it restarts on reboot)
pm2 save

# Verify it's running
pm2 status
pm2 logs deaton-outreach
```

### 9. Verify Everything Works

```bash
# Check the application is running
pm2 status

# Check the unsubscribe endpoint responds
curl -I https://unsub.deatonengineering.us/health

# Check application logs for startup messages
pm2 logs deaton-outreach --lines 20

# Check Caddy is proxying correctly
sudo systemctl status caddy
```

---

## PM2 Configuration File

Create `ecosystem.config.js` in the project root:

```javascript
module.exports = {
  apps: [{
    name: 'deaton-outreach',
    script: 'dist/main.js',
    cwd: '/home/deaton/app',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '256M',
    env: {
      NODE_ENV: 'production'
    },
    // Log files managed by PM2
    error_file: '/home/deaton/app/data/logs/pm2-error.log',
    out_file: '/home/deaton/app/data/logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    // Graceful shutdown
    kill_timeout: 60000,
    listen_timeout: 10000,
  }]
};
```

Start with: `pm2 start ecosystem.config.js`

---

## Update / Redeploy Procedure

```bash
# SSH into the VPS
ssh deaton@<vps-ip>

# Navigate to the app directory
cd /home/deaton/app

# Pull latest code
git pull origin main

# Install any new dependencies
npm install --production

# Rebuild TypeScript
npm run build

# Restart the application (graceful)
pm2 reload deaton-outreach

# Verify
pm2 status
pm2 logs deaton-outreach --lines 10
```

---

## Backup Strategy

### What to Back Up

| Item | Location | Frequency |
|---|---|---|
| `.env` file | `/home/deaton/app/.env` | After any change |
| Service account key | `/home/deaton/app/credentials/` | Once (stored securely offline) |
| Local state files | `/home/deaton/app/data/state/` | Optional (Sheets is the source of truth) |
| Application logs | `/home/deaton/app/data/logs/` | Optional (for debugging) |
| Google Sheets | Google Sheets (cloud) | Google handles versioning |

### Backup Command (manual)

```bash
# Create a backup archive (excludes node_modules and logs)
tar -czf ~/backup-deaton-$(date +%Y%m%d).tar.gz \
  --exclude='node_modules' \
  --exclude='data/logs' \
  /home/deaton/app/.env \
  /home/deaton/app/credentials/ \
  /home/deaton/app/data/state/
```

---

## Rollback Procedure

If a deployment causes issues:

```bash
# Revert to previous git commit
cd /home/deaton/app
git log --oneline -5      # Find the last good commit
git checkout <commit-hash>

# Rebuild and restart
npm install --production
npm run build
pm2 reload deaton-outreach
```
