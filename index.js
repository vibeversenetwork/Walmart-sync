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
const { upsertOrder, upsertInventoryItem } = require("./src/notion");
const { sendDigest } = require("./src/digest");

const REORDER_POINT_DEFAULT = Number(process.env.REORDER_POINT_DEFAULT || 5);

async function runSync() {
  console.log("[sync] Starting at " + new Date().toISOString());
  try {
    const orders = await fetchOrders(14);
    let created = 0, updated = 0;
    for (const o of orders) {
      const result = await upsertOrder(o);
      if (result === "created") created++; else updated++;
      await sleep(350); // Notion rate limit: ~3 req/sec
    }
    console.log("[sync] Orders: " + created + " created, " + updated + " updated");

    const inventory = await fetchInventory();
    let invCreated = 0, invUpdated = 0;
    for (const item of inventory) {
      const result = await upsertInventoryItem(item, REORDER_POINT_DEFAULT);
      if (result === "created") invCreated++; else invUpdated++;
      await sleep(350);
    }
    console.log("[sync] Inventory: " + invCreated + " created, " + invUpdated + " updated");
  } catch (e) {
    console.error("[sync] FAILED: " + e.message);
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

  // Long-running mode for Railway
  console.log("Sa'Venttii Walmart Sync running. Sync every 30 min, digest daily 7 AM ET.");

  // Sync every 30 minutes
  cron.schedule("*/30 * * * *", runSync);

  // Digest at 7:00 AM Eastern
  cron.schedule("0 7 * * *", () => {
    sendDigest().catch((e) => console.error("[digest] FAILED: " + e.message));
  }, { timezone: "America/New_York" });

  // Run one sync immediately on boot
  runSync();
}

main();
