// ============================================================
// Notion client (v7)
// Universal resolver: every database works whether it's on Notion's
// classic architecture or the new data-source architecture, and
// whether the env var holds a database ID or a data source ID.
// ============================================================
const NOTION_BASE = "https://api.notion.com/v1";
const CLASSIC_VERSION = "2022-06-28";
const DS_VERSION = "2025-09-03";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function notionFetch(path, method, body, version) {
  const res = await fetch(NOTION_BASE + path, {
    method,
    headers: {
      "Authorization": "Bearer " + process.env.NOTION_TOKEN,
      "Notion-Version": version || CLASSIC_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("Notion " + method + " " + path + " failed (" + res.status + "): " + text.slice(0, 400));
  }
  return res.json();
}

// ---- Resolver -------------------------------------------------
// Probes each database ONCE per boot and caches how to talk to it:
//   { mode: "classic", id }  -> POST /databases/{id}/query  (2022-06-28)
//   { mode: "ds", id }       -> POST /data_sources/{id}/query (2025-09-03)
const handles = new Map();

async function resolveDb(label, rawId) {
  if (!rawId) throw new Error(label + ": env var is empty");
  if (handles.has(rawId)) return handles.get(rawId);

  // Attempt 1: classic database query (works for pre-migration databases)
  try {
    await notionFetch("/databases/" + rawId + "/query", "POST", { page_size: 1 });
    const h = { mode: "classic", id: rawId };
    handles.set(rawId, h);
    console.log("[notion] " + label + ": classic database (" + rawId.slice(0, 8) + "...)");
    return h;
  } catch (e) { /* next */ }

  // Attempt 2: the ID is a data source ID (new architecture)
  try {
    await notionFetch("/data_sources/" + rawId + "/query", "POST", { page_size: 1 }, DS_VERSION);
    const h = { mode: "ds", id: rawId };
    handles.set(rawId, h);
    console.log("[notion] " + label + ": data source (" + rawId.slice(0, 8) + "...)");
    return h;
  } catch (e) { /* next */ }

  // Attempt 3: the ID is a database ID on the new architecture -> discover its data source
  const db = await notionFetch("/databases/" + rawId, "GET", null, DS_VERSION);
  const ds = db && db.data_sources && db.data_sources[0] && db.data_sources[0].id;
  if (!ds) throw new Error(label + ": could not resolve " + rawId + " on any Notion API path");
  await notionFetch("/data_sources/" + ds + "/query", "POST", { page_size: 1 }, DS_VERSION);
  const h = { mode: "ds", id: ds };
  handles.set(rawId, h);
  console.log("[notion] " + label + ": database -> data source " + ds.slice(0, 8) + "...");
  return h;
}

async function queryAll(handle) {
  const results = [];
  let cursor = undefined;
  do {
    const data = handle.mode === "ds"
      ? await notionFetch("/data_sources/" + handle.id + "/query", "POST", { start_cursor: cursor, page_size: 100 }, DS_VERSION)
      : await notionFetch("/databases/" + handle.id + "/query", "POST", { start_cursor: cursor, page_size: 100 });
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return results;
}

async function createPage(handle, properties) {
  if (handle.mode === "ds") {
    return notionFetch("/pages", "POST", {
      parent: { type: "data_source_id", data_source_id: handle.id },
      properties,
    }, DS_VERSION);
  }
  return notionFetch("/pages", "POST", {
    parent: { database_id: handle.id },
    properties,
  });
}

async function patchPage(pageId, properties) {
  return notionFetch("/pages/" + pageId, "PATCH", { properties });
}

// ---- Property helpers -----------------------------------------
function selectOrNull(v) { return v ? { select: { name: v } } : { select: null }; }
function textProp(v) { return { rich_text: v ? [{ text: { content: String(v).slice(0, 2000) } }] : [] }; }
function dateOrNull(v) { return v ? { date: { start: v } } : { date: null }; }
function pageTitle(page, prop) { return (page.properties[prop]?.title || []).map((t) => t.plain_text).join(""); }
function pageText(page, prop) { return (page.properties[prop]?.rich_text || []).map((t) => t.plain_text).join(""); }
function pageNumber(page, prop) { return page.properties[prop]?.number ?? null; }
function pageSelect(page, prop) { return page.properties[prop]?.select?.name || ""; }
function pageDate(page, prop) { return page.properties[prop]?.date?.start || null; }

// Load ALL rows once, indexed by title. One query per 100 rows instead of one per record.
async function buildIndex(handle, titleProp) {
  const pages = await queryAll(handle);
  const map = new Map();
  for (const p of pages) map.set(pageTitle(p, titleProp), p);
  return map;
}

// ---- Orders ----------------------------------------------------
async function upsertOrder(handle, o, index) {
  const existing = index.get(o.orderNumber);

  // Skip if nothing meaningful changed - saves API calls + throttle sleep
  if (existing) {
    const same =
      pageSelect(existing, "Status") === (o.status || "") &&
      pageText(existing, "Tracking #") === (o.trackingNumber || "") &&
      pageDate(existing, "Ship By") === (o.shipBy || null);
    if (same) return "skipped";
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

  if (existing) { await patchPage(existing.id, props); return "updated"; }
  await createPage(handle, props);
  return "created";
}

// ---- Inventory -------------------------------------------------
async function upsertInventoryItem(handle, item, reorderPointDefault, index) {
  const existing = index.get(item.sku);

  // Preserve a manually-set Reorder Point
  let reorderPoint = reorderPointDefault;
  if (existing) {
    const rp = pageNumber(existing, "Reorder Point");
    if (rp !== null && rp !== undefined) reorderPoint = rp;
  }

  let stockStatus = "In Stock";
  if (item.qtyAvailable === 0) stockStatus = "Out of Stock";
  else if (item.qtyAvailable !== null && item.qtyAvailable <= reorderPoint) stockStatus = "Low Stock";

  if (existing) {
    const same =
      pageNumber(existing, "Qty Available") === (item.qtyAvailable ?? null) &&
      pageNumber(existing, "Price") === (item.price ?? null) &&
      pageSelect(existing, "Stock Status") === stockStatus &&
      pageSelect(existing, "Publish Status") === item.publishStatus;
    if (same) return "skipped";
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

  if (existing) { await patchPage(existing.id, props); return "updated"; }
  await createPage(handle, props);
  return "created";
}

// ---- Daily Pick List (per-product totals with per-date splits) --
async function syncPickList(handle, pickItems) {
  const existingByKey = await buildIndex(handle, "Product");
  const neededKeys = new Set();

  for (const item of pickItems) {
    neededKeys.add(item.name);
    const existing = existingByKey.get(item.name);
    if (existing) {
      const same =
        pageNumber(existing, "Qty Needed") === item.qty &&
        pageNumber(existing, "Qty Due Today") === item.qtyDueToday &&
        pageNumber(existing, "Qty Due Tomorrow") === item.qtyDueTomorrow &&
        pageNumber(existing, "Open Orders") === item.orderCount;
      if (same) continue;
    }
    const props = {
      "Product": { title: [{ text: { content: item.name } }] },
      "SKU": textProp(item.sku),
      "Qty Needed": { number: item.qty },
      "Qty Due Today": { number: item.qtyDueToday ?? 0 },
      "Qty Due Tomorrow": { number: item.qtyDueTomorrow ?? 0 },
      "Open Orders": { number: item.orderCount },
      "Earliest Ship By": dateOrNull(item.earliestShipBy),
    };
    if (existing) await patchPage(existing.id, props);
    else await createPage(handle, props);
    await sleep(350);
  }

  // Shipped -> zero out so views hide the row
  for (const [key, page] of existingByKey) {
    if (neededKeys.has(key)) continue;
    if ((pageNumber(page, "Qty Needed") ?? 0) === 0) continue;
    await patchPage(page.id, {
      "Qty Needed": { number: 0 }, "Qty Due Today": { number: 0 },
      "Qty Due Tomorrow": { number: 0 }, "Open Orders": { number: 0 },
    });
    await sleep(350);
  }
}

// ---- Pick Schedule (one row per product per ship-by date) -------
async function syncPickByDate(handle, rows) {
  const keyOf = (t, d) => t + "|" + (d || "");
  const existing = await queryAll(handle);
  const byKey = new Map();
  for (const page of existing) {
    byKey.set(keyOf(pageTitle(page, "Product"), pageDate(page, "Date") || ""), page);
  }

  const needed = new Set();
  for (const r of rows) {
    const k = keyOf(r.name, r.date);
    needed.add(k);
    const page = byKey.get(k);
    if (page) {
      const same =
        pageNumber(page, "Qty") === r.qty &&
        pageNumber(page, "Open Orders") === r.orderCount;
      if (same) continue;
      await patchPage(page.id, { "Qty": { number: r.qty }, "Open Orders": { number: r.orderCount } });
    } else {
      await createPage(handle, {
        "Product": { title: [{ text: { content: r.name } }] },
        "SKU": textProp(r.sku),
        "Date": dateOrNull(r.date),
        "Qty": { number: r.qty },
        "Open Orders": { number: r.orderCount },
      });
    }
    await sleep(350);
  }

  for (const [k, page] of byKey) {
    if (needed.has(k)) continue;
    if ((pageNumber(page, "Qty") ?? 0) === 0) continue;
    await patchPage(page.id, { "Qty": { number: 0 }, "Open Orders": { number: 0 } });
    await sleep(350);
  }
}

module.exports = {
  resolveDb, queryAll, buildIndex,
  upsertOrder, upsertInventoryItem, syncPickList, syncPickByDate,
  pageTitle, pageText, pageNumber, pageSelect, pageDate,
};
