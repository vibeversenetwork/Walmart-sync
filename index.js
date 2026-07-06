// Sa'Venttii Walmart Sync
// - Every 30 min: pull orders + inventory from Walmart API, upsert to Notion
// - Daily 7:00 AM ET: send Brevo digest email
//
// Run modes:
//   node index.js          -> long-running with cron (Railway)
//   node index.js --once   -> single sync then exit (for testing)
//   node index.js --digest -> send digest now then exit (for testing)

const cron = require("node-cron");
const { fetchOrders, fetchInventory } = require("./src/walmart");
const { upsertOrder, upsertInventoryItem, syncPickList, buildIndex } = require("./src/notion");
const { sendDigest, sendOTDAlert } = require("./src/digest");

// Aggregate open (unshipped) order lines into per-product totals
function buildPickList(orders) {
  const byKey = new Map();
  for (const o of orders) {
    if (o.status !== "Created" && o.status !== "Acknowledged") continue;
    for (const line of o.lineDetails || []) {
      const key = line.name;
      const entry = byKey.get(key) || {
        name: line.name,
        sku: line.sku,
        qty: 0,
        orderCount: 0,
        earliestShipBy: null,
      };
      entry.qty += line.qty;
      entry.orderCount += 1;
      if (o.shipBy && (!entry.earliestShipBy || o.shipBy < entry.earliestShipBy)) {
        entry.earliestShipBy = o.shipBy;
      }
      byKey.set(key, entry);
    }
  }
  return Array.from(byKey.values()).sort((a, b) => b.qty - a.qty);
}

const REORDER_POINT_DEFAULT = Number(process.env.REORDER_POINT_DEFAULT || 5);
let syncRunning = false;

async function runSync() {
  if (syncRunning) {
    console.log("[sync] Previous sync still running - skipping this cycle");
    return;
  }
  syncRunning = true;
  console.log("[sync] Starting at " + new Date().toISOString());
  try {
    // ---- Orders ----
    const orders = await fetchOrders(14);
    console.log("[sync] Walmart returned " + orders.length + " orders, loading Notion index...");
    const orderIndex = await buildIndex(process.env.NOTION_ORDERS_DB, "Order #");

    let created = 0, updated = 0, skipped = 0, done = 0;
    for (const o of orders) {
      const result = await upsertOrder(o, orderIndex);
      if (result === "created") created++;
      else if (result === "updated") updated++;
      else skipped++;
      if (result !== "skipped") await sleep(350); // only throttle actual API writes
      done++;
      if (done % 50 === 0) console.log("[sync] Orders progress: " + done + "/" + orders.length);
    }
    console.log("[sync] Orders: " + created + " created, " + updated + " updated, " + skipped + " unchanged");

    // ---- Pick list ----
    const pickList = buildPickList(orders);
    await syncPickList(pickList);
    console.log("[sync] Pick list: " + pickList.length + " products needed");

    // ---- Inventory ----
    const inventory = await fetchInventory();
    console.log("[sync] Walmart returned " + inventory.length + " items, loading Notion index...");
    const invIndex = await buildIndex(process.env.NOTION_INVENTORY_DB, "SKU");

    let invCreated = 0, invUpdated = 0, invSkipped = 0;
    for (const item of inventory) {
      const result = await upsertInventoryItem(item, REORDER_POINT_DEFAULT, invIndex);
      if (result === "created") invCreated++;
      else if (result === "updated") invUpdated++;
      else invSkipped++;
      if (result !== "skipped") await sleep(350);
    }
    console.log("[sync] Inventory: " + invCreated + " created, " + invUpdated + " updated, " + invSkipped + " unchanged");
    console.log("[sync] Complete at " + new Date().toISOString());
  } catch (e) {
    console.error("[sync] FAILED: " + e.message);
  } finally {
    syncRunning = false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--once")) {
    await runSync();
    process.exit(0);
  }
  if (args.includes("--digest")) {
    await sendDigest();
    process.exit(0);
  }
  if (args.includes("--otd")) {
    await sendOTDAlert();
    process.exit(0);
  }

  // Long-running mode for Railway
  console.log("Sa'Venttii Walmart Sync running. Sync every 30 min, digest daily 7 AM ET, OTD tripwire 3 PM ET.");

  // Sync every 30 minutes
  cron.schedule("*/30 * * * *", runSync);

  // Digest at 7:00 AM Eastern
  cron.schedule("0 7 * * *", () => {
    sendDigest().catch((e) => console.error("[digest] FAILED: " + e.message));
  }, { timezone: "America/New_York" });

  // OTD tripwire at 3:00 PM Eastern - only emails if unshipped orders are due today/overdue
  cron.schedule("0 15 * * *", () => {
    sendOTDAlert().catch((e) => console.error("[otd] FAILED: " + e.message));
  }, { timezone: "America/New_York" });

  // Run one sync immediately on boot
  runSync();
}

main();
