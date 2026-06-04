"use strict";

/* ---------- Palette (Gumroad-like) ---------- */
const C = {
  pink: "#ff90e8",
  black: "#000000",
  green: "#23a094",
  red: "#dc341e",
  purple: "#90a8ed",
  orange: "#ffc900",
  grid: "rgba(0,0,0,0.08)",
};

/* ---------- Helpers ---------- */
const fmtMoney = (n) =>
  "$" + (n || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtMoney2 = (n) =>
  "$" + (n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = (n) => (n || 0).toLocaleString("en-US");

const parseDay = (s) => {
  if (!s) return null;
  const m = String(s).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
};
const monthKey = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const monthLabel = (key) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
};
const addMonths = (d, n) => {
  // Clamp to end of target month so e.g. Jan 31 + 1mo -> Feb 28/29, not Mar 3.
  const day = d.getUTCDate();
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, lastDay)));
};
const endOfMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0));
const intervalMonths = (recurrence) => (recurrence === "yearly" ? 12 : 1);
// Grace period (days) past the expected renewal before a sub is treated as lapsed.
const graceDays = (recurrence) => (recurrence === "yearly" ? 30 : 14);
const NOW = new Date();
const TODAY = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate()));

/* ---------- Core computation ---------- */
function buildModel(rawRows) {
  // Keep valid, non-fully-refunded charges.
  const rows = rawRows
    .filter((r) => r["Purchase ID"] && r["Purchase Date"])
    .map((r) => ({
      email: (r["Purchase Email"] || r["Buyer Email"] || "").toLowerCase(),
      date: parseDay(r["Purchase Date"]),
      net: parseFloat(r["Net Total ($)"]) || 0,
      recurrence: (r["Recurrence"] || "").trim(),
      tier: (r["Variants"] || "(Unknown)").trim() || "(Unknown)",
      isRecurringCharge: r["Recurring Charge?"] === "1",
      cancellation: parseDay(r["Cancellation Date"]),
      subEnd: parseDay(r["Subscription End Date"]),
      fullyRefunded: r["Fully Refunded?"] === "1",
    }))
    .filter((r) => r.date && !r.fullyRefunded);

  // Group charges into subscriptions by email.
  const byEmail = new Map();
  for (const r of rows) {
    if (!byEmail.has(r.email)) byEmail.set(r.email, []);
    byEmail.get(r.email).push(r);
  }
  for (const list of byEmail.values()) list.sort((a, b) => a.date - b.date);

  return { rows, byEmail };
}

function computeMetrics(model) {
  const { rows, byEmail } = model;

  /* --- Active subscriptions + current MRR --- */
  const active = [];
  let staleCount = 0, staleMrr = 0;
  const monthlyValue = (r) => (r.recurrence === "yearly" ? r.net / 12 : r.net);
  for (const list of byEmail.values()) {
    const last = list[list.length - 1];
    if (!last.recurrence) continue; // not a subscription
    const cancelled = !!last.cancellation;
    const ended = last.subEnd && last.subEnd < TODAY;
    if (cancelled || ended) continue;
    // Overdue beyond its billing period (+grace) with no renewal and no cancellation:
    // effectively lapsed (involuntary churn / comped account). Exclude from forecast.
    const due = addMonths(last.date, intervalMonths(last.recurrence));
    const stale = new Date(due.getTime() + graceDays(last.recurrence) * 864e5) < TODAY;
    if (stale) {
      staleCount++;
      staleMrr += monthlyValue(last);
      continue;
    }
    active.push(last);
  }

  const mrr = active.reduce((s, r) => s + monthlyValue(r), 0);

  const tierCounts = {};
  for (const r of active) tierCounts[r.tier] = (tierCounts[r.tier] || 0) + 1;

  const lifetimeNet = rows.reduce((s, r) => s + r.net, 0);
  const totalCustomers = byEmail.size;

  /* --- Forward forecast from active subscriptions --- */
  const horizon = addMonths(TODAY, 12);
  const forecastByMonth = new Map(); // monthKey -> net
  let next7 = 0, next30 = 0, next90 = 0, next12mo = 0;
  const d7 = new Date(TODAY.getTime() + 7 * 864e5);
  const d30 = new Date(TODAY.getTime() + 30 * 864e5);
  const d90 = new Date(TODAY.getTime() + 90 * 864e5);

  for (const r of active) {
    const step = intervalMonths(r.recurrence);
    let charge = new Date(r.date.getTime());
    // advance to first charge strictly after today
    while (charge <= TODAY) charge = addMonths(charge, step);
    while (charge <= horizon) {
      const key = monthKey(charge);
      forecastByMonth.set(key, (forecastByMonth.get(key) || 0) + r.net);
      if (charge <= d7) next7 += r.net;
      if (charge <= d30) next30 += r.net;
      if (charge <= d90) next90 += r.net;
      next12mo += r.net;
      charge = addMonths(charge, step);
    }
  }

  /* --- Historical month range --- */
  let minDate = null, maxDate = null;
  for (const r of rows) {
    if (!minDate || r.date < minDate) minDate = r.date;
    if (!maxDate || r.date > maxDate) maxDate = r.date;
  }
  const months = [];
  if (minDate) {
    let y = minDate.getUTCFullYear(), m = minDate.getUTCMonth();
    const ey = TODAY.getUTCFullYear(), em = TODAY.getUTCMonth();
    while (y < ey || (y === ey && m <= em)) {
      months.push({ y, m, key: `${y}-${String(m + 1).padStart(2, "0")}`, end: endOfMonth(y, m) });
      m++; if (m > 11) { m = 0; y++; }
    }
  }

  /* --- Historical committed MRR at each completed month end --- */
  // Exclude the current (still-open) month so the line doesn't dip from
  // renewals that simply haven't been charged yet this month.
  const mrrMonths = months.filter((mo) => mo.end < TODAY);
  const mrrSeries = mrrMonths.map(({ end }) => {
    let total = 0;
    for (const list of byEmail.values()) {
      // latest charge on/before month end
      let last = null;
      for (const r of list) {
        if (r.date <= end) last = r; else break;
      }
      if (!last || !last.recurrence) continue;
      // Drop once cancelled (committed-revenue view), consistent with current MRR.
      if (last.cancellation && last.cancellation <= end) continue;
      const coverEnd = addMonths(last.date, intervalMonths(last.recurrence));
      if (coverEnd > end) total += monthlyValue(last);
    }
    return total;
  });

  /* --- Actual net revenue per month --- */
  const revByMonth = new Map();
  for (const r of rows) revByMonth.set(monthKey(r.date), (revByMonth.get(monthKey(r.date)) || 0) + r.net);
  const revSeries = months.map((mo) => revByMonth.get(mo.key) || 0);

  /* --- New vs cancelled per month --- */
  const newByMonth = new Map();
  for (const list of byEmail.values()) {
    const first = list[0];
    newByMonth.set(monthKey(first.date), (newByMonth.get(monthKey(first.date)) || 0) + 1);
  }
  const cancelByMonth = new Map();
  const seenCancel = new Set();
  for (const list of byEmail.values()) {
    const last = list[list.length - 1];
    if (last.cancellation && !seenCancel.has(last.email)) {
      seenCancel.add(last.email);
      cancelByMonth.set(monthKey(last.cancellation), (cancelByMonth.get(monthKey(last.cancellation)) || 0) + 1);
    }
  }
  const newSeries = months.map((mo) => newByMonth.get(mo.key) || 0);
  const cancelSeries = months.map((mo) => -(cancelByMonth.get(mo.key) || 0));

  // Forecast chart window: previous 4 months + current month + next 7 months = 12.
  // Past/current actuals come from received revenue; current-remaining + future
  // come from projected renewals (generated strictly after today, so no overlap).
  const fMonths = [];
  let fc = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth() - 4, 1));
  for (let i = 0; i < 12; i++) {
    fMonths.push(monthKey(fc));
    fc = addMonths(fc, 1);
  }
  const currentKey = monthKey(TODAY);
  const currentIdx = fMonths.indexOf(currentKey);
  const forecastActual = fMonths.map((k) => revByMonth.get(k) || 0);
  const forecastProjected = fMonths.map((k) => forecastByMonth.get(k) || 0);

  return {
    activeCount: active.length,
    mrr, arr: mrr * 12,
    staleCount, staleMrr,
    lifetimeNet, totalCustomers,
    latestDate: maxDate,
    avgPerSub: active.length ? mrr / active.length : 0,
    tierCounts,
    forecast: {
      next7, next30, next90, next12mo,
      months: fMonths, actual: forecastActual, projected: forecastProjected, currentIdx,
    },
    monthLabels: months.map((mo) => mo.key),
    mrrLabels: mrrMonths.map((mo) => mo.key),
    mrrSeries, revSeries, newSeries, cancelSeries,
  };
}

/* ---------- Rendering ---------- */
let charts = [];
function destroyCharts() { charts.forEach((c) => c.destroy()); charts = []; }

const baseFont = { family: "ABeeZee, sans-serif" };
const gridOpts = { grid: { color: C.grid }, ticks: { font: baseFont, color: C.black } };

function card(label, value, sub, accent) {
  return `<div class="card${accent ? " accent" : ""}">
    <div class="label">${label}</div>
    <div class="value">${value}</div>
    ${sub ? `<div class="sub">${sub}</div>` : ""}
  </div>`;
}

function render(M) {
  document.getElementById("dropzone").hidden = true;
  const dash = document.getElementById("dashboard");
  dash.hidden = false;
  destroyCharts();

  const asOf = document.getElementById("dataAsOf");
  asOf.hidden = false;
  document.getElementById("loadBtn").hidden = false;
  asOf.textContent = M.latestDate
    ? "Data as of " + M.latestDate.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
    : "";

  /* Stat cards */
  document.getElementById("cards").innerHTML = [
    card("Net MRR", fmtMoney2(M.mrr), `${fmtMoney2(M.arr)} ARR`, true),
    card("Active subscribers", fmtInt(M.activeCount), `${fmtMoney2(M.avgPerSub)} avg / mo`),
    card("Lifetime net revenue", fmtMoney(M.lifetimeNet)),
    card("Total customers", fmtInt(M.totalCustomers), "all time"),
  ].join("");

  /* Forecast cards */
  document.getElementById("forecastCards").innerHTML = [
    card("Next 7 days", fmtMoney2(M.forecast.next7), null, true),
    card("Next 30 days", fmtMoney2(M.forecast.next30)),
    card("Next 90 days", fmtMoney2(M.forecast.next90)),
    card("Next 12 months", fmtMoney(M.forecast.next12mo)),
  ].join("");

  const staleNote = document.getElementById("staleNote");
  if (M.staleCount > 0) {
    staleNote.textContent =
      `⚠ Excludes ${fmtInt(M.staleCount)} overdue subscription${M.staleCount === 1 ? "" : "s"} ` +
      `(${fmtMoney2(M.staleMrr)}/mo) past their renewal date with no recent charge or cancellation on record.`;
  } else {
    staleNote.textContent = "";
  }

  const fLabels = M.forecast.months.map(monthLabel);

  /* Forecast chart: actual received (past + month-to-date) + projected renewals */
  charts.push(new Chart(document.getElementById("forecastChart"), {
    type: "bar",
    data: {
      labels: fLabels,
      datasets: [
        {
          label: "Received",
          data: M.forecast.actual,
          backgroundColor: C.purple,
          borderColor: C.black,
          borderWidth: 1,
          stack: "income",
        },
        {
          label: "Projected",
          data: M.forecast.projected,
          backgroundColor: C.pink,
          borderColor: C.black,
          borderWidth: 1,
          stack: "income",
        },
      ],
    },
    options: {
      ...chartOpts((v) => fmtMoney(v)),
      scales: { x: { stacked: true, ...gridOpts }, y: { stacked: true, beginAtZero: true, ...gridOpts, ticks: { ...gridOpts.ticks, callback: (v) => fmtMoney(v) } } },
    },
  }));

  const labels = M.monthLabels.map(monthLabel);

  /* MRR chart (excludes the current, still-open month) */
  charts.push(new Chart(document.getElementById("mrrChart"), {
    type: "line",
    data: {
      labels: M.mrrLabels.map(monthLabel),
      datasets: [{
        label: "Net MRR",
        data: M.mrrSeries,
        borderColor: C.black,
        backgroundColor: "rgba(255,144,232,0.35)",
        fill: true,
        tension: 0.25,
        pointRadius: 0,
        borderWidth: 2,
      }],
    },
    options: chartOpts((v) => fmtMoney(v)),
  }));

  /* Revenue chart */
  charts.push(new Chart(document.getElementById("revenueChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Net revenue",
        data: M.revSeries,
        backgroundColor: C.purple,
        borderColor: C.black,
        borderWidth: 1,
      }],
    },
    options: chartOpts((v) => fmtMoney(v)),
  }));

  /* Growth chart */
  charts.push(new Chart(document.getElementById("growthChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "New", data: M.newSeries, backgroundColor: C.green, borderColor: C.black, borderWidth: 1, stack: "s" },
        { label: "Cancelled", data: M.cancelSeries, backgroundColor: C.red, borderColor: C.black, borderWidth: 1, stack: "s" },
      ],
    },
    options: {
      ...chartOpts((v) => Math.abs(v)),
      scales: { x: { stacked: true, ...gridOpts }, y: { stacked: true, ...gridOpts } },
    },
  }));

  /* Tier doughnut */
  const tierLabels = Object.keys(M.tierCounts);
  charts.push(new Chart(document.getElementById("tierChart"), {
    type: "doughnut",
    data: {
      labels: tierLabels,
      datasets: [{
        data: tierLabels.map((t) => M.tierCounts[t]),
        backgroundColor: [C.pink, C.purple, C.green, C.orange, C.red],
        borderColor: C.black,
        borderWidth: 1,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: "right", labels: { font: baseFont, color: C.black } } },
    },
  }));
}

function chartOpts(fmt) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { font: baseFont, color: C.black } },
      tooltip: {
        callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmt(ctx.parsed.y ?? ctx.parsed)}` },
      },
    },
    scales: {
      x: gridOpts,
      y: { beginAtZero: true, ...gridOpts, ticks: { ...gridOpts.ticks, callback: (v) => fmt(v) } },
    },
  };
}

/* ---------- Node test hook ---------- */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { buildModel, computeMetrics, render };
}

/* ---------- File loading + DOM wiring (browser only) ---------- */
if (typeof document !== "undefined") {
  const handleFile = (file) => {
  document.getElementById("fileLabel").textContent = file.name;
  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete: (res) => {
      try {
        const model = buildModel(res.data);
        if (!model.rows.length) {
          alert("No valid sales rows found in this CSV.");
          return;
        }
        render(computeMetrics(model));
      } catch (e) {
        console.error(e);
        alert("Could not process this CSV: " + e.message);
      }
    },
    error: (err) => alert("Failed to read CSV: " + err.message),
  });
  };

  document.getElementById("loadBtn").addEventListener("click", () => document.getElementById("fileInput").click());
  document.getElementById("dropBtn").addEventListener("click", () => document.getElementById("fileInput").click());
  document.getElementById("fileInput").addEventListener("change", (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });

  const dz = document.getElementById("dropzone");
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("dragover"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("dragover"); })
  );
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
}
