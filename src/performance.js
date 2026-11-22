// ============================================================
// Seller Performance pull (v7.3)
// Daily 11:30 AM ET: pulls the 8 Seller Performance Standards from
// Walmart's Insights API and writes them to today's row in the
// "Walmart Daily Check-in" Notion database (Happy OrBritt reads it).
// Weekly Monday 11:35 AM ET: emails the order-level on-time delivery
// and late shipment reports (.xlsx) for Walmart cases.
// Balance / On hold / Note are never touched: Britt enters those.
// ============================================================
const { wmInsights } = require("./walmart");
const { resolveDb } = require("./notion");

const WALDAILY_DB = process.env.NOTION_WALDAILY_DB || "41e3c2cc-0439-817e-8d59-000b4e1af513";
const NOTION_BASE = "https://api.notion.com/v1";
const DS_VERSION = "2025-09-03";
const CLASSIC_VERSION = "2022-06-28";

// [Notion property, Insights path, window in days]
const METRICS = [
  ["On-time delivery", "/v3/insights/performance/otd/summary?reportDuration=30&shippingMethod=ALL_METHODS", 30],
  ["Cancellations", "/v3/insights/performance/cancellations/summary?reportDuration=30", 30],
  ["Valid tracking", "/v3/insights/performance/vtr/summary?reportDuration=30", 30],
  ["Seller response", "/v3/insights/performance/srr/summary?reportDuration=30", 30],
  ["Negative feedback", "/v3/insights/performance/negativeFeedback/summary?reportDuration=60", 60],
  ["Returns", "/v3/insights/performance/returns/summary?reportDuration=60", 60],
  ["Item not received", "/v3/insights/performance/itemNotReceived/summary?reportDuration=60", 60],
  ["Late shipment", "/v3/insights/performance/lateShipment/summary?reportDuration=30", 30],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const etDate = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const etStamp = () => new Date().toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const etTitle = () => new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }).replace(",", "");

function num(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace("%", ""));
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}

// Walmart's docs don't name the rate field for every summary, so look in
// the likely places in order, then fall back to any top-level "...Rate".
function pickRate(payload) {
  if (!payload || typeof payload !== "object") return null;
  for (const k of ["overallRate", "cumulativeRate", "rate", "metricValue", "value"]) {
    const n = num(payload[k]);
    if (n != null) return n;
  }
  for (const [k, v] of Object.entries(payload)) {
    if (/rate$/i.test(k) && !/trend/i.test(k) && !/sellerAccountable/i.test(k)) {
      const n = num(v);
      if (n != null) return n;
    }
  }
  return null;
}

function findKey(obj, re) {
  if (!obj) return null;
  const k = Object.keys(obj).find((x) => re.test(x) && obj[x] && typeof obj[x] === "object");
  return k ? obj[k] : null;
}
const sellerDrivers = (p) => findKey(p, /^sellerAccountable.*Drivers/i) || findKey(p, /sellerAccountable.*Driver/i);
const otherDrivers = (p) => findKey(p, /nonAccountable.*Drivers/i) || findKey(p, /NonAccountable/i);

function unwrap(json) {
  if (!json) return null;
  const p = json.payload || json.data || json;
  return Array.isArray(p) ? p[0] : p;
}

function driverLine(obj) {
  if (!obj || typeof obj !== "object") return "";
  const NAMES = { lateShipmentRate: "marked shipped late", lateHandoverToCarrierRate: "carrier's first scan came late",
    carrierEDDLaterThanEDDRate: "carrier's date later than promised", noCarrierScanRate: "no carrier scan",
    carrierMethodMismatchRate: "wrong carrier method", shipLocationMismatchRate: "wrong ship-from location",
    carrierDelaysRate: "carrier delays", weatherDelaysRate: "weather", carrierExceptionRate: "carrier exceptions",
    miscellaneousRate: "other (Walmart doesn't say)" };
  const nice = (k) => NAMES[k] || k.replace(/Rate$/, "").replace(/([A-Z]+)/g, " $1").trim().toLowerCase();
  return Object.entries(obj)
    .map(([k, v]) => [k, num(v)])
    .filter(([, v]) => v != null && v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => nice(k) + " " + v + "%")
    .join(", ");
}

// ---- Notion -----------------------------------------------------
async function notion(path, method, body, version) {
  const res = await fetch(NOTION_BASE + path, {
    method,
    headers: {
      "Authorization": "Bearer " + process.env.NOTION_TOKEN,
      "Notion-Version": version || CLASSIC_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error("Notion " + method + " " + path + " failed (" + res.status + "): " + (await res.text()).slice(0, 300));
  return res.json();
}

async function findTodayRow(h, today) {
  const filter = { property: "Date", date: { equals: today } };
  const data = h.mode === "ds"
    ? await notion("/data_sources/" + h.id + "/query", "POST", { filter, page_size: 5 }, DS_VERSION)
    : await notion("/databases/" + h.id + "/query", "POST", { filter, page_size: 5 });
  return (data.results || [])[0] || null;
}

// ---- Daily pull -------------------------------------------------
async function pullPerformance() {
  const values = {}, misses = [];
  let otd = null;
  for (const [prop, path] of METRICS) {
    try {
      const r = await wmInsights(path);
      if (r.status === 204) { misses.push(prop.toLowerCase() + " (no data yet)"); continue; }
      const p = unwrap(r.json);
      const rate = pickRate(p);
      if (rate == null) {
        misses.push(prop.toLowerCase() + " (no rate in: " + Object.keys(p || {}).slice(0, 12).join(", ") + ")");
        console.log("[perf] " + prop + " raw: " + JSON.stringify(r.json).slice(0, 600));
      } else values[prop] = rate;
      if (prop === "On-time delivery") otd = p;
    } catch (e) {
      misses.push(prop.toLowerCase() + " (" + (e.status || "error") + ")");
      console.error("[perf] " + prop + " FAILED: " + e.message);
    }
    await sleep(400);
  }
  return { values, misses, otd };
}

async function runPerformance() {
  const today = etDate();
  console.log("[perf] Pulling Seller Performance for " + today);
  const { values, misses, otd } = await pullPerformance();
  const got = Object.keys(values).length;

  const parts = ["Pulled " + etStamp() + ". Got " + got + " of 8."];
  const props = {};
  for (const [k, v] of Object.entries(values)) props[k] = { number: v };
  if (otd) {
    // Seller Center's on-time delivery (the one the 90% standard uses) is the
    // seller-accountable rate. overallRate also counts late orders Walmart says aren't the seller's fault.
    const mine = num(otd.sellerAccountableRate), all = num(otd.overallRate);
    if (mine != null) { values["On-time delivery"] = mine; props["On-time delivery"] = { number: mine }; }
    const acc = driverLine(sellerDrivers(otd));
    const non = driverLine(otherDrivers(otd));
    if (acc) props["OTD why"] = { rich_text: [{ text: { content: ("late because: " + acc).slice(0, 300) } }] };
    parts.push("On-time delivery " + (mine ?? "?") + "% (the one Seller Center shows)" + (all != null ? ", " + all + "% if you count every late order" : "") + ".");
    if (acc) parts.push("Counted against you (share of all orders): " + acc + ".");
    if (non) parts.push("Not counted against you: " + non + ".");
  }
  if (misses.length) parts.push("Missed: " + misses.join("; ") + ".");
  if (otd && process.env.PERF_DEBUG === "1") parts.push("Raw OTD: " + JSON.stringify(otd).slice(0, 1300));
  props["Auto pull"] = { rich_text: [{ text: { content: parts.join(" ").slice(0, 1900) } }] };

  if (!got && !otd) {
    console.error("[perf] Nothing came back: " + misses.join("; "));
    const allAuth = misses.length && misses.every((m) => /\((401|403)\)/.test(m));
    const err = new Error(allAuth
      ? "Walmart refused the Seller Performance API (401/403). Your API key needs Insights / Seller Performance access: Walmart Developer Portal > My Account > API keys > edit permissions."
      : "Seller Performance pull got nothing back: " + misses.join("; "));
    err.perfAlert = true;
    throw err;
  }

  const h = await resolveDb("Walmart Daily Check-in", WALDAILY_DB);
  const row = await findTodayRow(h, today);
  if (row) {
    await notion("/pages/" + row.id, "PATCH", { properties: props });
    console.log("[perf] Updated today's check-in: " + got + "/8 metrics");
  } else {
    props["Day"] = { title: [{ text: { content: etTitle() } }] };
    props["Date"] = { date: { start: today } };
    if (h.mode === "ds") await notion("/pages", "POST", { parent: { type: "data_source_id", data_source_id: h.id }, properties: props }, DS_VERSION);
    else await notion("/pages", "POST", { parent: { database_id: h.id }, properties: props });
    console.log("[perf] Created today's check-in: " + got + "/8 metrics");
  }
  return { got, misses };
}

// ---- Weekly reports (email with .xlsx attached) -----------------
async function fetchReport(path) {
  const r = await wmInsights(path, { file: true });
  if (r.status === 204) return null;
  if (r.buffer) return r.buffer;
  // Some report endpoints answer with JSON holding a download link.
  const j = r.json || {};
  const p = unwrap(j) || {};
  const url = p.downloadURL || p.downloadUrl || p.url || p.fileUrl || j.downloadURL || j.url;
  if (!url) { console.log("[perf] report JSON without link: " + JSON.stringify(j).slice(0, 400)); return null; }
  const res = await fetch(url);
  if (!res.ok) throw new Error("report download failed (" + res.status + ")");
  return Buffer.from(await res.arrayBuffer());
}

async function sendWeeklyReports() {
  const today = etDate();
  const files = [], notes = [];
  for (const [name, path] of [
    ["on-time-delivery-orders", "/v3/insights/performance/otd/report?reportDuration=30&shippingMethod=ALL_METHODS"],
    ["late-shipment-orders", "/v3/insights/performance/lateShipment/report?reportDuration=30"],
  ]) {
    try {
      const buf = await fetchReport(path);
      if (buf && buf.length) files.push({ name: name + "-" + today + ".xlsx", content: buf.toString("base64") });
      else notes.push(name.replace(/-/g, " ") + ": Walmart had no file this week");
    } catch (e) {
      notes.push(name.replace(/-/g, " ") + ": couldn't download (" + (e.status || "error") + ")");
      console.error("[perf] " + name + " FAILED: " + e.message);
    }
    await sleep(500);
  }

  let summary = "";
  try {
    const { values, otd } = await pullPerformance();
    const mine = otd ? num(otd.sellerAccountableRate) : null;
    summary = "<p><b>On-time delivery:</b> " + (mine ?? values["On-time delivery"] ?? "?") + "% (standard: 90%+)<br>" +
      "<b>Late shipment:</b> " + (values["Late shipment"] ?? "?") + "% (standard: under 5%)</p>" +
      (otd ? "<p>Counted against you: " + (driverLine(sellerDrivers(otd)) || "none listed") +
        "<br>Not counted against you: " + (driverLine(otherDrivers(otd)) || "none listed") + "</p>" : "");
  } catch (e) { /* summary is a bonus */ }

  const html = "<div style='font-family:Georgia,serif;color:#3b2a20'>" +
    "<h2>Your weekly Walmart late-order reports</h2>" + summary +
    "<p>" + (files.length ? "Attached: the order-level files Walmart uses to count these numbers. Open them, find orders you shipped on time, and add those order numbers to your open cases." : "No files came through this week.") + "</p>" +
    (notes.length ? "<p style='color:#8a6d5a'>" + notes.join("<br>") + "</p>" : "") +
    "</div>";

  const body = {
    sender: { name: "Sa'Venttii Ops", email: process.env.DIGEST_FROM_EMAIL },
    to: [{ email: process.env.DIGEST_TO_EMAIL }],
    subject: "Walmart weekly: late-order reports for your cases",
    htmlContent: html,
  };
  if (files.length) body.attachment = files;
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Brevo send failed (" + res.status + "): " + (await res.text()).slice(0, 300));
  console.log("[perf] Weekly report email sent with " + files.length + " file(s)");
}

module.exports = { runPerformance, sendWeeklyReports, pickRate };
