#!/bin/bash

# --- CONFIGURATION ---
PORT=31000
APP_NAME="wa-gateway"
DOMAIN="modularconstruction.co.id"

echo "------------------------------------------------"
echo "Starting Production Setup for Modular Construction"
echo "------------------------------------------------"

# 1. Update & Install Node.js (if not exists)
if ! command -v node &> /dev/null; then
    echo "[1/5] Node.js not found. Installing..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "[1/5] Node.js already installed: $(node -v)"
fi

# 2. Install PM2 globally
if ! command -v pm2 &> /dev/null; then
    echo "[2/5] Installing PM2..."
    sudo npm install -g pm2
else
    echo "[2/5] PM2 already installed."
fi

# 3. Setup wa-server
echo "[3/5] Setting up wa-server..."
cd wa-server
npm install

# 4. Open Firewall Port 31000 (for VPS)
if command -v ufw &> /dev/null; then
    echo "[4/5] Opening port $PORT on UFW..."
    sudo ufw allow $PORT
else
    echo "[4/5] Firewall command 'ufw' not found. Skipping (ignore if site is shared hosting)."
fi

# 5. Start Application
echo "[5/5] Starting application with PM2..."
pm2 delete $APP_NAME 2>/dev/null
PORT=$PORT pm2 start server.js --name "$APP_NAME"
pm2 save
pm2 startup

echo "------------------------------------------------"
echo "SETUP COMPLETE!"
echo "------------------------------------------------"
echo "Port: $PORT"
echo "URL Internal Admin: http://127.0.0.1:$PORT"
echo "Webhook targeted: https://$DOMAIN/api/whatsapp_ai_webhook.php"
echo "------------------------------------------------"
echo "Run 'pm2 logs $APP_NAME' to see real-time updates."
