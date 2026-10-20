/ 賺大錢發發發：Cloudflare 上的即時報價。
// /api/idx 大盤台美股、/api/stk 股票報酬比較與回測、/api/nav 淨值查詢、/api/mkt 大盤高低指標；其他網址交給靜態檔案。
// 報價類每 60 秒最多真的去抓一次（大盤高低指標 30 分鐘），期間大家共用同一份結果。
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const US = [["^GSPC", "標普500"], ["^SOX", "費城半導體"], ["^DJI", "道瓊工業指數"], ["^IXIC", "那斯達克"]];
const PICKS = [["TSM", "台積電ADR"], ["TSMX", "台積電ADR 2倍"]];
const CACHE_SEC = 60;

const r2 = x => Math.round(x * 100) / 100;
const hm = (t, tz) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t * 1000));
const ymd = (t, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t * 1000));

async function get(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { "User-Agent": UA, ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r;
}

// 加權、櫃買、2330：Yahoo 奇摩股市報價頁內嵌的 1 分鐘走勢
async function yahooTw(sym, name) {
  const h = await (await get("https://tw.stock.yahoo.com/quote/" + sym.replace("^", "%5E"))).text();
  const i = h.indexOf('"timestamp":[');
  const tail = h.slice(i);
  const ts = JSON.parse(tail.match(/"timestamp":(\[[^\]]*\])/)[1]);
  const cl = JSON.parse(tail.match(/"close":(\[[^\]]*\])/)[1]);
  const prev = parseFloat(h.slice(Math.max(0, i - 3000), i + 20000).match(/"chartPreviousClose":\s*([\d.]+)/)[1]);
  const pts = ts.map((t, k) => [t, cl[k]]).filter(p => p[1] != null).map(([t, c]) => [hm(t, "Asia/Taipei"), r2(c)]);
  return { name, date: ymd(ts[ts.length - 1], "Asia/Taipei"), prev, pts };
}

async function taifex(path, body) {
  const r = await get("https://mis.taifex.com.tw/futures/api/" + path, {
    method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
  });
  return (await r.json()).RtData;
}

// 台指期：期交所近月合約日盤 1 分鐘走勢
async function txf() {
  const q = (await taifex("getQuoteList", { MarketType: "0", SymbolType: "F", KindID: "1", CID: "TXF", ExpireMonth: "",
    RowSize: "全部", PageNo: "", SortColumn: "", AscDesc: "A" })).QuoteList;
  const near = q.find(x => x.SymbolID.endsWith("-F")); // 第一個 -F 是近月合約（-S 是現貨）
  const d = await taifex("getChartData1M", { SymbolID: near.SymbolID });
  const pts = d.Ticks.map(t => [`${t[0].slice(0, 2)}:${t[0].slice(2, 4)}`, r2(parseFloat(t[4]))]);
  const day = near.CDate;
  return { name: `台指期（近月 ${near.DispEName.slice(2)}）`, date: `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`,
    prev: parseFloat(near.CRefPrice), pts };
}

// 美股指數、TSM、TSMX、匯率：Yahoo spark 5 分鐘走勢（美東時間）
async function spark(list) {
  const url = "https://query1.finance.yahoo.com/v8/finance/spark?range=1d&interval=5m&symbols=" +
    list.map(([s]) => encodeURIComponent(s)).join(",");
  const r = await (await get(url)).json();
  return list.map(([s, name]) => {
    const v = r[s], ts = v.timestamp || [], cl = v.close || [];
    const pts = ts.map((t, k) => [t, cl[k]]).filter(p => p[1] != null).map(([t, c]) => [hm(t, "America/New_York"), r2(c)]);
    return { key: s, name, us: 1, date: ts.length ? ymd(ts[ts.length - 1], "America/New_York") : "",
      prev: v.chartPreviousClose ?? v.previousClose, pts };
  });
}

async function build() {
  const jobs = {
    twii: yahooTw("^TWII", "加權指數"), txf: txf(), otc: yahooTw("^TWOII", "櫃買指數"),
    us: spark([...US, ...PICKS]), tw2330: yahooTw("2330.TW", "台積電"), fx: spark([["TWD=X", "美元兌台幣"]]),
  };
  const got = Object.fromEntries(await Promise.all(Object.entries(jobs).map(([k, p]) => p.then(v => [k, v], () => [k, null]))));
  const items = [];
  for (const k of ["twii", "txf", "otc"]) if (got[k]) items.push({ key: k, ...got[k] });
  if (got.us) items.push(...got.us);
  const now = new Date(Date.now() + 8 * 3600e3).toISOString();
  const data = { updated: `${now.slice(0, 10)} ${now.slice(11, 16)}`, live: 1, items: items.filter(x => x.pts.length) };
  const tsm = got.us && got.us.find(x => x.key === "TSM"), tw = got.tw2330, fx = got.fx && got.fx[0];
  if (tsm && tsm.pts.length && tw && tw.pts.length && fx && fx.pts.length)
    data.adr = { adr: tsm.pts.at(-1)[1], adrDate: tsm.date, tw: tw.pts.at(-1)[1], twDate: tw.date, fx: Math.round(fx.pts.at(-1)[1] * 1000) / 1000 };
  return data;
}

// ───── 股票報酬比較、回測：選到的那幾檔，抓 Yahoo 5 年日線（含息調整）和當日 5 分 K ─────
const rp = x => x == null ? null : Math.round(x * (x < 10 ? 1e4 : x < 100 ? 1e3 : 100)) / (x < 10 ? 1e4 : x < 100 ? 1e3 : 100);
const freqLabel = n => n === 0 ? "無配息" : n >= 10 ? "月配" : n >= 3 ? "季配" : n === 2 ? "半年配" : "年配";
function weeklyKd(ts, hi, lo, cl, n = 9) { // 台股慣用 9 週 KD，和 update_stock_data.py 相同
  const weeks = new Map();
  ts.forEach((t, i) => {
    if (hi[i] == null || lo[i] == null || cl[i] == null) return;
    const d = new Date((t + 8 * 3600) * 1000), day = (d.getUTCDay() + 6) % 7;
    const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
    const w = weeks.get(mon);
    if (!w) weeks.set(mon, [hi[i], lo[i], cl[i]]); else { w[0] = Math.max(w[0], hi[i]); w[1] = Math.min(w[1], lo[i]); w[2] = cl[i]; }
  });
  const bars = [...weeks.keys()].sort().map(k => weeks.get(k));
  if (!bars.length) return [null, null];
  let k = 50, dv = 50;
  bars.forEach((b, i) => {
    const win = bars.slice(Math.max(0, i - n + 1), i + 1), H = Math.max(...win.map(x => x[0])), L = Math.min(...win.map(x => x[1]));
    const rsv = H === L ? 50 : (b[2] - L) / (H - L) * 100;
    k = k * 2 / 3 + rsv / 3; dv = dv * 2 / 3 + k / 3;
  });
  return [Math.round(k * 10) / 10, Math.round(dv * 10) / 10];
}
async function chart(sym) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5y&interval=1d&events=div`, { headers: { "User-Agent": UA } });
  if (!r.ok) return null;
  const j = await r.json();
  return j.chart && j.chart.result && j.chart.result[0];
}
async function stockOne(code, us) {
  let sym = us ? code : code + ".TW", d = await chart(sym);
  if (!us && (!d || !(d.timestamp || []).length)) { sym = code + ".TWO"; d = await chart(sym); }
  if (!d || !(d.timestamp || []).length) return null;
  const q = d.indicators.quote[0], ts = d.timestamp, adj = d.indicators.adjclose[0].adjclose;
  const closes = ts.map((t, i) => [t, q.close[i]]).filter(x => x[1] != null);
  if (closes.length < 2) return null;
  const [lastT, lastC] = closes.at(-1);
  const divs = Object.values((d.events || {}).dividends || {}).filter(v => v.date > lastT - 365 * 86400);
  const [k, dv] = weeklyKd(ts, q.high, q.low, q.close);
  const tz = us ? "America/New_York" : "Asia/Taipei";
  const tt = d.meta.regularMarketTime || lastT;
  const daily = [];
  ts.forEach((t, i) => { if (adj[i] != null) daily.push([ymd(t, "Asia/Taipei"), rp(adj[i])]); });
  return { sym, prevClose: rp(closes.at(-2)[1]), last: rp(lastC), yield: Math.round(divs.reduce((a, v) => a + v.amount, 0) / lastC * 1e4) / 100,
    freq: freqLabel(divs.length), k, d: dv, tradeDate: `${ymd(tt, tz)} ${hm(tt, tz)}`, daily };
}
async function stocks(list) { // list: [[code, us]]
  const got = await Promise.all(list.map(([c, us]) => stockOne(c, us).catch(() => null)));
  const ok = list.map(([c], i) => [c, got[i]]).filter(x => x[1]);
  if (ok.length) try {
    const sp = await (await get("https://query1.finance.yahoo.com/v8/finance/spark?range=1d&interval=5m&symbols=" + ok.map(([, v]) => encodeURIComponent(v.sym)).join(","))).json();
    ok.forEach(([c, v]) => {
      const r = sp[v.sym] || {}, ts = r.timestamp || [], cl = r.close || [], tz = v.sym.includes(".") ? "Asia/Taipei" : "America/New_York";
      v.intraday = ts.map((t, i) => [t, cl[i]]).filter(x => x[1] != null).map(([t, c]) => [hm(t, tz), rp(c)]);
      v.dayPrev = rp(r.chartPreviousClose ?? r.previousClose ?? v.prevClose);
    });
  } catch (_) {}
  return Object.fromEntries(ok);
}

// ───── 淨值查詢：證交所 ETF 盤中預估淨值（格式同 nav_table）─────
const num = x => { const v = parseFloat(String(x ?? "").replace(/,/g, "")); return isNaN(v) ? null : v; };
async function navTable() {
  const raw = await (await get("https://mis.twse.com.tw/stock/data/all_etf.txt", { headers: { Referer: "https://mis.twse.com.tw/stock/etf_nav.jsp?ex=tse" } })).json();
  const out = {};
  for (const g of raw.a1 || []) for (const m of g.msgArray || []) {
    const e = num(m.e), f = num(m.f);
    if (!f) continue;
    const i = String(m.i || ""), j = String(m.j || "");
    out[m.a] = [String(m.b || "").trim(), e, f, num(m.g), num(m.h), num(m.c), num(m.d), i.length === 8 ? `${i.slice(0, 4)}/${i.slice(4, 6)}/${i.slice(6)} ${j.slice(0, 5)}` : ""];
  }
  if (!Object.keys(out).length) throw new Error("all_etf empty");
  return out;
}

// ───── 大盤高低指標：三大法人、恐慌指數、散戶多空比、景氣燈號、M1B（融資維持率和本益比要整個市場的資料，太大，沿用上傳時的資料）─────
const twDay = (back = 0) => new Date(Date.now() + 8 * 3600e3 - back * 86400e3).toISOString().slice(0, 10);
async function inst() {
  for (let b = 0; b < 7; b++) {
    const day = twDay(b); if ([0, 6].includes(new Date(day).getUTCDay())) continue;
    const j = await (await get(`https://www.twse.com.tw/rwd/zh/fund/BFI82U?response=json&type=day&dayDate=${day.replace(/-/g, "")}`)).json();
    if (j.stat !== "OK") continue;
    const v = Object.fromEntries(j.data.map(r => [r[0], num(r[3]) || 0])), yi = x => Math.round(x / 1e6) / 100;
    return [[day, yi((v["外資及陸資(不含外資自營商)"] || 0) + (v["外資自營商"] || 0)), yi(v["投信"] || 0), yi((v["自營商(自行買賣)"] || 0) + (v["自營商(避險)"] || 0))]];
  }
  return null;
}
async function vixNow() {
  for (let b = 0; b < 2; b++) {
    const d = new Date(Date.now() + 8 * 3600e3); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - b);
    const r = await fetch(`https://www.taifex.com.tw/file/taifex/Dailydownload/vix/log2data/${d.toISOString().slice(0, 7).replace("-", "")}new.txt`, { headers: { "User-Agent": UA } });
    if (!r.ok) continue;
    const rows = new TextDecoder("latin1").decode(await r.arrayBuffer()).split(/\r?\n/).map(l => l.trim().split(/\s+/)).filter(p => p.length >= 3 && /^\d{8}$/.test(p[0]) && num(p[2]) != null);
    if (rows.length) { const p = rows.at(-1); return [[`${p[0].slice(0, 4)}-${p[0].slice(4, 6)}-${p[0].slice(6)}`, num(p[2])]]; }
  }
  return null;
}
async function taifexCsv(url, form) {
  const r = await get(url, { method: "POST", body: new URLSearchParams(form), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  return new TextDecoder("latin1").decode(await r.arrayBuffer()).split(/\r?\n/).filter(l => /^\d{4}\/\d\d\/\d\d,/.test(l)).map(l => l.split(","));
}
async function retail() { // 小台散戶多空比 = -(三大法人小台未平倉淨額) ÷ 小台全市場未平倉量（一般時段）
  // 結束日超過期交所已有資料的日期會回錯誤頁，所以從今天往前試
  for (let back = 0; back < 4; back++) {
    const r = await retailRange(twDay(back + 10).replace(/-/g, "/"), twDay(back).replace(/-/g, "/")).catch(() => null);
    if (r) return r;
  }
  return null;
}
async function retailRange(a, b) {
  const [mxf, mtx] = await Promise.all([
    taifexCsv("https://www.taifex.com.tw/cht/3/futContractsDateDown", { queryStartDate: a, queryEndDate: b, commodityId: "MXF" }),
    taifexCsv("https://www.taifex.com.tw/cht/3/futDataDown", { down_type: "1", commodity_id: "MTX", queryStartDate: a, queryEndDate: b }),
  ]);
  const net = {}, oi = {};
  mxf.forEach(r => { net[r[0]] = (net[r[0]] || 0) + parseInt(r[13]); });
  mtx.forEach(r => { const v = num(r[11]); if (v != null) oi[r[0]] = (oi[r[0]] || 0) + v; }); // 盤後時段的未沖銷是「-」，會被略過
  const days = Object.keys(net).filter(d => oi[d]).sort();
  if (!days.length) return null;
  const d = days.at(-1);
  return [[d.replace(/\//g, "-"), Math.round(-net[d] / oi[d] * 1e4) / 100]];
}
async function unzipFile(buf, want) { // 只解出檔名符合 want 的那一個檔
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let e = u8.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  let p = dv.getUint32(e + 16, true);
  const n = dv.getUint16(e + 10, true);
  for (let i = 0; i < n; i++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true),
      xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.slice(p + 46, p + 46 + nl));
    if (want(name)) {
      const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true), data = u8.slice(start, start + csize);
      if (method === 0) return new TextDecoder().decode(data);
      const out = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
      return new TextDecoder().decode(out);
    }
    p += 46 + nl + xl + cl;
  }
  throw new Error("file not in zip");
}
function csvRows(t) { return t.replace(/^﻿/, "").split(/\r?\n/).filter(Boolean).map(l => l.split(",").map(x => x.replace(/^"|"$/g, ""))); }
async function ndc() {
  const meta = (await (await get("https://data.gov.tw/api/v2/rest/dataset/6099")).json()).result.distribution;
  const url = meta.find(x => x.resourceFormat === "ZIP").resourceDownloadUrl;
  const txt = await unzipFile(await (await get(url)).arrayBuffer(), n => n.includes("景氣指標與燈號") && !n.includes("schema"));
  const [head, ...rows] = csvRows(txt), iD = head.indexOf("Date"), iS = head.indexOf("景氣對策信號綜合分數"), iL = head.indexOf("景氣對策信號");
  return rows.filter(r => num(r[iS]) != null).map(r => [`${r[iD].slice(0, 4)}-${r[iD].slice(4, 6)}`, Math.trunc(num(r[iS])), (r[iL] || "").trim()]).slice(-13);
}
async function m1b() {
  const [head, ...rows] = csvRows(await (await get("https://www.cbc.gov.tw/public/data/OpenData/%E7%B6%93%E7%A0%94%E8%99%95/EF01M01.csv")).text());
  const i1 = head.indexOf("貨幣總計數-M1B-日平均-年增率"), i2 = head.indexOf("貨幣總計數-M2-日平均-年增率");
  return rows.filter(r => num(r[i1]) != null && num(r[i2]) != null).map(r => {
    const [y, m] = r[0].split("M"); return [`${y}-${m.padStart(2, "0")}`, Math.round(num(r[i1]) * 100) / 100, Math.round(num(r[i2]) * 100) / 100];
  }).slice(-13);
}
async function market() {
  const jobs = { inst: inst(), vix: vixNow(), retail: retail(), ndc: ndc(), m1b: m1b() };
  const out = { updated: `${twDay(0)} ${new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 16)}` };
  await Promise.all(Object.entries(jobs).map(([k, p]) => p.then(v => { if (v && v.length) out[k] = v; }, () => {})));
  return out;
}

// 同一個網址在 sec 秒內大家共用同一份結果
async function cached(request, ctx, sec, make) {
  const cache = caches.default, key = new Request(request.url);
  const hit = await cache.match(key);
  if (hit) return hit;
  try {
    const res = new Response(JSON.stringify(await make()), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${sec}` } });
    ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: { "Content-Type": "application/json" } });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/api/idx": return cached(request, ctx, CACHE_SEC, build);
      case "/api/nav": return cached(request, ctx, CACHE_SEC, navTable);
      case "/api/mkt": return cached(request, ctx, 1800, market);
      case "/api/stk": {
        // ?c=2330,00981A&us=SOXX → 最多 6 檔
        const tw = (url.searchParams.get("c") || "").split(",").filter(c => /^[0-9A-Z]{4,7}$/.test(c));
        const us = (url.searchParams.get("us") || "").split(",").filter(c => /^[A-Z.]{1,6}$/.test(c));
        const list = [...tw.map(c => [c, false]), ...us.map(c => [c, true])].slice(0, 6);
        return cached(request, ctx, CACHE_SEC, () => stocks(list));
