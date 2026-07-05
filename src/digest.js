// Daily digest email via Brevo (transactional email API)
const { queryAll } = require("./notion");

function getProp(page, name) {
  const p = page.properties[name];
  if (!p) return null;
  switch (p.type) {
    case "title": return p.title.map((t) => t.plain_text).join("");
    case "rich_text": return p.rich_text.map((t) => t.plain_text).join("");
    case "number": return p.number;
    case "select": return p.select?.name || null;
    case "date": return p.date?.start || null;
    case "url": return p.url;
    default: return null;
  }
}

async function buildDigest() {
  const today = new Date().toISOString().slice(0, 10);
  const orders = await queryAll(process.env.NOTION_ORDERS_DB);
  const inventory = await queryAll(process.env.NOTION_INVENTORY_DB);

  const needsShipment = [];
  const shippingLate = [];
  const newToday = [];
  const shippedYesterday = [];

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  for (const page of orders) {
    const status = getProp(page, "Status");
    const orderNum = getProp(page, "Order #");
    const orderDate = getProp(page, "Order Date");
    const shipBy = getProp(page, "Ship By");
    const items = getProp(page, "Items");
    const total = getProp(page, "Total");
    const tracking = getProp(page, "Tracking #");

    const row = { orderNum, orderDate, shipBy, items, total, tracking, status };

    if (status === "Created" || status === "Acknowledged") {
      needsShipment.push(row);
      if (shipBy && shipBy < today) shippingLate.push(row);
    }
    if (orderDate === today || orderDate === yesterday) newToday.push(row);
    if (status === "Shipped" && page.last_edited_time.slice(0, 10) >= yesterday) {
      shippedYesterday.push(row);
    }
  }

  const lowStock = inventory
    .filter((p) => {
      const s = getProp(p, "Stock Status");
      return s === "Low Stock" || s === "Out of Stock";
    })
    .map((p) => ({
      sku: getProp(p, "SKU"),
      name: getProp(p, "Product Name"),
      qty: getProp(p, "Qty Available"),
      status: getProp(p, "Stock Status"),
    }));

  // Pick list: what to pull today to fulfill all open orders
  let pickList = [];
  if (process.env.NOTION_PICKLIST_DB) {
    const pickPages = await queryAll(process.env.NOTION_PICKLIST_DB);
    pickList = pickPages
      .map((p) => ({
        product: getProp(p, "Product"),
        sku: getProp(p, "SKU"),
        qty: getProp(p, "Qty Needed"),
        orders: getProp(p, "Open Orders"),
        shipBy: getProp(p, "Earliest Ship By"),
      }))
      .filter((p) => (p.qty || 0) > 0)
      .sort((a, b) => (b.qty || 0) - (a.qty || 0));
  }

  return { today, needsShipment, shippingLate, newToday, shippedYesterday, lowStock, pickList };
}

function renderHtml(d) {
  const orderRows = (list) =>
    list.length === 0
      ? "<p style='color:#888'>None</p>"
      : "<table border='0' cellpadding='6' style='border-collapse:collapse;font-size:14px'>" +
        "<tr style='background:#f4f4f4'><th align='left'>Order</th><th align='left'>Items</th><th align='left'>Ship By</th><th align='left'>Total</th></tr>" +
        list
          .map(
            (o) =>
              "<tr style='border-bottom:1px solid #eee'><td><b>" + (o.orderNum || "") + "</b></td><td>" +
              (o.items || "") + "</td><td>" + (o.shipBy || "-") + "</td><td>$" +
              (o.total != null ? o.total.toFixed(2) : "-") + "</td></tr>"
          )
          .join("") +
        "</table>";

  const stockRows =
    d.lowStock.length === 0
      ? "<p style='color:#888'>All SKUs stocked</p>"
      : "<table border='0' cellpadding='6' style='border-collapse:collapse;font-size:14px'>" +
        "<tr style='background:#f4f4f4'><th align='left'>SKU</th><th align='left'>Product</th><th align='left'>Qty</th><th align='left'>Status</th></tr>" +
        d.lowStock
          .map(
            (s) =>
              "<tr style='border-bottom:1px solid #eee'><td>" + s.sku + "</td><td>" + (s.name || "") +
              "</td><td>" + (s.qty ?? "-") + "</td><td style='color:" +
              (s.status === "Out of Stock" ? "#c0392b" : "#e67e22") + "'><b>" + s.status + "</b></td></tr>"
          )
          .join("") +
        "</table>";

  const pickRows =
    d.pickList.length === 0
      ? "<p style='color:#888'>Nothing to pick - all orders shipped</p>"
      : "<table border='0' cellpadding='6' style='border-collapse:collapse;font-size:14px'>" +
        "<tr style='background:#f4f4f4'><th align='left'>Product</th><th align='left'>Qty Needed</th><th align='left'>Orders</th><th align='left'>Earliest Ship By</th></tr>" +
        d.pickList
          .map(
            (p) =>
              "<tr style='border-bottom:1px solid #eee'><td>" + (p.product || "") +
              "</td><td style='font-size:16px'><b>" + (p.qty ?? "-") + "</b></td><td>" +
              (p.orders ?? "-") + "</td><td>" + (p.shipBy || "-") + "</td></tr>"
          )
          .join("") +
        "</table>";

  return (
    "<div style='font-family:Arial,sans-serif;max-width:640px'>" +
    "<h2>Sa'Venttii Walmart Daily Digest - " + d.today + "</h2>" +
    "<h3>Today's Pick List - " + d.pickList.length + " products</h3>" + pickRows +
    (d.shippingLate.length > 0
      ? "<h3 style='color:#c0392b'>LATE - Ship immediately (" + d.shippingLate.length + ")</h3>" + orderRows(d.shippingLate)
      : "") +
    "<h3>Needs Shipment (" + d.needsShipment.length + ")</h3>" + orderRows(d.needsShipment) +
    "<h3>New Orders - last 48h (" + d.newToday.length + ")</h3>" + orderRows(d.newToday) +
    "<h3>Shipped Since Yesterday (" + d.shippedYesterday.length + ")</h3>" + orderRows(d.shippedYesterday) +
    "<h3>Restock Alerts (" + d.lowStock.length + ")</h3>" + stockRows +
    "<p style='margin-top:24px;font-size:12px;color:#888'>Full dashboard in Notion &rarr; Walmart Orders / Walmart Inventory</p>" +
    "</div>"
  );
}

async function sendDigest() {
  const digest = await buildDigest();
  const html = renderHtml(digest);

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": process.env.BREVO_API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      sender: { name: "Sa'Venttii Ops", email: process.env.DIGEST_FROM_EMAIL },
      to: [{ email: process.env.DIGEST_TO_EMAIL }],
      subject:
        "Walmart Daily: " +
        digest.needsShipment.length + " to ship" +
        (digest.shippingLate.length > 0 ? " (" + digest.shippingLate.length + " LATE)" : "") +
        ", " + digest.lowStock.length + " restock alerts",
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error("Brevo send failed (" + res.status + "): " + text);
  }
  console.log("[digest] Sent for " + digest.today);
}

module.exports = { sendDigest };
