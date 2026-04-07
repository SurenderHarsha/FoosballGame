# Foosball Online — Setup & Hosting Guide

## Prerequisites

Install **Node.js** (v18 or newer) on your machine.

### Windows
```
winget install OpenJS.NodeJS.LTS
```
Or download from https://nodejs.org — use the LTS installer.

### macOS
```
brew install node
```
Or download from https://nodejs.org.

### Linux (Ubuntu/Debian)
```
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### Verify
```
node --version
npm --version
```

---

## Running Locally

```bash
# 1. Clone or copy the project
cd FoosballGame

# 2. Install dependencies
npm install

# 3. Start server
node server.js
```

Open `http://localhost:3000` in your browser. Share the same URL with a friend on your local network (replace `localhost` with your local IP, e.g. `192.168.1.x:3000`).

---

## Project Structure

```
FoosballGame/
  server.js          — Game server (Node.js + Express + Socket.IO)
  package.json       — Dependencies
  public/
    index.html       — Main game page
    game.js          — Client-side game logic + rendering
    style.css        — Styles
    moves-guide.html — Special moves reference guide
```

---

## Free Hosting Options

### 1. Render (Recommended)

**Best for**: Free, simple, secure, supports WebSockets.

- Free tier: 750 hours/month, auto-sleep after 15 min inactivity
- HTTPS included
- Push-to-deploy from GitHub

### 2. Railway

- Free trial: $5 credit (lasts ~2-3 weeks of light use)
- Good WebSocket support
- Easy GitHub deploy

### 3. Fly.io

- Free tier: 3 shared VMs
- Requires CLI tool
- Good performance, more setup

### 4. Glitch

- Free, browser-based editor
- Auto-sleep after 5 min
- Simple but slower wake-up

**Verdict**: Use **Render** — easiest, free, HTTPS, WebSocket support out of the box.

---

## Hosting on Render (Step by Step)

### 1. Push to GitHub

```bash
# In the FoosballGame folder:
git init
git add .
git commit -m "Initial commit"

# Create a repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/FoosballGame.git
git branch -M main
git push -u origin main
```

### 2. Create Render Account

1. Go to https://render.com
2. Sign up with GitHub

### 3. Deploy

1. Click **New** > **Web Service**
2. Connect your GitHub repo (`FoosballGame`)
3. Settings:
   - **Name**: `foosball` (or whatever you want)
   - **Region**: closest to you
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: `Free`
4. Click **Create Web Service**

### 4. Wait & Play

- Render builds and deploys in ~1-2 minutes
- You get a URL like: `https://foosball-xxxx.onrender.com`
- Share this URL with friends
- First load after sleep takes ~30 seconds to wake up

### 5. Update

Push to GitHub and Render auto-deploys:
```bash
git add .
git commit -m "Update"
git push
```

---

## Environment Variable (Optional)

Set `PORT` on the hosting platform if needed. The server defaults to port 3000 but reads `process.env.PORT` automatically.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `npm install` fails | Make sure Node.js is installed: `node --version` |
| Port in use | Kill the process: `npx kill-port 3000` or change PORT |
| Can't connect from other devices | Use your LAN IP, not `localhost`. Check firewall. |
| Render deploy fails | Check build logs. Make sure `package.json` exists. |
| WebSocket disconnects | Normal on free tier after inactivity. Refresh page. |
