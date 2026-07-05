# Sa'Venttii Walmart Sync

Auto-syncs Walmart Marketplace orders + inventory to Notion every 30 minutes and emails a daily digest at 7 AM ET via Brevo.

## What it does

- **Every 30 min:** pulls last 14 days of orders (status, ship-by, tracking #, carrier, totals) and all items with live inventory counts -> upserts into your two Notion databases
- **Daily 7 AM ET:** emails a digest — late shipments, orders needing shipment, new orders, shipped yesterday, restock alerts
- **Stock Status** is computed automatically: 0 = Out of Stock, at/below Reorder Point = Low Stock. Edit Reorder Point per SKU in Notion — the script preserves your value.

## Setup (one time)

### 1. Notion integration
1. Go to notion.so/my-integrations -> New integration -> name it "Walmart Sync" -> copy the token
2. Open **📦 Walmart Orders** in Notion -> ••• menu -> Connections -> add "Walmart Sync"
3. Repeat for **📊 Walmart Inventory**

### 2. Walmart API keys
Seller Center -> Developer Portal -> API Keys -> copy Client ID + Secret.
If you still get `UNAUTHORIZED.GMP_GATEWAY_API`, regenerate production keys and confirm app status is Active. If it persists, open a Partner Support case — it's account-side activation.

### 3. Deploy to Railway
```powershell
cd walmart-sync
git init
git add .
git commit -m "initial"
# create repo on github.com/vibeversenetwork, then:
git remote add origin https://github.com/vibeversenetwork/walmart-sync.git
git push -u origin main
```
In Railway: New Project -> Deploy from GitHub repo -> add all variables from `.env.example` in the Variables tab. Start command is `npm start` (auto-detected).

### 4. Test before letting cron take over
```powershell
# local test (create .env from .env.example first)
npm install
node index.js --once     # runs one sync, check Notion fills up
node index.js --digest   # sends the digest email now
```

## Notes
- Notion writes are throttled to ~3/sec (their rate limit) — a sync with many SKUs takes a couple minutes. Normal.
- Orders window is 14 days; older delivered orders stop updating but stay in Notion as history.
- If you change any Railway variable, redeploy — env changes don't hot-reload.
