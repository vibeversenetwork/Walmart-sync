// ============================================================
// Sa'Venttii Walmart Sync - v7 (2026-07-12) FULL REWRITE
// The BUILD banner below prints at boot: if you don't see "v7"
// in the deploy logs, the running code is NOT this code.
// ============================================================
const BUILD = "v7.0 (2026-07-12)";

const cron = require("node-cron");
const { fetchOrders, fetchInventory } = require("./src/walmart");
const {
  resolveDb, buildIndex,
  upsertOrder, upsertInventoryItem, syncPickList, syncPickByDate,
} = require("./src/notion");
const { sendDigest, sendOTDAlert, sendEOD, sendSystemAlert } = require("./src/digest");

const REORDER_POINT_DEFAULT = Number(process.env.REORDER_POINT_DEFAULT || 5);
let syncRunning = false;
let consecutiveFailures = 0;

function etDate(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---- Aggregations ----------------------------------------------
// Per-product totals with today/tomorrow splits (Daily Pick List)
function buildPickList(orders) {
  const today = etDate(0);
  const tomorrow = etDate(1);
  const byKey = new Map();
  for (const o of orders) {
    if (o.status !== "Created" && o.status !== "Acknowledged") continue;
    for (const line of o.lineDetails || []) {
      const e = byKey.get(line.name) || {
        name: line.name, sku: line.sku,
        qty: 0, qtyDueToday: 0, qtyDueTomorrow: 0,
        orderCount: 0, earliestShipBy: null,
      };
      e.qty += line.qty;
      if (!o.shipBy || o.shipBy <= today) e.qtyDueToday += line.qty; // undated/overdue = today
      else if (o.shipBy === tomorrow) e.qtyDueTomorrow += line.qty;
      e.orderCount += 1;
      if (o.shipBy && (!e.earliestShipBy || o.shipBy < e.earliestShipBy)) e.earliestShipBy = o.shipBy;
      byKey.set(line.name, e);
    }
  }
  return Array.from(byKey.values()).sort((a, b) => b.qtyDueToday - a.qtyDueToday || b.qty - a.qty);
}

// One row per product per ship-by date (Pick Schedule - "order ahead")
function buildPickByDate(orders) {
  const today = etDate(0);
  const map = new Map();
  for (const o of orders) {
    if (o.status !== "Created" && o.status !== "Acknowledged") continue;
    const date = (!o.shipBy || o.shipBy < today) ? today : o.shipBy;
    for (const line of o.lineDetails || []) {
      const k = line.name + "|" + date;
      const e = map.get(k) || { name: line.name, sku: line.sku, date, qty: 0, orderCount: 0 };
      e.qty += line.qty;
      e.orderCount += 1;
      map.set(k, e);
    }
  }
  return Array.from(map.values());
}

// ---- Sync cycle (3 isolated phases) -----------------------------
async function runSync() {
  if (syncRunning) {
    console.log("[sync] Previous sync still running - skipping this cycle");
    return;
  }
  syncRunning = true;
  console.log("[sync] " + BUILD + " starting at " + new Date().toISOString());
  let phaseFailed = false;
  let orders = null;

  // Phase 1: Orders
  try {
    orders = await fetchOrders(14);
    console.log("[sync] Walmart returned " + orders.length + " orders, loading Notion index...");
    const ordersH = await resolveDb("Orders", process.env.NOTION_ORDERS_DB);
    const index = await buildIndex(ordersH, "Order #");

    let created = 0, updated = 0, skipped = 0, done = 0;
    for (const o of orders) {
      const result = await upsertOrder(ordersH, o, index);
      if (result === "created") created++;
      else if (result === "updated") updated++;
      else skipped++;
      if (result !== "skipped") await sleep(350);
      done++;
      if (done % 100 === 0) console.log("[sync] Orders progress: " + done + "/" + orders.length);
    }
    console.log("[sync] Orders: " + created + " created, " + updated + " updated, " + skipped + " unchanged");
  } catch (e) {
    phaseFailed = true;
    console.error("[sync] Orders phase FAILED: " + e.message);
  }

  // Phase 2: Pick lists (needs orders; skipped only if phase 1 died)
  if (orders) {
    try {
      const pickH = await resolveDb("Pick List", process.env.NOTION_PICKLIST_DB);
      const pickList = buildPickList(orders);
      await syncPickList(pickH, pickList);
      console.log("[sync] Pick list: " + pickList.length + " products open");
    } catch (e) {
      phaseFailed = true;
      console.error("[sync] Pick list phase FAILED: " + e.message);
    }
    try {
      if (process.env.NOTION_PICKBYDATE_DB) {
        const pbdH = await resolveDb("Pick Schedule", process.env.NOTION_PICKBYDATE_DB);
        const rows = buildPickByDate(orders);
        await syncPickByDate(pbdH, rows);
        console.log("[sync] Pick schedule: " + rows.length + " product-date rows");
      }
    } catch (e) {
      phaseFailed = true;
      console.error("[sync] Pick schedule phase FAILED: " + e.message);
    }
  }

  // Phase 3: Inventory (fully independent)
  try {
    const inventory = await fetchInventory();
    console.log("[sync] Walmart returned " + inventory.length + " items, loading Notion index...");
    const invH = await resolveDb("Inventory", process.env.NOTION_INVENTORY_DB);
    const index = await buildIndex(invH, "SKU");

    let created = 0, updated = 0, skipped = 0;
    for (const item of inventory) {
      const result = await upsertInventoryItem(invH, item, REORDER_POINT_DEFAULT, index);
      if (result === "created") created++;
      else if (result === "updated") updated++;
      else skipped++;
      if (result !== "skipped") await sleep(350);
    }
    console.log("[sync] Inventory: " + created + " created, " + updated + " updated, " + skipped + " unchanged");
  } catch (e) {
    phaseFailed = true;
    console.error("[sync] Inventory phase FAILED: " + e.message);
  }

  console.log("[sync] Complete at " + new Date().toISOString());
  if (!phaseFailed) {
    consecutiveFailures = 0;
  } else {
    consecutiveFailures++;
    if (consecutiveFailures === 2) {
      sendSystemAlert(
        "The Walmart to Notion sync has had failures in " + consecutiveFailures +
        " consecutive cycles. Check Railway Deploy Logs for [sync] FAILED lines."
      ).catch((err) => console.error("[alert] Could not send system alert: " + err.message));
    }
  }
  syncRunning = false;
}

// ---- Entry point -------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  console.log("Sa'Venttii Walmart Sync " + BUILD);

  if (args.includes("--once")) { await runSync(); process.exit(0); }
  if (args.includes("--digest")) { await sendDigest(); process.exit(0); }
  if (args.includes("--otd")) { await sendOTDAlert(); process.exit(0); }
  if (args.includes("--eod")) { await sendEOD(); process.exit(0); }

  console.log("Schedules: sync every 30 min | digest 7:00 AM ET | OTD tripwire 3:00 PM ET | EOD close-out 8:00 PM ET");
  console.log("Emails to: " + (process.env.DIGEST_TO_EMAIL || "(DIGEST_TO_EMAIL not set!)"));

  cron.schedule("*/30 * * * *", runSync);
  cron.schedule("0 7 * * *", () => {
    console.log("[cron] 7 AM digest firing");
    sendDigest().catch((e) => console.error("[digest] FAILED: " + e.message));
  }, { timezone: "America/New_York" });
  cron.schedule("0 15 * * *", () => {
    console.log("[cron] 3 PM OTD check firing");
    sendOTDAlert().catch((e) => console.error("[otd] FAILED: " + e.message));
  }, { timezone: "America/New_York" });
  cron.schedule("0 20 * * *", () => {
    console.log("[cron] 8 PM EOD firing");
    sendEOD().catch((e) => console.error("[eod] FAILED: " + e.message));
  }, { timezone: "America/New_York" });

  runSync(); // immediate sync on boot
}

main();
