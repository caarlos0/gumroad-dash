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
const fmtDay = (iso) => {
  const d = parseDay(iso);
  return d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : iso;
};
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Gumroad wraps the plan name in parentheses, e.g. "(Personal)"; show it without them.
const stripParens = (s) => s.replace(/^\((.*)\)$/, "$1");

// Acronym tooltips shared with index.html. abbr(key) wraps the acronym in an <abbr>.
const ABBR = {
  MRR: "Monthly Recurring Revenue",
  ARR: "Annual Recurring Revenue",
  ARPU: "Average Revenue Per User (active subscriber)",
  LTV: "Lifetime Value",
  ROI: "Return on Investment",
};
const abbr = (key) => `<abbr title="${ABBR[key]}">${key}</abbr>`;

// Add n to the running total stored under key in a Map (0 if absent).
const bump = (map, key, n) => map.set(key, (map.get(key) || 0) + n);

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

// Committed-revenue snapshot: the charge that makes a subscription "active" as of `asOf`
// (latest charge on/before the date, still a subscription, not cancelled by then, and whose
// billing period still covers the date), or null. Shared by historical MRR, ARPU, churn and
// the MRR waterfall so those views can't drift definitionally. Note: no staleness grace here.
const committedSubAt = (list, asOf) => {
  let last = null;
  for (const r of list) {
    if (r.date <= asOf) last = r; else break;
  }
  if (!last || !last.recurrence) return null;
  if (last.cancellation && last.cancellation <= asOf) return null;
  if (addMonths(last.date, intervalMonths(last.recurrence)) <= asOf) return null;
  return last;
};
const NOW = new Date();
const TODAY = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate()));

// Item Price ($) is unreliable in real exports (often negative), so plan ranking is hardcoded.
const TIER_RANK = { "Personal": 1, "Startup": 2, "Business": 3, "Enterprise": 4 };

/* ---------- Core computation ---------- */
function buildModel(rawRows) {
  // Keep valid charges, dropping money we didn't keep:
  // - fully refunded rows (Gumroad leaves the original positive Net Total on them)
  // - lost chargebacks/disputes (Disputed? with Dispute Won? not set)
  // and reduce Net Total by any partial refund.
  const rows = rawRows
    .filter((r) => r["Purchase ID"] && r["Purchase Date"])
    .map((r) => ({
      email: (r["Purchase Email"] || r["Buyer Email"] || "").toLowerCase(),
      date: parseDay(r["Purchase Date"]),
      net: (parseFloat(r["Net Total ($)"]) || 0) - (parseFloat(r["Partial Refund ($)"]) || 0),
      recurrence: (r["Recurrence"] || "").trim(),
      tier: stripParens((r["Variants"] || "").trim()) || "Unknown",
      isRecurringCharge: r["Recurring Charge?"] === "1",
      cancellation: parseDay(r["Cancellation Date"]),
      subEnd: parseDay(r["Subscription End Date"]),
      fullyRefunded: r["Fully Refunded?"] === "1",
      chargeback: r["Disputed?"] === "1" && r["Dispute Won?"] !== "1",
      discountCode: (r["Discount Code"] || "").trim(),
      salePrice: parseFloat(r["Sale Price ($)"]) || 0,
      country: (r["Country"] || "").trim() || "(Unknown)",
    }))
    .filter((r) => r.date && !r.fullyRefunded && !r.chargeback);

  // Group charges into subscriptions by email.
  const byEmail = new Map();
  for (const r of rows) {
    if (!byEmail.has(r.email)) byEmail.set(r.email, []);
    byEmail.get(r.email).push(r);
  }
  for (const list of byEmail.values()) list.sort((a, b) => a.date - b.date);

  /* Refund/chargeback summary, computed from raw rows since the kept set drops
     fully-refunded and lost-chargeback charges. */
  const valid = rawRows.filter((r) => r["Purchase ID"] && r["Purchase Date"]);
  let fullyRefunded = 0, partialRefundTotal = 0, refundedAmount = 0, chargebacks = 0;
  for (const r of valid) {
    if (r["Fully Refunded?"] === "1") {
      fullyRefunded++;
      refundedAmount += parseFloat(r["Net Total ($)"]) || 0;
    }
    const partial = parseFloat(r["Partial Refund ($)"]) || 0;
    if (partial > 0) { partialRefundTotal += partial; refundedAmount += partial; }
    if (r["Disputed?"] === "1" && r["Dispute Won?"] !== "1") chargebacks++;
  }
  const refunds = {
    totalCharges: valid.length,
    fullyRefunded,
    chargebacks,
    partialRefundTotal,
    refundedAmount,
    rate: valid.length ? ((fullyRefunded + chargebacks) / valid.length) * 100 : 0,
  };

  return { rows, byEmail, refunds };
}

function computeMetrics(model) {
  const { rows, byEmail, refunds } = model;
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

  /* --- MRR split by recurrence and by tier (dollars, active subs) --- */
  const mrrByRecurrence = { monthly: 0, yearly: 0 };
  const mrrByTier = {};
  for (const r of active) {
    const v = monthlyValue(r);
    if (r.recurrence === "yearly") mrrByRecurrence.yearly += v;
    else mrrByRecurrence.monthly += v;
    mrrByTier[r.tier] = (mrrByTier[r.tier] || 0) + v;
  }

  const lifetimeNet = rows.reduce((s, r) => s + r.net, 0);
  const totalCustomers = byEmail.size;

  /* --- Customer lifetime & LTV --- */
  // All-time average revenue per customer, plus observed lifespan/value for
  // subscribers who have already churned (cancelled), which gives a grounded LTV.
  // Also broken down by each subscriber's final plan (their last charge's tier).
  const avgRevPerCustomer = totalCustomers ? lifetimeNet / totalCustomers : 0;
  const MS_PER_MONTH = 365.25 / 12 * 864e5;
  let churnedCount = 0, churnedLifespanSum = 0, churnedRevSum = 0;
  const tierLtv = new Map();
  for (const list of byEmail.values()) {
    const last = list[list.length - 1];
    if (!last.recurrence) continue;
    const net = list.reduce((a, r) => a + r.net, 0);
    const cancelled = !!last.cancellation;
    const lifespan = cancelled ? Math.max(0, (last.cancellation - list[0].date) / MS_PER_MONTH) : 0;
    if (cancelled) {
      churnedCount++;
      churnedLifespanSum += lifespan;
      churnedRevSum += net;
    }
    const t = tierLtv.get(last.tier) || { tier: last.tier, customers: 0, revenue: 0, churned: 0, lifespanSum: 0 };
    t.customers++; t.revenue += net;
    if (cancelled) { t.churned++; t.lifespanSum += lifespan; }
    tierLtv.set(last.tier, t);
  }
  const ltv = {
    avgRevPerCustomer,
    churnedCount,
    avgLifespanMonths: churnedCount ? churnedLifespanSum / churnedCount : 0,
    avgChurnedRevenue: churnedCount ? churnedRevSum / churnedCount : 0,
    byTier: [...tierLtv.values()]
      .map((t) => ({
        tier: t.tier,
        customers: t.customers,
        avgRevenue: t.customers ? t.revenue / t.customers : 0,
        avgLifespanMonths: t.churned ? t.lifespanSum / t.churned : null,
      }))
      .sort((a, b) => b.avgRevenue - a.avgRevenue),
  };

  /* --- Subscriber retention (Kaplan-Meier survival) curve --- */
  // Monthly discrete Kaplan-Meier: at each month the survival fraction is multiplied by
  // (1 - deaths/at-risk). Subscribers still active (or not yet old enough) are right-censored
  // at their account age, so they leave the risk set without counting as churn. Monotonic.
  const SURVIVAL_MONTHS = 24;
  const subjects = [];
  for (const list of byEmail.values()) {
    const first = list[0];
    if (!first.recurrence) continue; // subscribers only
    const last = list[list.length - 1];
    const age = (TODAY - first.date) / MS_PER_MONTH;
    const ended = last.cancellation || (last.subEnd && last.subEnd < TODAY ? last.subEnd : null);
    const churned = !!ended;
    const time = churned ? Math.max(0, (ended - first.date) / MS_PER_MONTH) : age;
    subjects.push({ churned, time });
  }
  const survivalSeries = [100];
  let surv = 1;
  for (let m = 0; m < SURVIVAL_MONTHS; m++) {
    let atRisk = 0, deaths = 0;
    for (const s of subjects) {
      if (s.time >= m) atRisk++;
      if (s.churned && s.time >= m && s.time < m + 1) deaths++;
    }
    if (atRisk > 0) surv *= 1 - deaths / atRisk;
    survivalSeries.push(surv * 100);
  }

  /* --- Plan changes (upgrades vs downgrades) --- */
  // Walk each customer's charges in order; count rank transitions between known tiers.
  let upgrades = 0, downgrades = 0, customersChanged = 0;
  for (const list of byEmail.values()) {
    let changed = false;
    for (let i = 1; i < list.length; i++) {
      const a = TIER_RANK[list[i - 1].tier], b = TIER_RANK[list[i].tier];
      if (!a || !b || a === b) continue;
      if (b > a) upgrades++; else downgrades++;
      changed = true;
    }
    if (changed) customersChanged++;
  }
  const tierChanges = { upgrades, downgrades, customersChanged };

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
      bump(forecastByMonth, key, r.net);
      if (charge <= d7) next7 += r.net;
      if (charge <= d30) next30 += r.net;
      if (charge <= d90) next90 += r.net;
      next12mo += r.net;
      charge = addMonths(charge, step);
    }
  }

  /* --- Renewals due in the next 30 days (from active subs) --- */
  const renewalsList = [];
  for (const r of active) {
    const next = addMonths(r.date, intervalMonths(r.recurrence));
    if (next > TODAY && next <= d30) {
      renewalsList.push({ email: r.email, date: monthKey(next) + "-" + String(next.getUTCDate()).padStart(2, "0"), net: r.net, tier: r.tier });
    }
  }
  renewalsList.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const renewals = {
    count: renewalsList.length,
    amount: renewalsList.reduce((s, x) => s + x.net, 0),
    list: renewalsList,
  };

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

  /* --- Historical committed MRR + ARPU at each completed month end --- */
  // Exclude the current (still-open) month so the line doesn't dip from
  // renewals that simply haven't been charged yet this month.
  const mrrMonths = months.filter((mo) => mo.end < TODAY);
  const committedMonths = mrrMonths.map(({ end }) => {
    let total = 0, count = 0;
    for (const list of byEmail.values()) {
      const sub = committedSubAt(list, end);
      if (sub) { total += monthlyValue(sub); count++; }
    }
    return { total, count };
  });
  const mrrSeries = committedMonths.map((c) => c.total);
  const arpuSeries = committedMonths.map((c) => (c.count ? c.total / c.count : 0));

  /* --- MRR movement (month-over-month waterfall) --- */
  // Between consecutive completed month ends, classify each subscriber's committed
  // monthly value: new, churned, expansion (tier/price up), contraction (down).
  // Aligned to mrrMonths starting at index 1 (the first month has no prior to compare).
  const moveLabels = mrrMonths.slice(1).map((mo) => mo.key);
  const moveNew = [], moveExpansion = [], moveChurned = [], moveContraction = [];
  // Monthly churn rates over the same transitions (null when no one was active at the start).
  const logoChurnSeries = [], revenueChurnSeries = [];
  for (let i = 1; i < mrrMonths.length; i++) {
    const prevEnd = mrrMonths[i - 1].end, curEnd = mrrMonths[i].end;
    let nw = 0, exp = 0, churn = 0, contr = 0;
    let startCount = 0, lostCount = 0, startMrr = 0;
    for (const list of byEmail.values()) {
      const p = committedSubAt(list, prevEnd);
      const c = committedSubAt(list, curEnd);
      const pv = p ? monthlyValue(p) : 0;
      const cv = c ? monthlyValue(c) : 0;
      if (p) { startCount++; startMrr += pv; }
      if (!p && c) nw += cv;
      else if (p && !c) { churn += pv; lostCount++; }
      else if (p && c) {
        if (cv > pv) exp += cv - pv;
        else if (cv < pv) contr += pv - cv;
      }
    }
    moveNew.push(nw);
    moveExpansion.push(exp);
    moveChurned.push(-churn);
    moveContraction.push(-contr);
    logoChurnSeries.push(startCount ? (lostCount / startCount) * 100 : null);
    revenueChurnSeries.push(startMrr ? (churn / startMrr) * 100 : null);
  }

  /* --- Actual net revenue per month --- */
  const revByMonth = new Map();
  for (const r of rows) bump(revByMonth, monthKey(r.date), r.net);
  const revSeries = months.map((mo) => revByMonth.get(mo.key) || 0);

  /* --- Geography: customers & net revenue by country --- */
  // Customer's country = their first charge's country (unique email attribution);
  // revenue summed across all that customer's charges.
  const geoMap = new Map();
  for (const list of byEmail.values()) {
    const country = list[0].country;
    const net = list.reduce((a, r) => a + r.net, 0);
    const g = geoMap.get(country) || { country, customers: 0, revenue: 0 };
    g.customers++; g.revenue += net;
    geoMap.set(country, g);
  }
  const geography = [...geoMap.values()].sort((a, b) => b.customers - a.customers).slice(0, 10);

  /* --- New vs returning revenue per month --- */
  // A charge is "new" if it's that customer's first-ever charge, else "returning"
  // (renewals and repeat purchases). Splits each month's net into acquisition vs base.
  const newRevByMonth = new Map();
  const returningRevByMonth = new Map();
  for (const list of byEmail.values()) {
    list.forEach((r, i) => {
      bump(i === 0 ? newRevByMonth : returningRevByMonth, monthKey(r.date), r.net);
    });
  }
  const newRevSeries = months.map((mo) => newRevByMonth.get(mo.key) || 0);
  const returningRevSeries = months.map((mo) => returningRevByMonth.get(mo.key) || 0);

  /* --- Cumulative net revenue (running total by month) --- */
  let runningTotal = 0;
  const cumulativeRevSeries = revSeries.map((v) => (runningTotal += v));

  /* --- New vs cancelled per month --- */
  const newByMonth = new Map();
  for (const list of byEmail.values()) {
    const first = list[0];
    bump(newByMonth, monthKey(first.date), 1);
  }
  const cancelByMonth = new Map();
  const seenCancel = new Set();
  for (const list of byEmail.values()) {
    const last = list[list.length - 1];
    if (last.cancellation && !seenCancel.has(last.email)) {
      seenCancel.add(last.email);
      bump(cancelByMonth, monthKey(last.cancellation), 1);
    }
  }
  const newSeries = months.map((mo) => newByMonth.get(mo.key) || 0);
  const cancelSeries = months.map((mo) => -(cancelByMonth.get(mo.key) || 0));

  /* --- Discounts --- */
  // Unique customers per discount code (all time).
  const codeCustomers = new Map();
  for (const r of rows) {
    if (!r.discountCode) continue;
    if (!codeCustomers.has(r.discountCode)) codeCustomers.set(r.discountCode, new Set());
    codeCustomers.get(r.discountCode).add(r.email);
  }
  const codeCounts = [...codeCustomers.entries()]
    .map(([code, set]) => ({ code, count: set.size }))
    .sort((a, b) => b.count - a.count);
  const allDiscounted = new Set();
  for (const set of codeCustomers.values()) {
    for (const email of set) allDiscounted.add(email);
  }
  const discountedCustomers = allDiscounted.size;

  // Price breakdown over subscriptions with active access (not cancelled, not ended).
  // Note: free (100%-off) subs don't generate $0 renewals, so the revenue staleness
  // guard is intentionally NOT applied here — we want everyone who still has access.
  let freeCount = 0, discountedCount = 0, fullCount = 0;
  for (const list of byEmail.values()) {
    const last = list[list.length - 1];
    if (!last.recurrence) continue;
    if (last.cancellation || (last.subEnd && last.subEnd < TODAY)) continue;
    if (last.salePrice === 0) freeCount++;
    else if (last.discountCode) discountedCount++;
    else fullCount++;
  }

  // Cancel ratio by discount population: full-price vs paid-discount vs free ($0).
  // A subscriber is "free" if any charge was $0, else "discounted" if they ever used a
  // code, else "full". Lets us compare retention across how they were acquired.
  const churnBuckets = {
    full: { total: 0, cancelled: 0 },
    discounted: { total: 0, cancelled: 0 },
    free: { total: 0, cancelled: 0 },
  };
  for (const list of byEmail.values()) {
    const last = list[list.length - 1];
    if (!last.recurrence) continue;
    const isFree = list.some((r) => r.salePrice === 0);
    const usedCode = list.some((r) => r.discountCode);
    const bucket = isFree ? "free" : usedCode ? "discounted" : "full";
    churnBuckets[bucket].total++;
    if (last.cancellation || (last.subEnd && last.subEnd < TODAY)) churnBuckets[bucket].cancelled++;
  }
  const discountChurn = Object.fromEntries(
    Object.entries(churnBuckets).map(([k, v]) => [k, {
      ...v,
      ratio: v.total ? (v.cancelled / v.total) * 100 : null,
    }])
  );

  // Discount ROI (rough estimate). Item Price ($) is unreliable, so the "full" price for a
  // tier+billing period is estimated as the most common Sale Price among non-discounted
  // charges of that kind. Discount given = full − paid; ROI = net collected per $1 given.
  const fullPriceVotes = new Map(); // "tier|recurrence" -> Map(price -> count)
  for (const r of rows) {
    if (r.discountCode || r.salePrice <= 0 || !r.recurrence) continue;
    const key = `${r.tier}|${r.recurrence}`;
    const votes = fullPriceVotes.get(key) || new Map();
    votes.set(r.salePrice, (votes.get(r.salePrice) || 0) + 1);
    fullPriceVotes.set(key, votes);
  }
  const fullPriceByKey = new Map();
  for (const [key, votes] of fullPriceVotes) {
    let best = 0, bestN = -1;
    for (const [price, n] of votes) if (n > bestN) { best = price; bestN = n; }
    fullPriceByKey.set(key, best);
  }
  let discountGiven = 0, discountedNet = 0, foregoneFree = 0;
  for (const r of rows) {
    if (!r.recurrence) continue;
    const full = fullPriceByKey.get(`${r.tier}|${r.recurrence}`) || 0;
    if (r.salePrice === 0 && (r.discountCode || full > 0)) {
      foregoneFree += full;
    } else if (r.discountCode && r.salePrice > 0) {
      discountedNet += r.net;
      if (full > r.salePrice) discountGiven += full - r.salePrice;
    }
  }
  const discountRoi = {
    discountGiven,
    discountedNet,
    foregoneFree,
    roi: discountGiven > 0 ? discountedNet / discountGiven : null,
  };

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
    mrrByRecurrence, mrrByTier,
    forecast: {
      next7, next30, next90, next12mo,
      months: fMonths, actual: forecastActual, projected: forecastProjected, currentIdx,
    },
    renewals,
    monthLabels: months.map((mo) => mo.key),
    mrrLabels: mrrMonths.map((mo) => mo.key),
    mrrSeries, revSeries, newSeries, cancelSeries,
    arpuSeries, newRevSeries, returningRevSeries,
    geography, ltv,
    moveLabels, moveNew, moveExpansion, moveChurned, moveContraction,
    logoChurnSeries, revenueChurnSeries,
    refunds, tierChanges,
    survivalSeries,
    cumulativeRevSeries,
    discountChurn, discountRoi,
    discounts: { freeCount, discountedCount, fullCount, codeCounts, totalCodes: codeCounts.length, discountedCustomers },
  };
}

/* ---------- Rendering ---------- */
let charts = [];
let currentFileName = "";
let lastMetrics = null;
function destroyCharts() { charts.forEach((c) => c.destroy()); charts = []; }

const baseFont = { family: "ABeeZee, sans-serif", weight: 600 };
const gridOpts = { grid: { color: C.grid }, ticks: { font: baseFont, color: C.black } };
const stackedScales = () => ({ x: { stacked: true, ...gridOpts }, y: { stacked: true, ...gridOpts } });

/* Chart colors follow the OS light/dark preference (mirrors the CSS theme). */
function applyChartTheme() {
  const dark = typeof window !== "undefined" && window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const labelColor = dark ? "#f5f1e8" : "#1a1a1a";
  C.black = dark ? "#ece9e0" : "#000000";
  C.grid = dark ? "rgba(236,233,224,0.12)" : "rgba(0,0,0,0.08)";
  if (typeof Chart !== "undefined" && Chart.defaults) {
    // Re-apply defaults on render/theme changes so live OS theme switches update all chart text.
    Chart.defaults.color = labelColor;
    if (Chart.defaults.scale?.ticks) Chart.defaults.scale.ticks.color = labelColor;
    if (Chart.defaults.scale?.title) Chart.defaults.scale.title.color = labelColor;
    if (Chart.defaults.plugins?.legend?.labels) Chart.defaults.plugins.legend.labels.color = labelColor;
  }
  gridOpts.grid.color = C.grid;
  gridOpts.ticks.color = labelColor;
}

function card(label, value, sub, accent) {
  return `<div class="card${accent ? " accent" : ""}">
    <div class="label">${label}</div>
    <div class="value">${value}</div>
    ${sub ? `<div class="sub">${sub}</div>` : ""}
  </div>`;
}

function render(M) {
  lastMetrics = M;
  applyChartTheme();
  document.getElementById("dropzone").hidden = true;
  const dash = document.getElementById("dashboard");
  dash.hidden = false;
  destroyCharts();

  const asOf = document.getElementById("dataAsOf");
  asOf.hidden = false;
  document.getElementById("loadBtn").hidden = false;
  const asOfDate = M.latestDate
    ? M.latestDate.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
    : "";
  asOf.textContent = [currentFileName, asOfDate].filter(Boolean).join(" - ");

  /* Stat cards */
  document.getElementById("cards").innerHTML = [
    card(`Net ${abbr("MRR")}`, fmtMoney2(M.mrr), `${fmtMoney2(M.arr)} ${abbr("ARR")}`, true),
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
      scales: stackedScales(),
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

  /* Top countries by customers */
  charts.push(new Chart(document.getElementById("geoChart"), {
    type: "bar",
    data: {
      labels: M.geography.map((g) => g.country),
      datasets: [{
        label: "Customers",
        data: M.geography.map((g) => g.customers),
        backgroundColor: C.pink,
        borderColor: C.black,
        borderWidth: 1,
      }],
    },
    options: {
      ...chartOpts((v) => fmtInt(v)),
      indexAxis: "y",
      scales: {
        x: { beginAtZero: true, ...gridOpts, ticks: { ...gridOpts.ticks, callback: (v) => fmtInt(v) } },
        y: gridOpts,
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const g = M.geography[ctx.dataIndex];
              return `${fmtInt(g.customers)} customers · ${fmtMoney(g.revenue)} net`;
            },
          },
        },
      },
    },
  }));

  /* New vs. returning revenue */
  charts.push(new Chart(document.getElementById("newReturningChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "New", data: M.newRevSeries, backgroundColor: C.green, borderColor: C.black, borderWidth: 1, stack: "s" },
        { label: "Returning", data: M.returningRevSeries, backgroundColor: C.purple, borderColor: C.black, borderWidth: 1, stack: "s" },
      ],
    },
    options: {
      ...chartOpts((v) => fmtMoney(v)),
      scales: stackedScales(),
    },
  }));

  /* ARPU over time (aligned with MRR months) */
  charts.push(new Chart(document.getElementById("arpuChart"), {
    type: "line",
    data: {
      labels: M.mrrLabels.map(monthLabel),
      datasets: [{
        label: "ARPU",
        data: M.arpuSeries,
        borderColor: C.black,
        backgroundColor: "rgba(144,168,237,0.30)",
        fill: true,
        tension: 0.25,
        pointRadius: 0,
        borderWidth: 2,
      }],
    },
    options: chartOpts((v) => fmtMoney2(v)),
  }));

  /* MRR movement (stacked: positives up, negatives down) */
  charts.push(new Chart(document.getElementById("mrrMovementChart"), {
    type: "bar",
    data: {
      labels: M.moveLabels.map(monthLabel),
      datasets: [
        { label: "New", data: M.moveNew, backgroundColor: C.green, borderColor: C.black, borderWidth: 1, stack: "s" },
        { label: "Expansion", data: M.moveExpansion, backgroundColor: C.purple, borderColor: C.black, borderWidth: 1, stack: "s" },
        { label: "Contraction", data: M.moveContraction, backgroundColor: C.orange, borderColor: C.black, borderWidth: 1, stack: "s" },
        { label: "Churn", data: M.moveChurned, backgroundColor: C.red, borderColor: C.black, borderWidth: 1, stack: "s" },
      ],
    },
    options: {
      ...chartOpts((v) => fmtMoney(v)),
      scales: stackedScales(),
    },
  }));

  /* Monthly churn rate (logo + revenue) */
  charts.push(new Chart(document.getElementById("churnChart"), {
    type: "line",
    data: {
      labels: M.moveLabels.map(monthLabel),
      datasets: [
        { label: "Logo churn", data: M.logoChurnSeries, borderColor: C.red, backgroundColor: "transparent", tension: 0.25, pointRadius: 0, borderWidth: 2, spanGaps: true },
        { label: "Revenue churn", data: M.revenueChurnSeries, borderColor: C.purple, backgroundColor: "transparent", tension: 0.25, pointRadius: 0, borderWidth: 2, spanGaps: true },
      ],
    },
    options: chartOpts((v) => `${(+v).toFixed(1)}%`),
  }));

  /* Subscriber retention (survival) curve */
  charts.push(new Chart(document.getElementById("survivalChart"), {
    type: "line",
    data: {
      labels: M.survivalSeries.map((_, m) => `${m}`),
      datasets: [{
        label: "Still subscribed",
        data: M.survivalSeries,
        borderColor: C.black,
        backgroundColor: "rgba(255,144,232,0.25)",
        fill: true,
        tension: 0.2,
        pointRadius: 0,
        borderWidth: 2,
        spanGaps: true,
      }],
    },
    options: {
      ...chartOpts((v) => `${(+v).toFixed(0)}%`),
      scales: {
        x: { ...gridOpts, title: { display: true, text: "Months since first charge", font: baseFont, color: C.black } },
        y: { beginAtZero: true, max: 100, ...gridOpts, ticks: { ...gridOpts.ticks, callback: (v) => `${v}%` } },
      },
    },
  }));

  /* Cumulative net revenue */
  charts.push(new Chart(document.getElementById("cumulativeChart"), {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Cumulative net",
        data: M.cumulativeRevSeries,
        borderColor: C.black,
        backgroundColor: "rgba(35,160,148,0.30)",
        fill: true,
        tension: 0.25,
        pointRadius: 0,
        borderWidth: 2,
      }],
    },
    options: chartOpts((v) => fmtMoney(v)),
  }));

  /* MRR by billing period (doughnut) */
  charts.push(new Chart(document.getElementById("recurrenceMrrChart"), {
    type: "doughnut",
    data: {
      labels: ["Monthly", "Yearly"],
      datasets: [{
        data: [M.mrrByRecurrence.monthly, M.mrrByRecurrence.yearly],
        backgroundColor: [C.pink, C.purple],
        borderColor: C.black,
        borderWidth: 1,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "right", labels: { font: baseFont, color: C.black } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmtMoney2(ctx.parsed)}` } },
      },
    },
  }));

  /* MRR by plan (horizontal bars) */
  const mrrTierLabels = Object.keys(M.mrrByTier);
  charts.push(new Chart(document.getElementById("tierMrrChart"), {
    type: "bar",
    data: {
      labels: mrrTierLabels,
      datasets: [{
        label: "MRR",
        data: mrrTierLabels.map((t) => M.mrrByTier[t]),
        backgroundColor: C.purple,
        borderColor: C.black,
        borderWidth: 1,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => fmtMoney2(ctx.parsed.x) } },
      },
      scales: { x: { beginAtZero: true, ...gridOpts, ticks: { ...gridOpts.ticks, callback: (v) => fmtMoney(v) } }, y: gridOpts },
    },
  }));

  /* Renewals due soon */
  document.getElementById("renewalCards").innerHTML = [
    card("Renewals next 30d", fmtInt(M.renewals.count), null, true),
    card("Expected", fmtMoney2(M.renewals.amount)),
  ].join("");
  const renewalRows = M.renewals.list.slice(0, 12);
  document.getElementById("renewalList").innerHTML = renewalRows.length
    ? "<table class=\"mini-table\"><tbody>" +
      renewalRows.map((x) =>
        `<tr><td>${fmtDay(x.date)}</td><td>${escapeHtml(x.email)}</td><td>${escapeHtml(x.tier)}</td><td class="num">${fmtMoney2(x.net)}</td></tr>`
      ).join("") +
      "</tbody></table>" +
      (M.renewals.list.length > renewalRows.length ? `<p class="hint">+${fmtInt(M.renewals.list.length - renewalRows.length)} more</p>` : "")
    : "<p class=\"panel-sub\">No renewals scheduled in the next 30 days.</p>";

  /* Customer lifetime & LTV cards */
  const L = M.ltv;
  document.getElementById("ltvCards").innerHTML = [
    card("Avg revenue / customer", fmtMoney2(L.avgRevPerCustomer), "all customers, all time", true),
    card("Churned customers", fmtInt(L.churnedCount), "cancelled subscriptions"),
    card("Avg lifespan", `${L.avgLifespanMonths.toFixed(1)} mo`, "churned customers"),
    card("Avg lifetime value", fmtMoney2(L.avgChurnedRevenue), "churned customers"),
  ].join("");
  document.getElementById("ltvByTier").innerHTML =
    "<table class=\"mini-table\"><thead><tr><td>Plan</td><td class=\"num\">Customers</td><td class=\"num\">Avg " + abbr("LTV") + "</td><td class=\"num\">Avg lifespan</td></tr></thead><tbody>" +
    L.byTier.map((t) =>
      `<tr><td>${escapeHtml(t.tier)}</td><td class="num">${fmtInt(t.customers)}</td><td class="num">${fmtMoney2(t.avgRevenue)}</td><td class="num">${t.avgLifespanMonths == null ? "–" : t.avgLifespanMonths.toFixed(1) + " mo"}</td></tr>`
    ).join("") +
    "</tbody></table>";

  /* Plan change cards */
  const T = M.tierChanges;
  document.getElementById("tierChangeCards").innerHTML = [
    card("Upgrades", fmtInt(T.upgrades), "moves to a higher tier", true),
    card("Downgrades", fmtInt(T.downgrades), "moves to a lower tier"),
    card("Customers who changed", fmtInt(T.customersChanged), "changed tier at least once"),
  ].join("");

  /* Refunds & chargebacks cards */
  const R = M.refunds;
  document.getElementById("refundCards").innerHTML = [
    card("Refund + dispute rate", `${R.rate.toFixed(2)}%`, `of ${fmtInt(R.totalCharges)} charges`, true),
    card("Fully refunded", fmtInt(R.fullyRefunded), "charges returned in full"),
    card("Chargebacks lost", fmtInt(R.chargebacks), "disputes not won"),
    card("Money returned", fmtMoney(R.refundedAmount), "full + partial refunds"),
  ].join("");

  /* Discount cards */
  const D = M.discounts;
  document.getElementById("discountCards").innerHTML = [
    card("Free via discount", fmtInt(D.freeCount), "active subs paying $0", true),
    card("Discounted (paying)", fmtInt(D.discountedCount), "active subs with a code"),
    card("Full price", fmtInt(D.fullCount), "active subs, no discount"),
    card("Discount codes used", fmtInt(D.totalCodes), `${fmtInt(D.discountedCustomers)} customers total`),
  ].join("");

  /* Customers per discount code (top 12, horizontal bars) */
  const topCodes = D.codeCounts.slice(0, 12);
  charts.push(new Chart(document.getElementById("discountCodeChart"), {
    type: "bar",
    data: {
      labels: topCodes.map((c) => c.code),
      datasets: [{
        label: "Customers",
        data: topCodes.map((c) => c.count),
        backgroundColor: C.pink,
        borderColor: C.black,
        borderWidth: 1,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `${fmtInt(ctx.parsed.x)} customers` } },
      },
      scales: {
        x: { beginAtZero: true, ...gridOpts, ticks: { ...gridOpts.ticks, precision: 0 } },
        y: gridOpts,
      },
    },
  }));

  /* Subscriptions by price (doughnut) */
  charts.push(new Chart(document.getElementById("priceTypeChart"), {
    type: "doughnut",
    data: {
      labels: ["Full price", "Discounted", "Free"],
      datasets: [{
        data: [D.fullCount, D.discountedCount, D.freeCount],
        backgroundColor: [C.purple, C.orange, C.pink],
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

  /* Cancel rate by discount */
  const DC = M.discountChurn;
  const pct = (v) => (v == null ? "–" : `${v.toFixed(1)}%`);
  document.getElementById("discountChurnCards").innerHTML = [
    card("Full price", pct(DC.full.ratio), `${fmtInt(DC.full.cancelled)} of ${fmtInt(DC.full.total)} cancelled`, true),
    card("Paid discount", pct(DC.discounted.ratio), `${fmtInt(DC.discounted.cancelled)} of ${fmtInt(DC.discounted.total)} cancelled`),
    card("Free ($0)", pct(DC.free.ratio), `${fmtInt(DC.free.cancelled)} of ${fmtInt(DC.free.total)} cancelled`),
  ].join("");

  /* Discount ROI (estimate) */
  const RO = M.discountRoi;
  document.getElementById("discountRoiCards").innerHTML = [
    card("Est. discount given", fmtMoney(RO.discountGiven), "to paying customers", true),
    card("Net from discounted", fmtMoney(RO.discountedNet), "paid-discount charges"),
    card("Return on discount", RO.roi == null ? "–" : `${RO.roi.toFixed(1)}×`, "net collected per $1 given"),
    card("Foregone (free)", fmtMoney(RO.foregoneFree), "est. full price of $0 charges"),
  ].join("");
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
  currentFileName = file.name;
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

  const loadDemo = () => {
    fetch("fake_sales_data.csv")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        currentFileName = "fake_sales_data.csv";
        const res = Papa.parse(text, { header: true, skipEmptyLines: true });
        render(computeMetrics(buildModel(res.data)));
      })
      .catch((e) => alert("Could not load demo data: " + e.message));
  };

  document.getElementById("loadBtn").addEventListener("click", () => document.getElementById("fileInput").click());
  document.getElementById("dropBtn").addEventListener("click", () => document.getElementById("fileInput").click());
  document.getElementById("demoBtn").addEventListener("click", loadDemo);
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

  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (lastMetrics) render(lastMetrics);
    });
  }

  /* Canvas elements are unreliable in print previews across browsers.
     Snapshot each chart to a static <img> just before printing and remove
     it afterwards; <img> elements (including data-URLs) print perfectly. */
  window.addEventListener("beforeprint", () => {
    document.querySelectorAll(".chart-print-img").forEach((img) => img.remove());
    charts.forEach((c) => {
      const img = document.createElement("img");
      img.className = "chart-print-img";
      img.src = c.toBase64Image("image/png", 1);
      img.style.cssText = "width:100%;height:auto;";
      c.canvas.parentElement.appendChild(img);
    });
  });
  window.addEventListener("afterprint", () => {
    document.querySelectorAll(".chart-print-img").forEach((img) => img.remove());
  });

  /* Highlight the section currently in view in the sticky nav. */
  const navLinks = [...document.querySelectorAll(".section-nav a")];
  const sections = navLinks.map((a) => document.querySelector(a.getAttribute("href")));
  if (window.IntersectionObserver && sections.every(Boolean)) {
    const spy = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        navLinks.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === `#${e.target.id}`));
      }
    }, { rootMargin: "-60px 0px -65% 0px" });
    sections.forEach((s) => spy.observe(s));
  }
}
