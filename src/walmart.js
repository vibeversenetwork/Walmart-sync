// Walmart Marketplace API client
// Docs: https://developer.walmart.com/api/us/mp/orders
const crypto = require("crypto");

const BASE = "https://marketplace.walmartapis.com";
let cachedToken = null;
let tokenExpiresAt = 0;

function wmHeaders(token) {
  return {
    "WM_SVC.NAME": "Walmart Marketplace",
    "WM_QOS.CORRELATION_ID": crypto.randomUUID(),
    "WM_SEC.ACCESS_TOKEN": token,
    "Accept": "application/json",
  };
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) return cachedToken;

  const auth = Buffer.from(
    process.env.WALMART_CLIENT_ID + ":" + process.env.WALMART_CLIENT_SECRET
  ).toString("base64");

  const res = await fetch(BASE + "/v3/token", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + auth,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "WM_SVC.NAME": "Walmart Marketplace",
      "WM_QOS.CORRELATION_ID": crypto.randomUUID(),
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error("Walmart token failed (" + res.status + "): " + body);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

async function wmGet(path) {
  const token = await getToken();
  const res = await fetch(BASE + path, { headers: wmHeaders(token) });
  if (!res.ok) {
    const body = await res.text();
    throw new Error("Walmart GET " + path + " failed (" + res.status + "): " + body);
  }
  return res.json();
}

// Fetch orders created in the last N days (default 14), following pagination
async function fetchOrders(days = 14) {
  const start = new Date(Date.now() - days * 86400000).toISOString();
  let path = "/v3/orders?createdStartDate=" + encodeURIComponent(start) + "&limit=100";
  const orders = [];

  while (path) {
    const data = await wmGet(path);
    const list = data?.list?.elements?.order || [];
    orders.push(...list);
    const next = data?.list?.meta?.nextCursor;
    path = next ? "/v3/orders" + next : null;
  }
  return orders.map(normalizeOrder);
}

function normalizeOrder(o) {
  const lines = o.orderLines?.orderLine || [];
  const items = lines
    .map((l) => (l.item?.productName || "Unknown") + " x" + (l.orderLineQuantity?.amount || 1))
    .join("; ");
  const qty = lines.reduce((s, l) => s + Number(l.orderLineQuantity?.amount || 1), 0);
  const total = lines.reduce((s, l) => {
    const charges = l.charges?.charge || [];
    return s + charges.reduce((cs, c) => cs + Number(c.chargeAmount?.amount || 0), 0);
  }, 0);

  // Status: use the most advanced line status
  const statuses = lines.flatMap((l) =>
    (l.orderLineStatuses?.orderLineStatus || []).map((s) => s.status)
  );
  const rank = { Created: 0, Acknowledged: 1, Shipped: 2, Delivered: 3, Cancelled: 4, Refund: 5 };
  let status = "Created";
  for (const s of statuses) {
    if ((rank[s] ?? -1) > (rank[status] ?? -1)) status = s;
  }
  if (status === "Refund") status = "Refunded";

  // Tracking info from first shipped line
  let trackingNumber = "";
  let carrier = "";
  let trackingUrl = "";
  for (const l of lines) {
    for (const s of l.orderLineStatuses?.orderLineStatus || []) {
      const t = s.trackingInfo;
      if (t?.trackingNumber) {
        trackingNumber = t.trackingNumber;
        carrier = t.carrierName?.carrier || t.carrierName?.otherCarrier || "";
        trackingUrl = t.trackingURL || "";
        break;
      }
    }
    if (trackingNumber) break;
  }

  // Line-level detail for pick list aggregation
  const lineDetails = lines.map((l) => ({
    sku: l.item?.sku || "",
    name: l.item?.productName || "Unknown",
    qty: Number(l.orderLineQuantity?.amount || 1),
  }));

  // Ship-by: order-level estimate, falling back to earliest line-level ship date
  let shipBy = o.shippingInfo?.estimatedShipDate
    ? new Date(o.shippingInfo.estimatedShipDate).toISOString().slice(0, 10)
    : null;
  if (!shipBy) {
    for (const l of lines) {
      const d = l.fulfillment?.pickUpDateTime || l.statusDate;
      if (d) {
        const iso = new Date(d).toISOString().slice(0, 10);
        if (!shipBy || iso < shipBy) shipBy = iso;
      }
    }
  }

  return {
    orderNumber: o.purchaseOrderId,
    orderDate: o.orderDate ? new Date(o.orderDate).toISOString().slice(0, 10) : null,
    shipBy,
    status,
    items,
    qty,
    total: Math.round(total * 100) / 100,
    trackingNumber,
    carrier: normalizeCarrier(carrier),
    trackingUrl,
    lineDetails,
  };
}

function normalizeCarrier(c) {
  const up = (c || "").toUpperCase();
  if (up.includes("USPS")) return "USPS";
  if (up.includes("UPS")) return "UPS";
  if (up.includes("FEDEX")) return "FedEx";
  return c ? "Other" : "";
}

// Fetch all items + inventory levels
async function fetchInventory() {
  let path = "/v3/items?limit=200";
  const items = [];
  let offset = 0;

  while (true) {
    const data = await wmGet("/v3/items?limit=200&offset=" + offset);
    const list = data?.ItemResponse || [];
    items.push(...list);
    if (list.length < 200) break;
    offset += 200;
  }

  const results = [];
  for (const item of items) {
    let qty = null;
    try {
      const inv = await wmGet("/v3/inventory?sku=" + encodeURIComponent(item.sku));
      qty = Number(inv?.quantity?.amount ?? 0);
    } catch (e) {
      console.error("Inventory fetch failed for SKU " + item.sku + ": " + e.message);
    }
    results.push({
      sku: item.sku,
      productName: item.productName || "",
      itemId: item.wpid || item.itemId || "",
      price: Number(item.price?.amount ?? item.price ?? 0) || null,
      publishStatus: item.publishedStatus === "PUBLISHED" ? "Published" : "Unpublished",
      qtyAvailable: qty,
    });
  }
  return results;
}

module.exports = { fetchOrders, fetchInventory };
