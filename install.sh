#!/bin/bash

echo "╔══════════════════════════════════════╗"
echo "║   🧲 UNITY-MD — Auto Installer       ║"
echo "║   ® UNITY TEAM                       ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found. Installing..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "✅ Node.js $(node -v) found"
fi

# Check npm
if ! command -v npm &> /dev/null; then
  echo "❌ npm not found."
  exit 1
else
  echo "✅ npm $(npm -v) found"
fi

# Check ffmpeg
if ! command -v ffmpeg &> /dev/null; then
  echo "📦 Installing ffmpeg..."
  sudo apt-get install -y ffmpeg
else
  echo "✅ ffmpeg found"
fi

# Install / update yt-dlp (latest version)
echo "📦 Installing/updating yt-dlp..."
if command -v pip3 &> /dev/null; then
  pip3 install --upgrade yt-dlp --break-system-packages 2>/dev/null || \
  pip3 install --upgrade yt-dlp 2>/dev/null || \
  python3 -m pip install --upgrade yt-dlp 2>/dev/null || \
  sudo pip3 install --upgrade yt-dlp 2>/dev/null
elif command -v pip &> /dev/null; then
  pip install --upgrade yt-dlp 2>/dev/null || \
  sudo pip install --upgrade yt-dlp 2>/dev/null
else
  echo "⚠️  pip not found, trying direct install..."
  curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp 2>/dev/null && \
  chmod +x /usr/local/bin/yt-dlp || \
  sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp 2>/dev/null && \
  sudo chmod +x /usr/local/bin/yt-dlp
fi

if command -v yt-dlp &> /dev/null; then
  echo "✅ yt-dlp $(yt-dlp --version) installed"
else
  echo "⚠️  yt-dlp install failed — song/video downloads may not work"
fi

# Install PM2
if ! command -v pm2 &> /dev/null; then
  echo "📦 Installing PM2..."
  sudo npm install -g pm2
else
  echo "✅ PM2 found"
fi

# Create directories
echo "📁 Creating directories..."
mkdir -p temp logs database/sessions src/media

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Check config.env
if [ ! -f "config.env" ]; then
  echo ""
  echo "⚠️  config.env not found!"
  echo "📋 Please fill in config.env before starting."
  echo ""
else
  echo "✅ config.env found"
fi

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   ✅ Installation complete!          ║"
echo "║                                      ║"
echo "║   Start: npm start                   ║"
echo "║   PM2:   npm run pm2                 ║"
echo "║   Dev:   npm run dev                 ║"
echo "╚══════════════════════════════════════╝"