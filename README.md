# Sa'Venttii Walmart Sync - v7

Full rewrite. Boot log prints `Sa'Venttii Walmart Sync v7.0 (2026-07-12)` - if you
don't see "v7" in Railway's deploy logs, the running build is stale.

## What runs
- Every 30 min: orders, tracking, inventory, Daily Pick List, Pick Schedule -> Notion
- 7:00 AM ET: daily digest email (encouragement, due-today pick list, late flags, restock)
- 3:00 PM ET: OTD tripwire (emails ONLY if unshipped orders are due today)
- 8:00 PM ET: EOD close-out (shipping status, FULL tomorrow pull list, checklist)
- System alert email after 2 consecutive failed sync cycles

## v7 architecture notes
- Universal Notion resolver: every database works on either Notion architecture
  (classic or data-sources) with either ID form. Resolution is logged at boot:
  `[notion] Orders: classic database (a794e521...)`
- 3 isolated sync phases: Orders / Pick lists / Inventory. One failing never blocks the others.
- All dates in America/New_York.
- Skip-unchanged upserts: repeat syncs finish in seconds.

## Deploying changes
Commit to GitHub main -> Railway builds the new commit automatically.
NEVER use Railway's "Redeploy" button on an old deployment - it rebuilds that
deployment's OLD commit, not your latest code.

## Test commands (set temporarily as Railway start command, then revert to `npm start`)
- `node index.js --once`   one sync
- `node index.js --digest` send morning digest now
- `node index.js --otd`    send OTD check now
- `node index.js --eod`    send EOD close-out now
