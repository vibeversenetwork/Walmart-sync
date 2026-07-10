// Daily digest email via Brevo (transactional email API)
const { queryAll } = require("./notion");

// Eastern-time dates (UTC was drifting evening dates a day ahead)
function etDate(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

// Rotates daily - mix of scripture (KJV), affirmations, and builder energy
const DAILY_ENCOURAGEMENT = [
  "\"She is clothed with strength and dignity; she can laugh at the days to come.\" - Proverbs 31:25",
  "\"And let us not be weary in well doing: for in due season we shall reap, if we faint not.\" - Galatians 6:9",
  "\"Commit thy works unto the LORD, and thy thoughts shall be established.\" - Proverbs 16:3",
  "You are building something your future self will thank you for.",
  "\"The soul of the diligent shall be made fat.\" - Proverbs 13:4",
  "Systems over stress. You already proved you can do hard things.",
  "\"I can do all things through Christ which strengtheneth me.\" - Philippians 4:13",
  "Every order shipped is a brick in the empire. Lay today's bricks.",
  "\"For I know the thoughts that I think toward you, saith the LORD, thoughts of peace, and not of evil, to give you an expected end.\" - Jeremiah 29:11",
  "Profit is a byproduct of discipline. You have both.",
  "\"Seest thou a man diligent in his business? he shall stand before kings.\" - Proverbs 22:29",
  "Small consistent days build unrecognizable years.",
  "\"Trust in the LORD with all thine heart; and lean not unto thine own understanding.\" - Proverbs 3:5",
  "You didn't come this far to only come this far.",
  "\"Delight thyself also in the LORD; and he shall give thee the desires of thine heart.\" - Psalm 37:4",
  "CEO move of the day: work the system, don't let the day work you.",
  "\"Be strong and of a good courage; be not afraid... for the LORD thy God is with thee whithersoever thou goest.\" - Joshua 1:9",
  "Your only competition is yesterday's version of this business.",
  "\"The blessing of the LORD, it maketh rich, and he addeth no sorrow with it.\" - Proverbs 10:22",
  "Pack with purpose. Price with confidence. Rest without guilt.",
  "\"But they that wait upon the LORD shall renew their strength; they shall mount up with wings as eagles.\" - Isaiah 40:31",
  "A calm operator outperforms a busy one. Breathe, then execute.",
  "\"In all thy ways acknowledge him, and he shall direct thy paths.\" - Proverbs 3:6",
  "The margin is in the details. You see details other sellers skip.",
  "\"This is the day which the LORD hath made; we will rejoice and be glad in it.\" - Psalm 118:24",
  "Money loves order. Today, your business has both.",
  "\"Casting all your care upon him; for he careth for you.\" - 1 Peter 5:7",
  "Grow the winners. Cut the noise. Protect the cash.",
  "\"The LORD shall fight for you, and ye shall hold your peace.\" - Exodus 14:14",
  "One day this season will be the story you tell. Make it a good chapter.",
];

function getDailyEncouragement() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now - start) / 86400000);
  return DAILY_ENCOURAGEMENT[dayOfYear % DAILY_ENCOURAGEMENT.length];
}

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
  const today = etDate(0);
  const orders = await queryAll(process.env.NOTION_ORDERS_DB);
  const inventory = await queryAll(process.env.NOTION_INVENTORY_DB);

  const needsShipment = [];
  const shippingLate = [];
  const newToday = [];
  const shippedYesterday = [];

  const yesterday = etDate(-1);

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

  // OTD guardrail: unshipped orders due today or overdue
  const dueToday = needsShipment.filter((o) => o.shipBy && o.shipBy <= today);

  // Pick list: what to pull today to fulfill all open orders
  let pickList = [];
  if (process.env.NOTION_PICKLIST_DB) {
    const pickPages = await queryAll(process.env.NOTION_PICKLIST_DB);
    pickList = pickPages
      .map((p) => ({
        product: getProp(p, "Product"),
        sku: getProp(p, "SKU"),
        qty: getProp(p, "Qty Needed"),
        qtyToday: getProp(p, "Qty Due Today"),
        qtyTomorrow: getProp(p, "Qty Due Tomorrow"),
        orders: getProp(p, "Open Orders"),
        shipBy: getProp(p, "Earliest Ship By"),
      }))
      .filter((p) => (p.qty || 0) > 0)
      .sort((a, b) => (b.qty || 0) - (a.qty || 0));
  }

  return { today, needsShipment, shippingLate, newToday, shippedYesterday, lowStock, pickList, dueToday };
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

  const pickToday = d.pickList.filter((p) => (p.qtyToday || 0) > 0);
  const pickRows =
    pickToday.length === 0
      ? "<p style='color:#888'>Nothing to pick - all orders shipped</p>"
      : "<table border='0' cellpadding='6' style='border-collapse:collapse;font-size:14px'>" +
        "<tr style='background:#f4f4f4'><th align='left'>Product</th><th align='left'>Due Today</th><th align='left'>Also Open</th><th align='left'>Earliest Ship By</th></tr>" +
        pickToday
          .map(
            (p) =>
              "<tr style='border-bottom:1px solid #eee'><td>" + (p.product || "") +
              "</td><td style='font-size:16px'><b>" + (p.qtyToday ?? "-") + "</b></td><td>" +
              ((p.qty ?? 0) - (p.qtyToday ?? 0)) + "</td><td>" + (p.shipBy || "-") + "</td></tr>"
          )
          .join("") +
        "</table>";

  return (
    "<div style='font-family:Arial,sans-serif;max-width:640px'>" +
    "<h2>Sa'Venttii Walmart Daily Digest - " + d.today + "</h2>" +
    "<div style='background:#faf6ef;border-left:4px solid #2d5a3d;padding:14px 18px;margin:12px 0 20px 0;font-style:italic;color:#3d3d3d;font-size:15px;line-height:1.5'>" +
    getDailyEncouragement() +
    "</div>" +
    "<h3>Today's Pick List (due today) - " + d.pickList.filter((p)=> (p.qtyToday||0)>0).length + " products</h3>" + pickRows +
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
        digest.pickList.filter((p)=> (p.qtyToday||0)>0).length + " products to pick today" +
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

// OTD guardrail: afternoon tripwire. Sends ONLY if unshipped orders are due today or overdue.
// Suspension in June 2026 was caused by OTD dropping below 90% - this alert exists so that never repeats.
async function sendOTDAlert() {
  const d = await buildDigest();
  if (d.dueToday.length === 0) {
    console.log("[otd] All clear - no unshipped orders due today");
    return;
  }

  const rows = d.dueToday
    .map(
      (o) =>
        "<tr style='border-bottom:1px solid #eee'><td><b>" + (o.orderNum || "") + "</b></td><td>" +
        (o.items || "") + "</td><td style='color:#c0392b'><b>" + (o.shipBy || "") + "</b></td></tr>"
    )
    .join("");

  const html =
    "<div style='font-family:Arial,sans-serif;max-width:640px'>" +
    "<h2 style='color:#c0392b'>\u26a0\ufe0f OTD ALERT: " + d.dueToday.length + " order(s) must ship TODAY</h2>" +
    "<p>These are unshipped and at/past their ship-by date. Every one of these that ships late pushes OTD toward the 90% suspension line.</p>" +
    "<table border='0' cellpadding='6' style='border-collapse:collapse;font-size:14px'>" +
    "<tr style='background:#f4f4f4'><th align='left'>Order</th><th align='left'>Items</th><th align='left'>Ship By</th></tr>" +
    rows +
    "</table>" +
    "<p style='margin-top:16px'><b>Ship these before carrier cutoff.</b></p>" +
    "</div>";

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
      subject: "\ud83d\udea8 SHIP TODAY: " + d.dueToday.length + " order(s) at risk - protect OTD",
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error("Brevo OTD alert failed (" + res.status + "): " + text);
  }
  console.log("[otd] Alert sent - " + d.dueToday.length + " at-risk orders");
}

// End-of-day close-out: 8 PM ET. Day-specific status + the close-out checklist.
async function sendEOD() {
  const d = await buildDigest();
  const tomorrow = etDate(1);
  const dueTomorrow = d.needsShipment.filter((o) => o.shipBy === tomorrow);

  const blocker =
    d.dueToday.length > 0
      ? "<div style='background:#fdecea;border-left:4px solid #c0392b;padding:12px 16px;margin:12px 0'><b style='color:#c0392b'>\u26d4 DO NOT CLOSE THE DAY: " +
        d.dueToday.length +
        " order(s) due today are still unshipped.</b> Ship or acknowledge these first: " +
        d.dueToday.map((o) => o.orderNum).join(", ") +
        "</div>"
      : "<div style='background:#eef7f0;border-left:4px solid #2d5a3d;padding:12px 16px;margin:12px 0'><b style='color:#2d5a3d'>\u2705 Shipping clear.</b> Nothing due today is unshipped.</div>";

  const pickTomorrow = d.pickList.filter((p) => (p.qtyTomorrow || 0) > 0);
  const pickPreview =
    pickTomorrow.length === 0
      ? "<p style='color:#888'>Nothing queued for tomorrow yet.</p>"
      : "<ul>" +
        pickTomorrow.map((p) => "<li><b>" + p.qtyTomorrow + "\u00d7</b> " + p.product + "</li>").join("") +
        "</ul>";

  const html =
    "<div style='font-family:Arial,sans-serif;max-width:640px'>" +
    "<h2>\ud83c\udf19 EOD Close-Out - " + d.today + "</h2>" +
    blocker +
    "<h3>Tomorrow's pull preview (" + pickTomorrow.length + " products, " + dueTomorrow.length + " orders due tomorrow)</h3>" +
    pickPreview +
    "<h3>Restock alerts: " + d.lowStock.length + "</h3>" +
    (d.lowStock.length > 0
      ? "<p>" + d.lowStock.slice(0, 6).map((s) => s.sku + " (" + (s.qty ?? "?") + ")").join(" \u00b7 ") + "</p>"
      : "<p style='color:#888'>All stocked.</p>") +
    "<h3>Close-out checklist</h3>" +
    "<ol>" +
    "<li>Shipping clear? (see banner above)</li>" +
    "<li>Tier 1 anchor on the restock list? \u2192 place the order tonight, not tomorrow</li>" +
    "<li>New orders after carrier cutoff? They're tomorrow's first pulls \u2014 already in the pick list</li>" +
    "<li>One line in the log: today's win / today's problem</li>" +
    "<li>Close Seller Center. The 7 AM digest opens tomorrow.</li>" +
    "</ol>" +
    "</div>";

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
        (d.dueToday.length > 0 ? "\u26d4 " : "\ud83c\udf19 ") +
        "EOD Close-Out: " +
        (d.dueToday.length > 0 ? d.dueToday.length + " MUST SHIP, " : "shipping clear, ") +
        pickTomorrow.length + " products queued for tomorrow",
      htmlContent: html,
    }),
  });
  if (!res.ok) throw new Error("Brevo EOD failed (" + res.status + "): " + await res.text());
  console.log("[eod] Close-out sent for " + d.today);
}

// System alert: emails when the sync itself is failing. The system watches itself.
async function sendSystemAlert(message) {
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
      subject: "\u26a0\ufe0f SYSTEM ALERT: Walmart sync is failing",
      htmlContent:
        "<div style='font-family:Arial,sans-serif;max-width:640px'>" +
        "<h2 style='color:#c0392b'>\u26a0\ufe0f The sync system needs attention</h2>" +
        "<p>" + message + "</p>" +
        "<p>Notion data is NOT updating until this is fixed. Check Railway deploy logs: " +
        "<a href='https://railway.com/project/66e410a1-b8df-4f43-b91f-27cb5af12c42'>open Railway</a></p>" +
        "<p>Until fixed, work orders directly from Seller Center \u2014 do not trust the dashboard.</p>" +
        "</div>",
    }),
  });
  if (!res.ok) throw new Error("System alert send failed: " + res.status);
  console.log("[alert] System alert sent");
}

module.exports = { sendDigest, sendOTDAlert, sendEOD, sendSystemAlert };
