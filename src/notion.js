// Notion API client - upserts rows into the Orders and Inventory databases
const NOTION_BASE = "https://api.notion.com/v1";

function headers() {
  return {
    "Authorization": "Bearer " + process.env.NOTION_TOKEN,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  };
}

async function notionFetch(path, method, body) {
  const res = await fetch(NOTION_BASE + path, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("Notion " + method + " " + path + " failed (" + res.status + "): " + text);
  }
  return res.json();
}

// Find a page in a database by its title property value
async function findByTitle(databaseId, titleProp, value) {
  const data = await notionFetch("/databases/" + databaseId + "/query", "POST", {
    filter: { property: titleProp, title: { equals: value } },
    page_size: 1,
  });
  return data.results[0] || null;
}

function pageTitle(page, titleProp) {
  return page.properties[titleProp]?.title?.map((t) => t.plain_text).join("") || "";
}
function pageText(page, prop) {
  return page.properties[prop]?.rich_text?.map((t) => t.plain_text).join("") || "";
}

// Load ALL rows of a database once and index them by title — one query per 100 rows
// instead of one query per order. Critical for high order volume.
async function buildIndex(databaseId, titleProp) {
  const pages = await queryAll(databaseId);
  const map = new Map();
  for (const p of pages) map.set(pageTitle(p, titleProp), p);
  return map;
}

function selectOrNull(v) {
  return v ? { select: { name: v } } : { select: null };
}
function textProp(v) {
  return { rich_text: v ? [{ text: { content: String(v).slice(0, 2000) } }] : [] };
}
function dateOrNull(v) {
  return v ? { date: { start: v } } : { date: null };
}

async function upsertOrder(o, index) {
  const dbId = process.env.NOTION_ORDERS_DB;
  const existing = index ? index.get(o.orderNumber) : await findByTitle(dbId, "Order #", o.orderNumber);

  // Skip entirely if nothing meaningful changed — saves 2 API calls + sleep per order
  if (existing) {
    const sameStatus = (existing.properties["Status"]?.select?.name || "") === (o.status || "");
    const sameTracking = pageText(existing, "Tracking #") === (o.trackingNumber || "");
    const sameShipBy = (existing.properties["Ship By"]?.date?.start || null) === (o.shipBy || null);
    if (sameStatus && sameTracking && sameShipBy) return "skipped";
  }

  const props = {
    "Order #": { title: [{ text: { content: o.orderNumber } }] },
    "Order Date": dateOrNull(o.orderDate),
    "Ship By": dateOrNull(o.shipBy),
    "Status": selectOrNull(o.status),
    "Items": textProp(o.items),
    "Qty": { number: o.qty ?? null },
    "Total": { number: o.total ?? null },
    "Tracking #": textProp(o.trackingNumber),
    "Carrier": selectOrNull(o.carrier),
    "Tracking URL": { url: o.trackingUrl || null },
  };

  if (existing) {
    await notionFetch("/pages/" + existing.id, "PATCH", { properties: props });
    return "updated";
  }
  await notionFetch("/pages", "POST", {
    parent: { database_id: dbId },
    properties: props,
  });
  return "created";
}

async function upsertInventoryItem(item, reorderPointDefault, index) {
  const dbId = process.env.NOTION_INVENTORY_DB;
  const existing = index ? index.get(item.sku) : await findByTitle(dbId, "SKU", item.sku);

  // Preserve a manually-set Reorder Point if the row already exists
  let reorderPoint = reorderPointDefault;
  if (existing) {
    const rp = existing.properties["Reorder Point"]?.number;
    if (rp !== null && rp !== undefined) reorderPoint = rp;
  }

  let stockStatus = "In Stock";
  if (item.qtyAvailable === 0) stockStatus = "Out of Stock";
  else if (item.qtyAvailable !== null && item.qtyAvailable <= reorderPoint) stockStatus = "Low Stock";

  // Skip if nothing changed
  if (existing) {
    const sameQty = (existing.properties["Qty Available"]?.number ?? null) === (item.qtyAvailable ?? null);
    const samePrice = (existing.properties["Price"]?.number ?? null) === (item.price ?? null);
    const sameStatus = (existing.properties["Stock Status"]?.select?.name || "") === stockStatus;
    const samePublish = (existing.properties["Publish Status"]?.select?.name || "") === item.publishStatus;
    if (sameQty && samePrice && sameStatus && samePublish) return "skipped";
  }

  const props = {
    "SKU": { title: [{ text: { content: item.sku } }] },
    "Product Name": textProp(item.productName),
    "Item ID": textProp(item.itemId),
    "Price": { number: item.price ?? null },
    "Qty Available": { number: item.qtyAvailable ?? null },
    "Reorder Point": { number: reorderPoint },
    "Stock Status": selectOrNull(stockStatus),
    "Publish Status": selectOrNull(item.publishStatus),
  };

  if (existing) {
    await notionFetch("/pages/" + existing.id, "PATCH", { properties: props });
    return "updated";
  }
  await notionFetch("/pages", "POST", {
    parent: { database_id: dbId },
    properties: props,
  });
  return "created";
}

// Rebuild the Daily Pick List: upsert needed items, zero out anything no longer needed
async function syncPickList(pickItems) {
  const dbId = process.env.NOTION_PICKLIST_DB;
  if (!dbId) return;

  const existing = await queryAll(dbId);
  const existingByKey = new Map();
  for (const page of existing) {
    const key = page.properties["Product"]?.title?.map((t) => t.plain_text).join("") || "";
    existingByKey.set(key, page);
  }

  const neededKeys = new Set();
  for (const item of pickItems) {
    neededKeys.add(item.name);
    const props = {
      "Product": { title: [{ text: { content: item.name } }] },
      "SKU": textProp(item.sku),
      "Qty Needed": { number: item.qty },
      "Qty Due Today": { number: item.qtyDueToday ?? 0 },
      "Qty Due Tomorrow": { number: item.qtyDueTomorrow ?? 0 },
      "Open Orders": { number: item.orderCount },
      "Earliest Ship By": dateOrNull(item.earliestShipBy),
    };
    const page = existingByKey.get(item.name);
    if (page) {
      await notionFetch("/pages/" + page.id, "PATCH", { properties: props });
    } else {
      await notionFetch("/pages", "POST", { parent: { database_id: dbId }, properties: props });
    }
    await new Promise((r) => setTimeout(r, 350));
  }

  // Zero out items no longer needed (keeps history, hidden by the Pick Today view)
  for (const [key, page] of existingByKey) {
    if (neededKeys.has(key)) continue;
    const currentQty = page.properties["Qty Needed"]?.number;
    if (currentQty === 0) continue;
    await notionFetch("/pages/" + page.id, "PATCH", {
      properties: { "Qty Needed": { number: 0 }, "Qty Due Today": { number: 0 }, "Qty Due Tomorrow": { number: 0 }, "Open Orders": { number: 0 } },
    });
    await new Promise((r) => setTimeout(r, 350));
  }
}

// Pull current state back out of Notion for the daily digest
async function queryAll(databaseId) {
  const results = [];
  let cursor = undefined;
  do {
    const data = await notionFetch("/databases/" + databaseId + "/query", "POST", {
      start_cursor: cursor,
      page_size: 100,
    });
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return results;
}

module.exports = { upsertOrder, upsertInventoryItem, queryAll, syncPickList, buildIndex };
