#!/usr/bin/osascript -l JavaScript
// Stocks for Alfred — quotes, search and a watchlist without dependencies.
// Usage: osascript -l JavaScript stocks.js <filter|refresh|act> [args…]
//   filter <query>      Script Filter JSON (watchlist when the query is empty)
//   refresh <symbols…>  background quote refresh (spawned by filter)
//   act <arg>           run the action chosen in Alfred ($stocks_action)
ObjC.import("Foundation");
ObjC.import("AppKit");
ObjC.import("Security");
ObjC.bindFunction("setsid", ["int", []]);
ObjC.bindFunction("kill", ["int", ["int", "int"]]);

const ENV = $.NSProcessInfo.processInfo.environment;
function env(name, fallback) {
  const v = ENV.objectForKey(name);
  return v.isNil() ? fallback : v.js;
}

const BUNDLE = env("alfred_workflow_bundleid", "io.github.x-o-r-r-o.stocks");
const TIMEOUT = Math.max(1, Number(env("STOCKS_TIMEOUT", "8")) || 8); // seconds per request
const OPEN_TTL = 60; // quote TTL while a market session (pre/regular/post) is open
const CLOSED_TTL = 15 * 60; // …and while it is closed
const MISSING_TTL = 60 * 60; // remember unknown symbols for an hour
const SEARCH_TTL = 24 * 60 * 60;
const EMPTY_SEARCH_TTL = 10 * 60; // an empty answer may be a glitch: ask again sooner
const RETRY_AFTER = 60; // seconds before the watchlist retries after a failed refresh
const LOCK_TTL = 30; // a refresh lock without a live process id is considered dead after this
const REFRESH_MAX = 300; // …and one whose process is still alive after this (it can take 7 × 8 s for 50 slow symbols)
const MAX_WATCHLIST = 50;
const SYMBOL_RE = /^[A-Z0-9^][A-Z0-9.^=\-:\/_&]{0,31}$/;

// Alfred checkboxes arrive as "1"/"0" (older versions: "true"/"false")
function enabled(name, fallback) {
  return !/^(0|false|no|)$/i.test(env(name, fallback ? "1" : "0").trim());
}

function now() {
  const t = env("STOCKS_TEST_NOW", null); // test suite only: fixed clock (epoch seconds)
  return t !== null ? Number(t) : Date.now() / 1000;
}

// ---------- files ----------

const FM = $.NSFileManager.defaultManager;

function mkdirs(dir) {
  FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $());
  return dir;
}
function cacheDir() {
  return mkdirs(env("alfred_workflow_cache", `${$.NSTemporaryDirectory().js}alfred-stocks`));
}
function dataDir() {
  return mkdirs(env("alfred_workflow_data", `${$.NSTemporaryDirectory().js}alfred-stocks-data`));
}
function exists(path) {
  return FM.fileExistsAtPath(path);
}
function readFile(path) {
  if (!exists(path)) return null;
  const s = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, $());
  return s.isNil() ? null : s.js;
}
function writeFile(path, text) {
  // atomic: readers never see a half-written file
  return $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, $());
}
function removeFile(path) {
  FM.removeItemAtPathError(path, $());
}
function readJSON(path, fallback) {
  const t = readFile(path);
  if (t === null) return fallback;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? v : fallback; // an array would never be rewritten
  } catch (e) {
    return fallback;
  }
}
function mtime(path) {
  const a = FM.attributesOfItemAtPathError(path, $());
  if (a.isNil()) return 0;
  return a.fileModificationDate.timeIntervalSince1970;
}
function listDir(dir) {
  const a = FM.contentsOfDirectoryAtPathError(dir, $());
  return a.isNil() ? [] : a.js.map((s) => s.js);
}

// file-name-safe encoding of a symbol (unicode and punctuation become _XX)
function safeName(s) {
  return encodeURIComponent(s).replace(/[!'()*~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%/g, "_");
}

// ---------- processes ----------

// Run a program with argv (never a shell) and optional stdin; returns {status, stdout, stderr}.
function exec(path, args, input) {
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath(path);
  task.arguments = args;
  const inP = $.NSPipe.pipe, outP = $.NSPipe.pipe, errP = $.NSPipe.pipe;
  task.standardInput = inP;
  task.standardOutput = outP;
  task.standardError = errP;
  if (!task.launchAndReturnError($())) return { status: -1, stdout: "", stderr: `cannot run ${path}` };
  if (input) inP.fileHandleForWriting.writeData($(input).dataUsingEncoding($.NSUTF8StringEncoding));
  inP.fileHandleForWriting.closeFile;
  const out = outP.fileHandleForReading.readDataToEndOfFile;
  const err = errP.fileHandleForReading.readDataToEndOfFile;
  task.waitUntilExit;
  const str = (d) => $.NSString.alloc.initWithDataEncoding(d, $.NSUTF8StringEncoding).js || "";
  return { status: task.terminationStatus, stdout: str(out), stderr: str(err) };
}

function alive(pid) {
  return Number.isInteger(pid) && pid > 1 && $.kill(pid, 0) === 0;
}

// Start a detached process (stdout/stderr to /dev/null so Alfred doesn't wait for it); returns its pid or 0.
function spawn(path, args) {
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath(path);
  task.arguments = args;
  const nul = $.NSFileHandle.fileHandleWithNullDevice;
  task.standardInput = nul;
  task.standardOutput = nul;
  task.standardError = nul;
  return task.launchAndReturnError($()) ? task.processIdentifier : 0;
}

// ---------- HTTP (curl ships with macOS) ----------

// A curl config value: quoted, with backslashes and quotes escaped. Control characters are refused.
function cfg(s) {
  s = String(s);
  if (/[\x00-\x1f\x7f]/.test(s)) throw new Error("control character in request");
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

// Fetch several requests in parallel. The config (URLs, headers, API keys) goes to curl on
// stdin, so nothing secret shows up in the process list. Returns [{status, body, exit, error}].
function httpMany(reqs, parallel = 8) {
  if (!reqs.length) return [];
  // Alfred kills a running Script Filter when the query changes: remove what such runs left behind
  const t = Date.now() / 1000;
  for (const f of listDir(cacheDir())) if (f.startsWith("tmp-") && t - mtime(`${cacheDir()}/${f}`) > 120) FM.removeItemAtPathError(`${cacheDir()}/${f}`, $());
  const dir = mkdirs(`${cacheDir()}/tmp-${$.NSUUID.UUID.UUIDString.js}`);
  // parallel-immediate: without it curl waits to multiplex on one connection, which serialises the
  // requests to an HTTP/1.1 server (8 slow quotes: 8 × the timeout instead of 1 ×)
  const lines = parallel > 1 ? ["parallel", "parallel-immediate", `parallel-max = ${parallel}`] : [];
  reqs.forEach((r, i) => {
    if (i) lines.push("next");
    lines.push(`url = ${cfg(r.url)}`, `output = ${cfg(`${dir}/${i}`)}`, "silent", "compressed",
      `max-time = ${TIMEOUT}`, `connect-timeout = ${Math.min(TIMEOUT, 5)}`,
      `user-agent = ${cfg(r.ua || "alfred-stocks/1.0")}`, `header = ${cfg("Accept: application/json")}`,
      `write-out = ${cfg(`${i} %{http_code} %{exitcode} %{errormsg}\\n`)}`);
    for (const [k, v] of Object.entries(r.headers || {})) lines.push(`header = ${cfg(`${k}: ${v}`)}`);
  });
  const res = exec("/usr/bin/curl", ["-K", "-"], lines.join("\n") + "\n");
  const meta = {};
  for (const line of res.stdout.split("\n")) {
    const m = line.match(/^(\d+) (\d{3}) (\d+) ?(.*)$/);
    if (m) meta[m[1]] = { status: Number(m[2]), exit: Number(m[3]), error: m[4] };
  }
  const out = reqs.map((r, i) => {
    const m = meta[i] || { status: 0, exit: -1, error: res.stderr.trim() || "curl failed" };
    const path = `${dir}/${i}`;
    const body = readFile(path);
    return Object.assign(m, { body: body !== null ? body : exists(path) ? "\ufffd(not UTF-8)" : "" });
  });
  FM.removeItemAtPathError(dir, $());
  return out;
}

// ---------- provider errors ----------

class ProviderError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind; // auth | rate | network | server | parse | nokey | plan (this symbol isn't on your plan)
    this.status = status || 0;
    this.until = 0; // back off until then (epoch seconds), when the provider says how long
  }
}

// Throw for transport/HTTP failures, parse the JSON body otherwise.
function parseBody(p, r, { notFoundOk = false } = {}) {
  if (r.status === 0) {
    const why = { 6: "can’t find the server", 7: "can’t connect", 28: "timed out", 35: "secure connection failed", 60: "certificate problem" }[r.exit];
    throw new ProviderError("network", why || `network error (${redact(r.error) || "curl " + r.exit})`);
  }
  // keyed providers answer 403 for one symbol the free plan doesn't cover (Finnhub: non-US symbols); 401 is the key
  if (r.status === 403 && p.needsKey) throw new ProviderError("plan", "not available on your plan", r.status);
  if (r.status === 401 || r.status === 403) throw new ProviderError("auth", p.needsKey ? "API key rejected" : "access denied", r.status);
  if (r.status === 429) throw new ProviderError("rate", "rate limited", r.status);
  if ((r.status === 404 || r.status === 400) && notFoundOk) return null; // Yahoo: 404 for unknown/delisted symbols
  if (r.status >= 500) throw new ProviderError("server", "server error", r.status);
  const body = (r.body || "").trim();
  if (!body) throw new ProviderError("parse", "empty response", r.status);
  let v;
  try {
    v = JSON.parse(body);
  } catch (e) {
    throw new ProviderError("parse", "unexpected response (not JSON)", r.status);
  }
  if (!v || typeof v !== "object") throw new ProviderError("parse", "unexpected response", r.status);
  if (r.status >= 400 && r.status !== 404) throw new ProviderError("server", `HTTP ${r.status}`, r.status);
  return v;
}

let KEY = null; // current API key (redacted from any message that could be shown or cached)
function redact(s) {
  s = String(s || "");
  return KEY ? s.split(KEY).join("•••") : s;
}

// finite number or null (the APIs send numbers, numeric strings, null, "NaN", "None", "-")
function num(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[%,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function str(v) {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}
// company names sometimes arrive HTML-escaped ("Procter &amp; Gamble")
function name(v) {
  const ents = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return str(v).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,5});/gi, (m, e) => {
    if (e[0] !== "#") return ents[e.toLowerCase()] || m;
    const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : m;
  });
}

// ---------- market state ----------

// NYSE/Nasdaq holidays and 1 pm early closes (nyse.com/markets/hours-calendars). Later years fall back
// to the weekday rule; Yahoo Finance and Twelve Data report holidays themselves.
const US_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);
const US_EARLY_CLOSE = new Set(["2026-11-27", "2026-12-24", "2027-11-26"]);
const NY_PARTS = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" });

// US equity sessions in New York time.
function usState(t) {
  const parts = {};
  for (const p of NY_PARTS.formatToParts(new Date(t * 1000))) parts[p.type] = p.value;
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  if (parts.weekday === "Sat" || parts.weekday === "Sun" || US_HOLIDAYS.has(day)) return "CLOSED";
  const m = Number(parts.hour) * 60 + Number(parts.minute);
  const close = US_EARLY_CLOSE.has(day) ? 780 : 960; // 1 pm on early-close days
  return m >= 240 && m < 570 ? "PRE" : m >= 570 && m < close ? "REGULAR" : m >= close && m < close + 240 ? "POST" : "CLOSED";
}
// a US ticker, optionally with a share class (BRK.B, BF-B); not VOD.L, BMW.F or ABC.V (exchange suffixes)
function looksUS(sym) {
  return /^[A-Z]{1,5}([.\-][A-C])?$/.test(sym);
}

// State of a cached quote at time t (computed at display time, so a cached quote doesn't lie).
function stateOf(q, t) {
  if (q.h24) return "REGULAR"; // crypto trades around the clock (its Yahoo "session" ends at midnight UTC)
  if (q.periods) {
    const inside = (p) => p && t >= p.start && t < p.end;
    return inside(q.periods.regular) ? "REGULAR" : inside(q.periods.pre) ? "PRE" : inside(q.periods.post) ? "POST" : "CLOSED";
  }
  if (q.usHours) {
    // the provider's open/closed flag only holds for the session it was fetched in (it catches holidays)
    const live = usState(t);
    return live === "REGULAR" && q.open === false && usState(q.fetched) === "REGULAR" && t - q.fetched < 8 * 3600 ? "CLOSED" : live;
  }
  return q.state && t - q.fetched < 3600 ? q.state : null; // a provider's open/closed flag goes stale
}

const STATE_LABEL = { PRE: "Pre-market", REGULAR: "Market open", POST: "After hours", CLOSED: "Closed" };

// ---------- providers ----------
// Each provider builds requests and parses responses; httpMany() does the I/O. To add or swap
// a provider, implement: searchReq(q) / parseSearch(json) → [{symbol, name, exchange, type}]
// and quoteReq(symbol) / parseQuote(symbol, json) → quote | null (unknown symbol).

const YAHOO_UA = "Mozilla/5.0"; // Yahoo answers 429 to full browser user agents that don't carry its cookies

const PROVIDERS = {
  yahoo: {
    id: "yahoo",
    name: "Yahoo Finance",
    needsKey: false,
    searchQuotes: 8,
    base: () => env("STOCKS_YAHOO_URL", "https://query1.finance.yahoo.com"),
    // Yahoo writes share classes with a dash: BRK.B is 404, BRK-B is Berkshire Hathaway B
    alias: (sym) => sym.replace(/^([A-Z]{1,5})\.([A-C])$/, "$1-$2"),
    searchReq(q) {
      return { url: `${this.base()}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`, ua: YAHOO_UA };
    },
    parseSearch(v) {
      if (!Array.isArray(v.quotes)) throw new ProviderError("parse", "unexpected search response");
      return v.quotes
        .filter((x) => x && typeof x.symbol === "string" && x.isYahooFinance !== false && x.quoteType !== "OPTION")
        .map((x) => ({ symbol: x.symbol.toUpperCase(), name: name(x.longname) || name(x.shortname), exchange: str(x.exchDisp) || str(x.exchange), type: str(x.typeDisp) || str(x.quoteType) }));
    },
    quoteReq(sym) {
      // includePrePost: the series also covers pre-market and after-hours trading (the extended-hours price)
      return { url: `${this.base()}/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m&includePrePost=true`, ua: YAHOO_UA };
    },
    parseQuote(sym, v) {
      const c = v.chart;
      if (!c || typeof c !== "object") throw new ProviderError("parse", "unexpected quote response");
      if (c.error) {
        if (/not found|delisted/i.test(`${c.error.code} ${c.error.description}`)) return null;
        throw new ProviderError("server", oneLine(str(c.error.description), 80) || "quote error");
      }
      const r = Array.isArray(c.result) ? c.result[0] : null;
      if (!r || !r.meta) return null;
      const m = r.meta;
      const price = num(m.regularMarketPrice);
      if (price === null) return null;
      const q0 = (((r.indicators || {}).quote || [])[0] || {});
      const closes = Array.isArray(q0.close) ? q0.close : [];
      const stamps = Array.isArray(r.timestamp) && r.timestamp.length === closes.length ? r.timestamp.map(num) : null;
      const pts = closes.map((c, i) => ({ t: stamps ? stamps[i] : null, v: num(c) })).filter((x) => x.v !== null);
      const p = m.currentTradingPeriod;
      const period = (x) => (x && num(x.start) !== null && num(x.end) !== null ? { start: num(x.start), end: num(x.end) } : null);
      const reg = p && typeof p === "object" ? period(p.regular) : null;
      const h24 = str(m.instrumentType) === "CRYPTOCURRENCY";
      // the sparkline and day range cover regular hours; the last trade outside them is the extended-hours price
      let series = pts.map((x) => x.v), ext = null;
      if (reg && stamps && !h24) {
        // without extended hours Yahoo ends the series with the closing print, stamped at the session's end
        const last = pts[pts.length - 1];
        const lastIsClose = last && last.t === reg.end && (pts.length < 2 || pts[pts.length - 2].t < reg.end);
        const inReg = pts.filter((x) => x.t !== null && x.t >= reg.start && (x.t < reg.end || (x === last && lastIsClose))).map((x) => x.v);
        if (inReg.length >= 2) series = inReg;
        const kind = last && last.t !== null && !lastIsClose ? (last.t >= reg.end ? "post" : last.t < reg.start ? "pre" : null) : null;
        if (kind && last.v > 0 && last.v !== price) ext = { price: last.v, time: last.t, kind };
      }
      return {
        symbol: sym,
        name: name(m.longName) || name(m.shortName),
        price,
        prev: num(m.previousClose) !== null ? num(m.previousClose) : num(m.chartPreviousClose),
        low: num(m.regularMarketDayLow) !== null ? num(m.regularMarketDayLow) : series.length ? Math.min(...series) : null,
        high: num(m.regularMarketDayHigh) !== null ? num(m.regularMarketDayHigh) : series.length ? Math.max(...series) : null,
        currency: str(m.currency),
        exchange: str(m.fullExchangeName) || str(m.exchangeName),
        exch: str(m.exchangeName),
        type: str(m.instrumentType),
        hint: num(m.priceHint),
        time: num(m.regularMarketTime),
        periods: p && typeof p === "object" ? { pre: period(p.pre), regular: period(p.regular), post: period(p.post) } : null,
        h24,
        ext,
        series,
      };
    },
  },

  finnhub: {
    id: "finnhub",
    name: "Finnhub",
    needsKey: true,
    keyURL: "https://finnhub.io/register",
    searchQuotes: 6, // free plan: 60 calls/minute
    limits: [[60, 55]],
    batch: 30,
    base: () => env("STOCKS_FINNHUB_URL", "https://finnhub.io/api/v1"),
    searchReq(q, key) {
      return { url: `${this.base()}/search?q=${encodeURIComponent(q)}`, headers: { "X-Finnhub-Token": key } };
    },
    parseSearch(v) {
      if (v.error) throw new ProviderError(/limit/i.test(v.error) ? "rate" : "auth", oneLine(redact(str(v.error)), 80) || "API error");
      if (!Array.isArray(v.result)) throw new ProviderError("parse", "unexpected search response");
      return v.result
        .filter((x) => x && typeof x.symbol === "string")
        .map((x) => ({ symbol: x.symbol.toUpperCase(), name: name(x.description), exchange: "", type: str(x.type) }));
    },
    quoteReq(sym, key) {
      return { url: `${this.base()}/quote?symbol=${encodeURIComponent(sym)}`, headers: { "X-Finnhub-Token": key } };
    },
    parseQuote(sym, v) {
      if (v.error) throw new ProviderError(/limit/i.test(v.error) ? "rate" : /access/i.test(v.error) ? "plan" : "auth", oneLine(redact(str(v.error)), 80));
      const price = num(v.c);
      // unknown symbols come back as all zeros with null change
      if (price === null || (price === 0 && !num(v.t) && num(v.d) === null)) return null;
      const us = looksUS(sym);
      return {
        symbol: sym, name: "", price, prev: num(v.pc), change: num(v.d), pct: num(v.dp), low: num(v.l), high: num(v.h),
        currency: us ? "USD" : "", exchange: "", type: "", time: num(v.t), usHours: us, hint: fxHint(sym),
      };
    },
  },

  alphavantage: {
    id: "alphavantage",
    name: "Alpha Vantage",
    needsKey: true,
    keyURL: "https://www.alphavantage.co/support/#api-key",
    searchQuotes: 1, // free plan: 25 calls/day, so quotes are kept for hours and fetched one at a time
    minTTL: 3 * 3600,
    closedTTL: 12 * 3600,
    limits: [["day", 25]],
    batch: 5,
    gap: 60,
    parallel: 1,
    base: () => env("STOCKS_ALPHAVANTAGE_URL", "https://www.alphavantage.co"),
    // Alpha Vantage only accepts the key as a query parameter; the URL goes to curl on stdin
    searchReq(q, key) {
      return { url: `${this.base()}/query?function=SYMBOL_SEARCH&keywords=${encodeURIComponent(q)}&apikey=${encodeURIComponent(key)}` };
    },
    check(v) {
      // errors and rate limits arrive as HTTP 200 with a message
      const msg = str(v.Note) || str(v.Information);
      if (msg && /per day|daily/i.test(msg)) {
        const e = new ProviderError("rate", "daily limit reached (25 requests a day on the free plan)");
        e.until = (Math.floor(now() / 86400) + 1) * 86400; // the quota resets at 00:00 UTC
        throw e;
      }
      if (msg) throw new ProviderError(/api key|apikey/i.test(msg) && !/rate|limit|frequency/i.test(msg) ? "auth" : "rate", /rate|limit|frequency/i.test(msg) ? "rate limit reached" : "API key rejected");
      if (v["Error Message"]) throw new ProviderError(/apikey|api key/i.test(v["Error Message"]) ? "auth" : "server", /apikey|api key/i.test(v["Error Message"]) ? "API key rejected" : "request rejected");
    },
    parseSearch(v) {
      this.check(v);
      if (!Array.isArray(v.bestMatches)) throw new ProviderError("parse", "unexpected search response");
      return v.bestMatches
        .filter((x) => x && typeof x["1. symbol"] === "string")
        .map((x) => ({ symbol: x["1. symbol"].toUpperCase(), name: name(x["2. name"]), exchange: str(x["4. region"]), type: str(x["3. type"]), currency: str(x["8. currency"]) }));
    },
    quoteReq(sym, key) {
      return { url: `${this.base()}/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(sym)}&apikey=${encodeURIComponent(key)}` };
    },
    parseQuote(sym, v) {
      if (v["Error Message"] && /invalid api call/i.test(v["Error Message"])) return null; // unknown symbol
      this.check(v);
      const g = v["Global Quote"];
      if (!g || typeof g !== "object") throw new ProviderError("parse", "unexpected quote response");
      const price = num(g["05. price"]);
      if (price === null) return null; // unknown symbols return an empty "Global Quote"
      const us = looksUS(sym);
      return {
        symbol: sym, name: "", price, prev: num(g["08. previous close"]), change: num(g["09. change"]), pct: num(g["10. change percent"]),
        low: num(g["04. low"]), high: num(g["03. high"]), currency: us ? "USD" : "", exchange: "", type: "", usHours: us, hint: fxHint(sym),
      };
    },
  },

  twelvedata: {
    id: "twelvedata",
    name: "Twelve Data",
    needsKey: true,
    keyURL: "https://twelvedata.com/pricing",
    searchQuotes: 4, // free plan: 8 credits a minute, 800 a day
    minTTL: 5 * 60,
    limits: [[60, 8], ["day", 800]],
    batch: 8,
    gap: 60,
    base: () => env("STOCKS_TWELVEDATA_URL", "https://api.twelvedata.com"),
    searchReq(q, key) {
      return { url: `${this.base()}/symbol_search?symbol=${encodeURIComponent(q)}&outputsize=10`, headers: { Authorization: `apikey ${key}` } };
    },
    check(v) {
      if (v.status === "error") {
        const code = num(v.code);
        if (code === 401) throw new ProviderError("auth", "API key rejected");
        if (code === 403) throw new ProviderError("plan", "not available on your plan"); // "available exclusively with pro…"
        if (code === 429) throw new ProviderError("rate", "rate limit reached (8 requests a minute on the free plan)");
        if (code === 404 || code === 400) return "notfound";
        throw new ProviderError("server", oneLine(redact(str(v.message)), 80) || "API error");
      }
    },
    parseSearch(v) {
      if (this.check(v) === "notfound") return [];
      if (!Array.isArray(v.data)) throw new ProviderError("parse", "unexpected search response");
      return v.data
        .filter((x) => x && typeof x.symbol === "string")
        .map((x) => ({ symbol: x.symbol.toUpperCase(), name: name(x.instrument_name), exchange: str(x.exchange), type: str(x.instrument_type), currency: str(x.currency) }));
    },
    quoteReq(sym, key) {
      return { url: `${this.base()}/quote?symbol=${encodeURIComponent(sym)}`, headers: { Authorization: `apikey ${key}` } };
    },
    parseQuote(sym, v) {
      if (this.check(v) === "notfound") return null;
      const price = num(v.close);
      if (price === null) return null;
      const us = /^(NASDAQ|NYSE|AMEX|NYSE ARCA|BATS|CBOE)$/i.test(str(v.exchange));
      const q = {
        symbol: sym, name: name(v.name), price, prev: num(v.previous_close), change: num(v.change), pct: num(v.percent_change),
        low: num(v.low), high: num(v.high), currency: str(v.currency), exchange: str(v.exchange), type: "",
        time: num(v.last_quote_at) !== null ? num(v.last_quote_at) : num(v.timestamp),
        hint: fxHint(sym),
      };
      if (us) Object.assign(q, { usHours: true, open: v.is_market_open === true ? true : v.is_market_open === false ? false : undefined });
      else if (typeof v.is_market_open === "boolean") q.state = v.is_market_open ? "REGULAR" : "CLOSED";
      return q;
    },
  },
};

// keyed providers send no price precision: currency pairs (EUR/USD, OANDA:EUR_USD) need 4 decimals
function fxHint(sym) {
  const m = sym.match(/^(?:[A-Z]+:)?[A-Z]{3}[\/_]([A-Z]{3})$/);
  return m ? (m[1] === "JPY" ? 3 : 4) : null;
}

function provider() {
  const id = env("provider", "yahoo");
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? PROVIDERS[id] : PROVIDERS.yahoo;
}

// ---------- keychain ----------
// Security framework through the ObjC bridge, so the key never appears in a process's arguments
// (`security add-generic-password -w KEY` would show it in `ps`). Dictionary keys are the string
// values of kSecClass ("class"), kSecAttrService ("svce"), kSecAttrAccount ("acct") and so on.

const ERR_NOT_FOUND = -25300; // errSecItemNotFound

// test suite only: a directory standing in for the keychain (<service>.<account> files)
function testKeyPath(p) {
  const dir = env("STOCKS_TEST_KEYCHAIN", "");
  return dir ? `${dir}/${BUNDLE}.${p.id}` : null;
}
function kcQuery(p) {
  const d = $.NSMutableDictionary.alloc.init;
  d.setObjectForKey($("genp"), $("class"));
  d.setObjectForKey($(BUNDLE), $("svce"));
  d.setObjectForKey($(p.id), $("acct"));
  return d;
}
function getKey(p) {
  const t = testKeyPath(p);
  if (t) return (readFile(t) || "").trim();
  const q = kcQuery(p);
  q.setObjectForKey($.NSNumber.numberWithBool(true), $("r_Data"));
  q.setObjectForKey($("m_LimitOne"), $("m_Limit"));
  const r = Ref();
  if ($.SecItemCopyMatching(q, r) !== 0 || !r[0]) return "";
  const s = $.NSString.alloc.initWithDataEncoding(ObjC.castRefToObject(r[0]), $.NSUTF8StringEncoding);
  return s.isNil() ? "" : s.js.trim();
}
function setKey(p, key) {
  const t = testKeyPath(p);
  if (t) return writeFile(t, key);
  const data = $(key).dataUsingEncoding($.NSUTF8StringEncoding);
  const q = kcQuery(p);
  const upd = $.NSMutableDictionary.alloc.init;
  upd.setObjectForKey(data, $("v_Data"));
  let status = $.SecItemUpdate(q, upd);
  if (status === ERR_NOT_FOUND) {
    q.setObjectForKey(data, $("v_Data"));
    q.setObjectForKey($(`${p.name} API key (Alfred Stocks)`), $("labl"));
    status = $.SecItemAdd(q, null);
  }
  return status === 0;
}
function deleteKey(p) {
  const t = testKeyPath(p);
  if (t) {
    if (!exists(t)) return false;
    removeFile(t);
    return true;
  }
  return $.SecItemDelete(kcQuery(p)) === 0;
}
// plain text on the clipboard ("" when there is none); the test suite stands in with STOCKS_TEST_CLIPBOARD
function clipboardText() {
  const t = env("STOCKS_TEST_CLIPBOARD", null);
  if (t !== null) return t.trim();
  const s = $.NSPasteboard.generalPasteboard.stringForType($.NSPasteboardTypeString);
  return s.isNil() ? "" : s.js.trim();
}
// After a key is saved from the clipboard, clear the clipboard if it still holds that key.
// The test suite stands in with STOCKS_TEST_CLIPBOARD, and STOCKS_TEST_CLIPBOARD_OUT records the clearing.
function clearClipboardIf(text) {
  const t = env("STOCKS_TEST_CLIPBOARD", null);
  if (t !== null) {
    const out = env("STOCKS_TEST_CLIPBOARD_OUT", "");
    if (out && t.trim() === text) writeFile(out, "cleared");
    return;
  }
  if (clipboardText() === text) $.NSPasteboard.generalPasteboard.clearContents;
}
function validKey(k) {
  return /^[A-Za-z0-9._\-]{8,128}$/.test(k);
}
// A clipboard worth offering as a key: a valid key with letters and digits, 16+ characters
function plausibleKey(k) {
  return validKey(k) && k.length >= 16 && /\d/.test(k) && /[A-Za-z]/.test(k);
}

// ---------- formatting ----------

// The system's formatting locale. Formats follow the region, which may differ from the language's:
// "en_US@rg=dezzzz" (English, region Germany) formats as en-DE (1.234,5), not en-US.
// A BCP 47 tag for an NSLocale; "@numbers=latn" (e.g. Arabic with Western digits) becomes -u-nu-latn.
// Alfred runs scripts without LANG/LC_*, so the region always comes from NSLocale (the user's defaults).
function localeTag(l) {
  const part = (k) => {
    const v = l.objectForKey(k);
    return v.isNil() ? "" : v.js;
  };
  const id = l.localeIdentifier.js;
  let tag = [part($.NSLocaleLanguageCode), part($.NSLocaleScriptCode), part($.NSLocaleCountryCode)].filter(Boolean).join("-");
  tag = tag || id.split("@")[0].replace(/_/g, "-");
  const nu = id.match(/[@;]numbers=([a-z]{3,8})\b/i);
  return nu && tag ? `${tag}-u-nu-${nu[1].toLowerCase()}` : tag;
}
function supported(tag) {
  try {
    return !!tag && Intl.NumberFormat.supportedLocalesOf([tag]).length > 0;
  } catch (e) {
    return false; // invalid tag
  }
}

// {tag, system}: the Workflow Configuration's locale (en-US, or macOS style de_DE / en_US@rg=dezzzz),
// else the system's
const LOC = (() => {
  let own = env("number_locale", "").trim();
  if (/[_@]/.test(own)) own = localeTag($.NSLocale.localeWithLocaleIdentifier(own));
  if (supported(own)) return { tag: own, system: false };
  const sys = localeTag($.NSLocale.currentLocale);
  return supported(sys) ? { tag: sys, system: true } : { tag: "en-US", system: false };
})();
const LOCALE = LOC.tag;

// With the system's format, use its separators too: System Settings › Language & Region › Number format
// can override the region's (e.g. English (US) with 1.234,56), which only NSLocale knows about.
const SEPS = (() => {
  if (!LOC.system) return null;
  const l = $.NSLocale.currentLocale;
  const s = (v) => (v.isNil() ? "" : v.js);
  const decimal = s(l.decimalSeparator), group = s(l.groupingSeparator);
  return decimal && decimal !== group ? { decimal, group } : null;
})();

const NF = {};
function nf(min, max, grouping = true) {
  const k = `${min}/${max}/${grouping}`;
  if (NF[k]) return NF[k];
  const f = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: grouping });
  return (NF[k] = !SEPS ? f : {
    format: (v) => f.formatToParts(v).map((p) => (p.type === "decimal" ? SEPS.decimal : p.type === "group" ? SEPS.group : p.value)).join(""),
  });
}

// Decimal places for a price: the provider's hint, more for sub-unit prices (penny stocks, SHIB),
// never scientific notation.
function decimals(price, hint) {
  const h = typeof hint === "number" && hint >= 0 ? Math.min(Math.round(hint), 8) : null;
  const a = Math.abs(price);
  if (!Number.isFinite(a)) return { min: 2, max: 2 };
  if (a === 0) return { min: h === null ? 2 : h, max: h === null ? 2 : h };
  if (a >= 1) {
    const d = Math.max(2, h === null ? 2 : h);
    return { min: d, max: d };
  }
  const max = Math.min(20, Math.max(4, h || 0, Math.ceil(-Math.log10(a)) + 3));
  return { min: Math.min(Math.max(2, h === null ? 2 : h), max), max };
}

function fmtPrice(v, hint, grouping = true) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const d = decimals(v, hint);
  return nf(d.min, d.max, grouping).format(unsignedZero(v));
}

function signed(s, v) {
  return v > 0 ? "+" + s : s;
}
// -0 (from "-0.00" in an API) would print as "-0.00"
function unsignedZero(v) {
  return v === 0 ? 0 : v;
}

// a change uses the price's decimals; below 1 it may need more to stay visible (SHIB: -0.0000000353)
function fmtChange(v, price, hint) {
  if (v === null || !Number.isFinite(v)) return "—";
  const p = Number.isFinite(price) ? price : v;
  const d = decimals(p, hint);
  if (Math.abs(p) < 1 && v !== 0) {
    const c = decimals(v, hint);
    d.max = Math.max(d.max, c.max);
  }
  // a real move shouldn't print as +0.00 (FX without a price hint: +0.0012)
  while (v !== 0 && d.max < 8 && Math.abs(v) < 0.5 * 10 ** -d.max) d.max++;
  d.min = Math.min(d.min, d.max);
  return signed(nf(d.min, d.max).format(unsignedZero(v)), v);
}

function fmtPct(v) {
  if (v === null || !Number.isFinite(v)) return "—";
  return signed(nf(2, 2).format(unsignedZero(v)), v) + "%";
}

function fmtTime(t, ref) {
  const withDate = ref - t > 20 * 3600;
  if (LOC.system) {
    // NSDateFormatter honours the 24-hour time switch in System Settings, which Intl doesn't see
    const f = $.NSDateFormatter.alloc.init;
    f.locale = $.NSLocale.currentLocale;
    f.localizedDateFormatFromTemplate = withDate ? "MMMdjmm" : "jmm";
    const s = f.stringFromDate($.NSDate.dateWithTimeIntervalSince1970(t));
    if (!s.isNil() && s.js) return s.js;
  }
  const opts = withDate ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } : { hour: "numeric", minute: "2-digit" };
  return new Intl.DateTimeFormat(LOCALE, opts).format(new Date(t * 1000));
}

// change and % change, computed when the provider doesn't send them
function changes(q) {
  let change = num(q.change), pct = num(q.pct);
  if (change === null && q.prev !== null && q.prev !== undefined) change = q.price - q.prev;
  if (pct === null && change !== null && q.prev) pct = (change / Math.abs(q.prev)) * 100; // prev < 0: oil futures, April 2020
  return { change, pct };
}

function oneLine(s, max = 80) {
  const t = Array.from(String(s || "").replace(/\s+/g, " ").trim()); // code points: never split an emoji
  return t.length > max ? t.slice(0, max - 1).join("") + "…" : t.join("");
}

// ---------- open in… ----------

const GOOGLE_EXCH = { NMS: "NASDAQ", NGM: "NASDAQ", NCM: "NASDAQ", NAS: "NASDAQ", NYQ: "NYSE", ASE: "NYSEAMERICAN", PCX: "NYSEARCA", BTS: "BATS" };
const GOOGLE_SUFFIX = { L: "LON", DE: "ETR", F: "FRA", PA: "EPA", AS: "AMS", SW: "SWX", TO: "TSE", V: "CVE", T: "TYO", HK: "HKG", AX: "ASX", MI: "BIT", MC: "BME", NS: "NSE", BO: "BOM", KS: "KRX", SS: "SHA", SZ: "SHE", ST: "STO", CO: "CPH", HE: "HEL", OL: "OSL" };
const GOOGLE_INDEX = { "^GSPC": ".INX:INDEXSP", "^DJI": ".DJI:INDEXDJX", "^IXIC": ".IXIC:INDEXNASDAQ", "^NDX": "NDX:INDEXNASDAQ", "^RUT": "RUT:INDEXRUSSELL", "^VIX": "VIX:INDEXCBOE", "^FTSE": "UKX:INDEXFTSE", "^GDAXI": "DAX:INDEXDB", "^N225": "NI225:INDEXNIKKEI" };
const TV_EXCH = { NMS: "NASDAQ", NGM: "NASDAQ", NCM: "NASDAQ", NAS: "NASDAQ", NYQ: "NYSE", ASE: "AMEX", PCX: "AMEX" };
const TV_SUFFIX = { L: "LSE", DE: "XETR", F: "FWB", PA: "EURONEXT", AS: "EURONEXT", SW: "SIX", TO: "TSX", V: "TSXV", T: "TSE", HK: "HKEX", AX: "ASX", MI: "MIL", MC: "BME", NS: "NSE", BO: "BSE", KS: "KRX", SS: "SSE", SZ: "SZSE", ST: "OMXSTO", CO: "OMXCOP", HE: "OMXHEX", OL: "OSL" };
const TV_INDEX = { "^GSPC": "SP-SPX", "^DJI": "DJ-DJI", "^IXIC": "NASDAQ-IXIC", "^NDX": "NASDAQ-NDX", "^RUT": "TVC-RUT", "^VIX": "TVC-VIX", "^FTSE": "TVC-UKX", "^GDAXI": "XETR-DAX", "^N225": "TVC-NI225" };

function siteURL(sym, q) {
  const e = encodeURIComponent;
  const exch = (q && q.exch) || "";
  const suffix = (sym.match(/^([^.]+)\.([A-Z]{1,2})$/) || []).slice(1);
  const crypto = sym.match(/^([A-Z0-9]+)-(USD|EUR|GBP|USDT|BTC|ETH|JPY|CAD|AUD)$/);
  const fx = sym.match(/^([A-Z]{6})=X$/);
  switch (env("open_in", "yahoo")) {
    case "google": {
      let id = GOOGLE_INDEX[sym];
      if (!id && fx) id = `${fx[1].slice(0, 3)}-${fx[1].slice(3)}`;
      else if (!id && crypto) id = sym;
      else if (!id && suffix.length && GOOGLE_SUFFIX[suffix[1]]) id = `${suffix[0]}:${GOOGLE_SUFFIX[suffix[1]]}`;
      else if (!id && GOOGLE_EXCH[exch]) id = `${sym.replace(/-/g, ".")}:${GOOGLE_EXCH[exch]}`;
      return id ? `https://www.google.com/finance/quote/${e(id)}` : `https://www.google.com/search?q=${e(sym + " stock")}`;
    }
    case "tradingview": {
      let id = TV_INDEX[sym];
      if (!id && fx) id = fx[1];
      else if (!id && crypto) id = crypto[1] + crypto[2];
      else if (!id && suffix.length && TV_SUFFIX[suffix[1]]) id = `${TV_SUFFIX[suffix[1]]}-${suffix[0]}`;
      else if (!id && TV_EXCH[exch]) id = `${TV_EXCH[exch]}-${sym.replace(/-/g, ".")}`;
      return id ? `https://www.tradingview.com/symbols/${e(id)}/` : `https://www.tradingview.com/chart/?symbol=${e(sym)}`;
    }
    case "stocks":
      return `stocks://?symbol=${e(sym)}`;
    default:
      return `https://finance.yahoo.com/quote/${e(sym)}/`;
  }
}

function siteName() {
  return { google: "Google Finance", tradingview: "TradingView", stocks: "Stocks" }[env("open_in", "yahoo")] || "Yahoo Finance";
}

// ---------- caches ----------

const quotesPath = () => `${cacheDir()}/quotes.json`;
const searchPath = () => `${cacheDir()}/searches.json`;
const statusPath = () => `${cacheDir()}/status.json`;
const lockPath = () => `${cacheDir()}/refresh.lock`;
const lastRefreshPath = () => `${cacheDir()}/last-refresh.json`;
const sparkDir = () => mkdirs(`${cacheDir()}/spark`);

// {SYMBOL: entry}; entries from another provider are ignored
function loadQuotes() {
  const all = readJSON(quotesPath(), {});
  const p = provider().id, out = Object.create(null);
  for (const [k, v] of Object.entries(all)) if (v && typeof v === "object" && v.provider === p && typeof v.fetched === "number") out[k] = v;
  return out;
}

function saveQuotes(entries) {
  const all = readJSON(quotesPath(), {}); // re-read to merge with a concurrent writer
  const t = now();
  for (const [k, v] of Object.entries(all)) if (!v || typeof v !== "object" || t - (v.fetched || 0) > 7 * 86400) delete all[k];
  Object.assign(all, entries);
  writeFile(quotesPath(), JSON.stringify(all));
}

function ttl(e, t) {
  if (e.missing) return MISSING_TTL;
  const p = Object.prototype.hasOwnProperty.call(PROVIDERS, e.provider) ? PROVIDERS[e.provider] : provider();
  // the long TTL only when the market was already closed at fetch time: a quote fetched just before
  // the close (or before FX's daily 1-minute break) is fetched again to pick up the new session
  const closed = stateOf(e, t) === "CLOSED" && stateOf(e, e.fetched) === "CLOSED";
  // keyed free plans have small budgets (Alpha Vantage: 25 requests a day)
  return Math.max(closed ? Math.max(CLOSED_TTL, p.closedTTL || 0) : OPEN_TTL, p.minTTL || 0);
}
function fresh(e, t) {
  // a timestamp from the future (the clock was changed) doesn't keep a quote fresh forever
  return !!e && e.fetched <= t + 60 && t - e.fetched < ttl(e, t);
}

// The provider-wide state shown on the watchlist: the last refresh's error (or a rate limit or rejected key
// met by a search), and how long to back off before trying again.
function setStatus(err) {
  const t = now();
  writeFile(statusPath(), JSON.stringify(err
    ? { provider: provider().id, at: t, until: err.local ? err.until : Math.max(err.until || 0, t + RETRY_AFTER), kind: err.kind, message: oneLine(redact(err.message), 100), status: err.status }
    : { provider: provider().id, at: t, ok: true }));
}
function lastError() {
  const s = readJSON(statusPath(), {}), t = now();
  if (s.provider !== provider().id || s.ok || typeof s.message !== "string" || !s.message || typeof s.at !== "number") return null;
  if (t < s.at - 60 || (t - s.at > 3600 && !(t < s.until))) return null; // from the future (clock change) or long gone
  return s;
}
function backingOff(err) {
  return !!err && now() < (typeof err.until === "number" ? err.until : err.at + RETRY_AFTER);
}

function refreshRunning() {
  const l = readJSON(lockPath(), null);
  if (!l) return false;
  const a1 = now() - (Number(l.started) || 0), a2 = Date.now() / 1000 - mtime(lockPath());
  if (a1 < -60 || a2 < -60) return false; // started "in the future": the clock was changed
  const age = Math.max(a1, a2);
  // a refresh that Alfred killed (or that crashed) must not block the next one; a slow live one must not start a second
  return typeof l.pid === "number" ? alive(l.pid) && age < REFRESH_MAX : age < LOCK_TTL;
}

// Serialise a read-modify-write across processes: mkdir is atomic. The owner's pid goes inside, so a
// lock left by a killed process (Alfred terminates the previous Script Filter run on each keystroke)
// is taken over at once; one without a pid after a few seconds.
const PID = $.NSProcessInfo.processInfo.processIdentifier;
function withLock(dir, fn) {
  const until = Date.now() + 3000;
  let got = false;
  while (!(got = FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, false, $(), $()))) {
    const age = Date.now() / 1000 - mtime(dir);
    const owner = Number(readFile(`${dir}/pid`));
    if (exists(dir) && (age > 10 || age < -60 || (owner > 1 && !alive(owner)))) removeFile(dir);
    else if (Date.now() > until) break;
    else $.NSThread.sleepForTimeInterval(0.05);
  }
  if (got) writeFile(`${dir}/pid`, String(PID));
  try {
    return fn();
  } finally {
    if (got) removeFile(dir);
  }
}

// Keyed free plans publish per-minute/per-day limits. Every process (Script Filter runs, background
// refreshes) takes its requests from one shared log, so a search right after a watchlist refresh
// doesn't trip the provider's limit. Returns {granted, error}: error when nothing may go out now.
// Yahoo publishes no limit and relies on the back-off after a 429.
const requestsPath = () => `${cacheDir()}/requests.json`;
function takeBudget(p, n) {
  if (!p.limits || n <= 0) return { granted: n, error: null };
  return withLock(`${cacheDir()}/requests.lock`, () => {
    const t = now();
    const all = readJSON(requestsPath(), {});
    for (const k of Object.keys(all)) if (!Object.prototype.hasOwnProperty.call(PROVIDERS, k) || !Array.isArray(all[k])) delete all[k];
    const log = (all[p.id] || []).filter((x) => typeof x === "number" && x <= t + 60 && t - x < 86400);
    let granted = n, wait = 0, daily = false;
    for (const [win, max] of p.limits) {
      const from = win === "day" ? Math.floor(t / 86400) * 86400 : t - win; // daily quotas reset at 00:00 UTC
      const used = log.filter((x) => x > from).sort((a, b) => a - b);
      const left = Math.max(0, max - used.length);
      if (!left) {
        const free = win === "day" ? from + 86400 : used[used.length - max] + win;
        if (free - t > wait) [wait, daily] = [free - t, win === "day"];
      }
      granted = Math.min(granted, left);
    }
    for (let i = 0; i < granted; i++) log.push(t);
    all[p.id] = log;
    writeFile(requestsPath(), JSON.stringify(all));
    if (granted) return { granted, error: null };
    const perMin = (p.limits.find(([w]) => w === 60) || [])[1], perDay = (p.limits.find(([w]) => w === "day") || [])[1];
    const e = new ProviderError("rate", daily ? `daily limit reached (${perDay} requests a day on the free plan)` : `request limit reached (${perMin} a minute on the free plan)`);
    e.until = t + Math.max(1, Math.ceil(wait));
    e.local = true;
    return { granted: 0, error: e };
  });
}

// ---------- sparklines ----------

function hexColor(hex, a = 1) {
  const v = parseInt(hex.slice(1), 16);
  return $.NSColor.colorWithSRGBRedGreenBlueAlpha(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, a);
}

// Draw an intraday sparkline on a coloured tile (matches the other icons). ~5 ms per icon.
function drawSparkline(series, prev, up, path) {
  const S = 128, pad = 22;
  // downsample to ≤ 120 points, always keeping the last one (the current price)
  const step = Math.ceil(series.length / 120);
  const pts = step > 1 ? series.filter((_, i) => i % step === 0 || i === series.length - 1) : series.slice();
  if (pts.length < 2) return false;
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, S, S, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  if (rep.isNil()) return false;
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  const base = up === null ? "#64748B" : up ? "#16A34A" : "#DC2626";
  const tile = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(8, 8, S - 16, S - 16), 24, 24);
  $.NSGradient.alloc.initWithStartingColorEndingColor(hexColor(base).blendedColorWithFractionOfColor(0.25, $.NSColor.whiteColor), hexColor(base).blendedColorWithFractionOfColor(0.2, $.NSColor.blackColor)).drawInBezierPathAngle(tile, -90);
  let lo = Math.min(...pts), hi = Math.max(...pts);
  if (prev !== null && Number.isFinite(prev) && prev > lo - (hi - lo) && prev < hi + (hi - lo)) {
    lo = Math.min(lo, prev);
    hi = Math.max(hi, prev);
  }
  const span = hi - lo || Math.abs(hi) || 1;
  const x = (i) => pad + ((S - 2 * pad) * i) / (pts.length - 1);
  const y = (v) => pad + 6 + ((S - 2 * pad - 12) * (v - lo)) / span;
  if (prev !== null && Number.isFinite(prev) && prev >= lo && prev <= hi) {
    const d = $.NSBezierPath.bezierPath;
    d.moveToPoint($.NSMakePoint(pad, y(prev)));
    d.lineToPoint($.NSMakePoint(S - pad, y(prev)));
    d.lineWidth = 2;
    d.setLineDashCountPhase([4, 4], 2, 0);
    hexColor("#FFFFFF", 0.55).setStroke;
    d.stroke;
  }
  const line = $.NSBezierPath.bezierPath;
  pts.forEach((v, i) => (i ? line.lineToPoint($.NSMakePoint(x(i), y(v))) : line.moveToPoint($.NSMakePoint(x(i), y(v)))));
  line.lineWidth = 5;
  line.lineJoinStyle = $.NSLineJoinStyleRound;
  line.lineCapStyle = $.NSLineCapStyleRound;
  $.NSColor.whiteColor.setStroke;
  line.stroke;
  $.NSGraphicsContext.restoreGraphicsState;
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  return !png.isNil() && png.writeToFileAtomically(path, true);
}

// ---------- fetching ----------

// Fetch quotes for symbols; returns {entries, error, allFailed}. Entries are cached (with sparklines).
// A symbol the plan doesn't cover is cached as unavailable, not reported as an error.
function fetchQuotes(symbols, names = {}) {
  const p = provider();
  const key = p.needsKey ? KEY || (KEY = getKey(p)) : "";
  if (p.needsKey && !key) return { entries: {}, error: new ProviderError("nokey", "no API key"), allFailed: true };
  const budget = takeBudget(p, symbols.length);
  if (!budget.granted) return { entries: {}, error: budget.error, allFailed: true };
  symbols = symbols.slice(0, budget.granted); // the rest wait for the next refresh (or ⇥ in a search)
  const resps = httpMany(symbols.map((s) => p.quoteReq(s, key)), p.parallel || 8);
  const t = now(), old = loadQuotes(), entries = {};
  let error = null, failed = 0;
  const sparks = enabled("sparklines", true);
  resps.forEach((r, i) => {
    const sym = symbols[i];
    try {
      const v = parseBody(p, r, { notFoundOk: true });
      const q = v === null ? null : p.parseQuote(sym, v);
      if (!q) {
        entries[sym] = { symbol: sym, provider: p.id, fetched: t, missing: true };
        return;
      }
      q.name = q.name || names[sym] || (old[sym] && old[sym].name) || "";
      q.provider = p.id;
      q.fetched = t;
      const series = q.series || [];
      delete q.series;
      if (sparks && series.length > 1) {
        const { change } = changes(q);
        const file = `${sparkDir()}/${safeName(sym)}-${Math.round(t * 1000)}.png`;
        if (drawSparkline(series, q.prev, change === null || change === 0 ? null : change > 0, file)) q.spark = file;
      }
      entries[sym] = q;
    } catch (e) {
      if (!(e instanceof ProviderError)) e = new ProviderError("parse", "unexpected response");
      if (e.kind === "plan") {
        entries[sym] = { symbol: sym, provider: p.id, fetched: t, missing: true, plan: true };
        return;
      }
      failed++;
      error = error || e;
    }
  });
  saveQuotes(entries);
  pruneSparklines(entries);
  return { entries, error, allFailed: failed > 0 && failed === symbols.length };
}

// keep only the newest sparkline per symbol (Alfred caches icons by path, so each refresh writes a new file)
function pruneSparklines(entries) {
  const dir = sparkDir(), keep = new Set(), all = readJSON(quotesPath(), {});
  for (const v of Object.values(all)) if (v && v.spark) keep.add(v.spark);
  for (const v of Object.values(entries)) if (v && v.spark) keep.add(v.spark);
  const t = Date.now() / 1000;
  for (const f of listDir(dir)) {
    const path = `${dir}/${f}`;
    if (!keep.has(path) && t - mtime(path) > 5) removeFile(path);
  }
}

function search(q) {
  const p = provider();
  const k = `${p.id}:${q.toLowerCase()}`;
  const cache = readJSON(searchPath(), {});
  for (const [ck, v] of Object.entries(cache)) if (!v || typeof v !== "object" || typeof v.at !== "number" || !Array.isArray(v.results)) delete cache[ck];
  const hit = cache[k];
  if (hit && now() - hit.at < (hit.results.length ? SEARCH_TTL : EMPTY_SEARCH_TTL) && hit.at <= now() + 60) {
    const valid = hit.results.filter((r) => r && typeof r === "object" && typeof r.symbol === "string" && SYMBOL_RE.test(r.symbol));
    if (valid.length === hit.results.length) return valid.map((r) => ({ symbol: r.symbol, name: str(r.name), exchange: str(r.exchange), type: str(r.type) }));
  }
  // after a rate limit, don't ask again on every keystroke
  const err = lastError();
  if (err && err.kind === "rate" && backingOff(err)) throw Object.assign(new ProviderError("rate", err.message, err.status), { until: err.until, recorded: true });
  const key = p.needsKey ? KEY || (KEY = getKey(p)) : "";
  const budget = takeBudget(p, 1);
  if (!budget.granted) throw budget.error;
  let results = p.parseSearch(parseBody(p, httpMany([p.searchReq(q, key)])[0]));
  const plain = q.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (!results.length && plain !== q && takeBudget(p, 1).granted) results = p.parseSearch(parseBody(p, httpMany([p.searchReq(plain, key)])[0]));
  const seen = new Set();
  results = results.filter((r) => SYMBOL_RE.test(r.symbol) && !seen.has(r.symbol) && seen.add(r.symbol)).slice(0, 10);
  cache[k] = { at: now(), results };
  const keys = Object.keys(cache).sort((a, b) => (cache[b].at || 0) - (cache[a].at || 0));
  for (const old of keys.slice(100)) delete cache[old];
  writeFile(searchPath(), JSON.stringify(cache));
  return results;
}

// ---------- watchlist ----------

const watchlistPath = () => `${dataDir()}/watchlist.json`;

function defaultWatchlist() {
  return provider().id === "yahoo" ? ["^GSPC", "^IXIC", "AAPL"] : ["SPY", "QQQ", "AAPL"];
}

function cleanSymbols(list) {
  const seen = new Set(), out = [];
  for (const s of list) {
    if (typeof s !== "string") continue;
    const u = s.trim().toUpperCase();
    if (SYMBOL_RE.test(u) && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out.slice(0, MAX_WATCHLIST);
}

// {symbols, damaged}: a damaged file is never overwritten silently; its symbols are salvaged.
function loadWatchlist() {
  if (!exists(watchlistPath())) return { symbols: defaultWatchlist(), damaged: false };
  const raw = readFile(watchlistPath()) || ""; // null: not valid UTF-8
  try {
    const v = JSON.parse(raw);
    const list = Array.isArray(v) ? v : v && Array.isArray(v.symbols) ? v.symbols : null;
    if (list) return { symbols: cleanSymbols(list), damaged: false };
  } catch (e) {
    /* fall through */
  }
  const salvaged = cleanSymbols((raw.match(/"([^"\\\n]{1,32})"/g) || []).map((s) => s.slice(1, -1)).filter((s) => s !== "symbols" && s !== "version"));
  return { symbols: salvaged, damaged: true };
}

// Serialise read-modify-write edits (two quick ⌥↩ in a row, or an edit while another runs).
function withWatchlistLock(fn) {
  return withLock(`${dataDir()}/watchlist.lock`, fn);
}

// keep the newest 5 backups of each kind
function pruneBackups() {
  for (const kind of ["damaged", "backup"]) {
    const files = listDir(dataDir()).filter((f) => f.startsWith(`watchlist.json.${kind}-`)).sort((a, b) => Number(b.split("-").pop()) - Number(a.split("-").pop()));
    for (const f of files.slice(5)) removeFile(`${dataDir()}/${f}`);
  }
}

function saveWatchlist(symbols) {
  const path = watchlistPath();
  if (exists(path) && loadWatchlist().damaged) { // keep a backup of an unreadable file
    FM.copyItemAtPathToPathError(path, `${path}.damaged-${Math.round(Date.now() / 1000)}`, $());
    pruneBackups();
  }
  return writeFile(path, JSON.stringify({ version: 1, symbols: cleanSymbols(symbols) }, null, 2) + "\n");
}

// ---------- Script Filter items ----------

function icon(name) {
  return { path: `icons/${name}.png` };
}

function info(title, subtitle, iconName = "info", extra = {}) {
  return Object.assign({ title, subtitle: subtitle || "", valid: false, icon: icon(iconName) }, extra);
}

// modifiers are disabled so ⌘↩ doesn't copy the internal arg and ⌥/⌃ don't run the action as a watchlist edit
function actionItem(title, subtitle, action, arg, iconName, extra = {}) {
  const off = { arg: "", valid: false, subtitle };
  return Object.assign({ title, subtitle, arg, variables: { stocks_action: action }, icon: icon(iconName), mods: { cmd: off, alt: off, ctrl: off, shift: off } }, extra);
}

// "5 min", "3 h": how long until a rate limit lifts
function fmtWait(sec) {
  if (!(sec > 90)) return "a minute";
  if (sec < 3600) return `${Math.ceil(sec / 60)} min`;
  return `${Math.round(sec / 3600)} h`;
}
// "5 min ago", for the row above quotes shown from the cache while offline
function fmtAgo(sec) {
  const m = Math.round(sec / 60);
  if (m < 1) return "less than a minute ago";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// cachedAge: seconds since the quotes shown with this row were fetched (network errors only; null when none are shown)
function errorItem(err, p, cachedAge = null) {
  // a missing or rejected key points to `stock apikey`, with the same wording as the other workflows
  if (err.kind === "nokey") return info(`Set your ${p.name} API key`, `Save it via “${keyCommand()}”`, "key", { autocomplete: "apikey " });
  if (err.kind === "auth" && p.needsKey) return info(`${p.name} rejected your API key`, `Save a new one via “${keyCommand()}”`, "error", { autocomplete: "apikey " });
  if (err.kind === "network") {
    if (cachedAge !== null) return info(`Offline: showing results from ${fmtAgo(Math.max(0, cachedAge))}`, "Check your internet connection", "offline");
    return info(`Can’t reach ${p.name}`, "Check your internet connection", "offline");
  }
  const msg = oneLine(redact(err.message), 100); // provider text: may hold newlines or be long
  const pick = "↩ Pick another provider in the Workflow’s Configuration";
  if (err.kind === "rate") {
    const until = typeof err.until === "number" ? err.until : 0;
    const detail = /^(rate limited|rate limit reached)$/i.test(msg) || !msg ? "" : ` · ${capital(msg)}`;
    return actionItem(`${p.name} is limiting requests`, `Try again in ${fmtWait(until - now())}${detail} · ${pick}`, "config", "config", "error");
  }
  const sub = err.kind === "auth" ? `The provider blocked the request. ${pick}` : `The service may have changed or be down. ${pick}`;
  const title = `Couldn’t get data from ${p.name}: ${msg}${err.status && !/\d{3}/.test(msg) ? ` (HTTP ${err.status})` : ""}`;
  return actionItem(title, sub, "config", "config", "error");
}

function quoteItem(q, t, inWatchlist, watchMode) {
  const { change, pct } = changes(q);
  const arrow = change === null ? "" : change > 0 ? "▲ " : change < 0 ? "▼ " : "• ";
  const price = fmtPrice(q.price, q.hint);
  const cur = q.currency ? ` ${q.currency}` : "";
  const state = stateOf(q, t);
  const parts = [];
  if (q.name && q.name.toUpperCase() !== q.symbol) parts.push(oneLine(q.name, 50));
  if (q.exchange) parts.push(q.exchange);
  if (q.low !== null && q.low !== undefined && q.high !== null && q.high !== undefined) parts.push(`Day ${fmtPrice(q.low, q.hint)} – ${fmtPrice(q.high, q.hint)}`);
  const ext = extended(q, state);
  if (state === "POST" && ext) parts.push(`${STATE_LABEL.POST} ${ext}`);
  else if (state === "PRE" && ext) parts.push(`${STATE_LABEL.PRE} ${ext}`);
  else if (state) parts.push(ext ? `${STATE_LABEL[state]} · after hours ${ext}` : STATE_LABEL[state]);
  // the last trade's time when the quote is stale or the price is from an earlier day (a weekend, a halt)
  const asOf = typeof q.time === "number" && q.time > 0 && q.time <= q.fetched + 60 ? q.time : q.fetched;
  if (t - q.fetched > ttl(q, t) * 3 || t - asOf > 20 * 3600) parts.push(`as of ${fmtTime(asOf, t)}`);
  const url = siteURL(q.symbol, q);
  const plain = fmtPrice(q.price, q.hint, false);
  const iconPath = q.spark && enabled("sparklines", true) && exists(q.spark) ? { path: q.spark } : icon(change === null || change === 0 ? "flat" : change > 0 ? "up" : "down");
  const move = `${arrow}${fmtChange(change, q.price, q.hint)} (${fmtPct(pct)})`;
  const title = `${q.symbol}   ${price}${cur}   ${move}`;
  const summary = `${q.symbol} ${price}${cur} ${move}${ext ? ` · ${q.ext.kind === "pre" ? "pre-market" : "after hours"} ${ext}` : ""}`;
  const item = {
    title,
    subtitle: star(inWatchlist, watchMode) + parts.join(" · "),
    arg: url,
    autocomplete: q.symbol,
    quicklookurl: /^https:/.test(url) ? url : `https://finance.yahoo.com/quote/${encodeURIComponent(q.symbol)}/`,
    variables: { stocks_action: "open" },
    icon: iconPath,
    text: { copy: plain, largetype: `${q.symbol}  ${price}${cur}\n${move}${ext ? `\n${q.ext.kind === "pre" ? "Pre-market" : "After hours"} ${ext}` : ""}` },
    mods: {
      cmd: { arg: plain, valid: true, subtitle: `Copy the price: ${plain}` },
      shift: { arg: summary, valid: true, subtitle: `Copy “${oneLine(summary, 70)}”` },
      alt: {
        arg: q.symbol,
        valid: true,
        subtitle: inWatchlist ? `Remove ${q.symbol} from the watchlist` : `Add ${q.symbol} to the watchlist`,
        variables: { stocks_action: "toggle", stocks_reopen: watchMode ? "1" : "0" },
      },
    },
  };
  item.mods.ctrl = topMod(q.symbol, inWatchlist, watchMode);
  return item;
}

// The extended-hours price with its change from the regular close ("341.46 (+0.11%)"), while it's current:
// after hours until the next pre-market, pre-market until the open
function extended(q, state) {
  const e = q.ext;
  if (!e || typeof e !== "object" || !Number.isFinite(e.price) || !Number.isFinite(q.price) || !q.price) return "";
  if (!(e.kind === "post" ? state === "POST" || state === "CLOSED" : e.kind === "pre" && state === "PRE")) return "";
  return `${fmtPrice(e.price, q.hint)} (${fmtPct(((e.price - q.price) / Math.abs(q.price)) * 100)})`;
}

// search results that are already in the watchlist
function star(inWatchlist, watchMode) {
  return inWatchlist && !watchMode ? "★ " : "";
}

// ⌃↩: move to the top of the watchlist (or add it there from a search)
function topMod(sym, inWatchlist, watchMode) {
  return { arg: sym, valid: true, subtitle: inWatchlist ? `Move ${sym} to the top of the watchlist` : `Add ${sym} to the top of the watchlist`, variables: { stocks_action: "top", stocks_reopen: watchMode ? "1" : "0" } };
}

// a symbol without a quote (not loaded yet, not quoted by a keyed plan, or unknown)
function plainItem(sym, meta, inWatchlist, watchMode, subtitle) {
  const url = siteURL(sym, null);
  const item = {
    title: meta && meta.name ? `${sym}   ${oneLine(meta.name, 60)}` : sym,
    subtitle: star(inWatchlist, watchMode) + (subtitle || [meta && meta.exchange, meta && meta.type].filter(Boolean).join(" · ") || `Open in ${siteName()}`),
    arg: url,
    autocomplete: sym,
    quicklookurl: /^https:/.test(url) ? url : `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}/`,
    variables: { stocks_action: "open" },
    icon: icon("flat"),
    mods: {
      cmd: { arg: sym, valid: true, subtitle: `Copy ${sym}` },
      shift: { arg: sym, valid: true, subtitle: `Copy ${sym}` },
      alt: {
        arg: sym,
        valid: true,
        subtitle: inWatchlist ? `Remove ${sym} from the watchlist` : `Add ${sym} to the watchlist`,
        variables: { stocks_action: "toggle", stocks_reopen: watchMode ? "1" : "0" },
      },
    },
  };
  item.mods.ctrl = topMod(sym, inWatchlist, watchMode);
  return item;
}

// A watchlist refresh: its outcome is what the watchlist's error row and back-off are based on.
function refreshQuotes(symbols) {
  writeFile(lastRefreshPath(), JSON.stringify({ provider: provider().id, at: now() }));
  setStatus(fetchQuotes(symbols).error);
}

function startRefresh(symbols) {
  if (env("STOCKS_SYNC", "0") === "1") {
    // test suite only: refresh in-process
    refreshQuotes(symbols);
    return false;
  }
  // this process's pid until the refresh's is known: if Alfred kills this run first, the lock is dead at once
  writeFile(lockPath(), JSON.stringify({ started: now(), symbols, pid: PID }));
  const script = `${FM.currentDirectoryPath.js}/stocks.js`;
  const pid = spawn("/usr/bin/osascript", ["-l", "JavaScript", script, "refresh", ...symbols]);
  if (!pid) {
    removeFile(lockPath());
    return false;
  }
  const l = readJSON(lockPath(), null); // the refresh may have written its own lock already (or finished)
  if (l && l.pid === PID) writeFile(lockPath(), JSON.stringify({ started: l.started, symbols, pid }));
  return true;
}

function watchlistItems() {
  const p = provider(), t = now();
  const wl = loadWatchlist();
  const items = [];
  if (wl.damaged)
    items.push(actionItem("The watchlist file is damaged", wl.symbols.length ? `↩ Save the ${wl.symbols.length} recovered symbols (the damaged file is backed up)` : "↩ Start a new watchlist (the damaged file is backed up)", "restore", wl.symbols.join(" ") || "-", "error"));
  if (!wl.symbols.length) {
    items.push(info("Your watchlist is empty", "Type a ticker or company name, then ⌥↩ to add it", "info"));
    return { items };
  }
  let quotes = loadQuotes();
  // the oldest first, a batch at a time: keyed free plans allow a few requests a minute
  const stale = wl.symbols.filter((s) => !fresh(quotes[s], t)).sort((a, b) => ((quotes[a] || {}).fetched || 0) - ((quotes[b] || {}).fetched || 0));
  let running = refreshRunning();
  // after a failure, wait before trying again: with rerun this would otherwise hammer a rate-limited API
  const backoff = backingOff(lastError());
  const last = readJSON(lastRefreshPath(), {});
  const tooSoon = !!p.gap && last.provider === p.id && t >= last.at && t - last.at < p.gap;
  if (stale.length && !running && !backoff && !tooSoon) {
    running = startRefresh(stale.slice(0, p.batch || MAX_WATCHLIST));
    quotes = loadQuotes();
  }
  // the next batch is due once the provider's per-minute budget allows it
  const waiting = !running && !backoff && tooSoon && stale.length > 0;
  const err = lastError();
  if (err && !running) {
    // quotes shown from the cache while offline: how old the oldest one is
    const shown = wl.symbols.map((s) => quotes[s]).filter((q) => q && !q.missing && typeof q.fetched === "number");
    items.push(errorItem(err, p, shown.length ? t - Math.min(...shown.map((q) => q.fetched)) : null));
  }
  for (const s of wl.symbols) {
    const q = quotes[s];
    if (q && !q.missing) items.push(quoteItem(q, t, true, true));
    else if (q && q.missing) items.push(plainItem(s, null, true, true, q.plan ? `Not available on your ${p.name} plan` : `No data from ${p.name}: unknown or delisted symbol`));
    else items.push(plainItem(s, null, true, true, running || waiting ? "Loading…" : "No quote yet"));
  }
  return running ? { items, rerun: 0.5 } : waiting ? { items, rerun: 5 } : { items };
}

function searchItems(query) {
  const p = provider(), t = now();
  const wl = new Set(loadWatchlist().symbols);
  const upper = query.trim().toUpperCase();
  const typed = p.alias ? p.alias(upper) : upper;
  const typedIsSymbol = !/\s/.test(typed) && typed.length <= 15 && SYMBOL_RE.test(typed);
  let results, error = null;
  try {
    results = search(query.trim());
  } catch (e) {
    if (!(e instanceof ProviderError)) e = new ProviderError("parse", "unexpected response");
    error = e;
    results = [];
  }
  const meta = Object.create(null);
  for (const r of results) meta[r.symbol] = r;
  const symbols = results.map((r) => r.symbol);
  // An exact ticker goes first. One the search doesn't know is still tried: first when typed in
  // capitals ("TWTR"), last when it's probably a name ("tesco"), so it doesn't use up a keyed plan's
  // few quotes (Alpha Vantage quotes one result per search)
  const q0 = query.trim();
  if (typedIsSymbol && meta[typed]) symbols.splice(0, symbols.length, typed, ...symbols.filter((s) => s !== typed));
  else if (typedIsSymbol && q0 === q0.toUpperCase()) symbols.unshift(typed);
  else if (typedIsSymbol && !(error && error.kind === "rate")) symbols.push(typed); // rate limited: only a ticker typed in capitals
  const wanted = symbols.slice(0, p.searchQuotes);
  let quotes = loadQuotes();
  const stale = wanted.filter((s) => !fresh(quotes[s], t));
  // a rate limit or rejected key applies to every request; after a failed search (Yahoo: another
  // endpoint) a typed ticker is still quoted
  const st = lastError();
  if (!error && stale.length && p.needsKey && st && st.kind === "rate" && backingOff(st))
    error = Object.assign(new ProviderError("rate", st.message, st.status), { recorded: true }); // cached search, but quotes would hit the limit
  const blocked = error && (["auth", "nokey", "network"].includes(error.kind) || (error.kind === "rate" && p.needsKey));
  if (error && !error.recorded && ["rate", "auth"].includes(error.kind)) setStatus(error); // not again: that would extend the back-off
  if (stale.length && !blocked) {
    const names = {};
    for (const s of stale) if (meta[s] && meta[s].name) names[s] = meta[s].name;
    const res = fetchQuotes(stale, names);
    if (res.error && res.allFailed && ["rate", "auth"].includes(res.error.kind)) setStatus(res.error);
    else if (!res.error && !error) setStatus(null); // requests work again: clear the watchlist's error row
    error = error || res.error;
    quotes = loadQuotes();
  }
  const items = [];
  for (const s of symbols) {
    const q = quotes[s];
    if (q && !q.missing) items.push(quoteItem(q, t, wl.has(s), false));
    else if (q && q.missing) {
      if (meta[s]) items.push(plainItem(s, meta[s], wl.has(s), false, q.plan ? `Not available on your ${p.name} plan` : "No quote available"));
    } else if (meta[s]) items.push(plainItem(s, meta[s], wl.has(s), false, [meta[s].exchange, meta[s].type, "⇥ to load the quote"].filter(Boolean).join(" · ")));
  }
  if (error) {
    // below the quotes when some came through (a failed search with a typed ticker), else on top
    const shown = symbols.map((s) => quotes[s]).filter((q) => q && !q.missing);
    const quoted = shown.length > 0;
    const fetched = shown.map((q) => q.fetched).filter((f) => typeof f === "number");
    if (quoted) items.push(errorItem(error, p, fetched.length ? t - Math.min(...fetched) : null));
    else items.unshift(errorItem(error, p));
  }
  if (!items.length) {
    if (typedIsSymbol && quotes[typed] && quotes[typed].plan)
      items.push(info(`No data for ${typed}`, `Not available on your ${p.name} plan`, "search"));
    else if (typedIsSymbol && quotes[typed] && quotes[typed].missing)
      items.push(info(`No data for ${typed}`, `${p.name} has no quote for this symbol: it may be delisted or misspelt`, "search"));
    else items.push(info(`No results for “${oneLine(query, 40)}”`, "Try a ticker such as AAPL, BTC-USD or EURUSD=X", "search"));
  }
  return { items };
}

// ---------- API key rows ----------
// The same rows, wording and icons as the other x-o-r-r-o workflows: `stock apikey` offers
// "Save API key from clipboard", "Save typed API key", "Remove the saved API key" and
// "Get an API key…". The key travels to the action in a variable (the environment), never as the
// argument, which the action script would receive on its command line (visible in `ps`).

function kwStock() {
  return env("keyword_stock", "").trim() || "stock"; // a required field can still arrive empty
}
function keyCommand() {
  return `${kwStock()} apikey`;
}
function maskKey(k) {
  return `••••${k.slice(-4)}`;
}
function saveKeyItem(source, key) {
  const masked = maskKey(key);
  const typed = source === "typed";
  const sub = typed ? `${masked} · Typed keys are briefly visible to other processes: the clipboard is safer` : `${masked} · Stored in your macOS Keychain`;
  return actionItem(typed ? "Save typed API key" : "Save API key from clipboard", sub, "savekey", "savekey", "key", {
    variables: { stocks_action: "savekey", stocks_key: key, stocks_key_source: source },
    text: { copy: masked, largetype: masked },
  });
}
function getKeyItem(p) {
  return actionItem("Get an API key…", `Opens ${p.name}’s API key page · Copy the key, then type “${keyCommand()}”`, "open", p.keyURL, "key-get");
}
function keyItems(p, typed) {
  if (!p.needsKey)
    return [actionItem(`${p.name} doesn’t use an API key`, "↩ Pick Finnhub, Twelve Data or Alpha Vantage in the Workflow’s Configuration", "config", "config", "settings")];
  const items = [];
  const clip = clipboardText();
  if (plausibleKey(clip)) items.push(saveKeyItem("clipboard", clip));
  if (typed && typed !== clip) {
    if (validKey(typed)) items.push(saveKeyItem("typed", typed));
    else items.push(info(`That doesn’t look like a ${p.name} API key`, "Paste the key exactly as shown on the provider’s site", "error"));
  }
  if (getKey(p)) items.push(actionItem("Remove the saved API key", "Deletes it from your macOS Keychain", "delkey", p.id, "key-remove"));
  items.push(getKeyItem(p));
  return items;
}

function settingsItems(query) {
  const p = provider();
  const [cmd, ...rest] = query.slice(1).split(/\s+/);
  const argText = rest.join(" ").trim();
  if (cmd.toLowerCase() === "key") return { items: keyItems(p, argText) }; // “:key” is an alias of “apikey”
  const all = [
    p.needsKey ? info("apikey  API key", `Save or remove your ${p.name} API key`, "key", { autocomplete: "apikey ", match: "key" }) : null,
    actionItem(":reset  Reset the watchlist", `↩ Replace it with ${defaultWatchlist().join(", ")} (a backup is kept)`, "reset", "reset", "watch", { autocomplete: ":reset" }),
    actionItem(":cache  Clear cached quotes", "↩ Fetch everything again", "clearcache", "clearcache", "refresh", { autocomplete: ":cache" }),
    actionItem(":config  Open the Workflow’s Configuration", `Provider: ${p.name}${p.id === "yahoo" ? " (unofficial API, no key)" : ""} · Opens in ${siteName()}`, "config", "config", "settings", { autocomplete: ":config" }),
  ].filter(Boolean);
  const matches = all.filter((i) => (i.match || i.title.slice(1)).startsWith(cmd || ""));
  for (const i of all) delete i.match; // “:k” still finds the API key row
  return { items: matches.length ? matches : all };
}

// Rows need a uid for Alfred to keep the selected row while the Script Filter reruns (rerun):
// without one the selection jumps back to the first row on every rerun (found in real Alfred).
// The uid is the position plus the title with its numbers masked, so countdowns, prices and clocks
// keep it, while typing something new changes it and the selection resets to the top as usual.
function stableUids(items) {
  items.forEach((it, i) => {
    if (it && !it.uid) it.uid = `${i}|${String(it.title || "").replace(/[0-9]+/g, "#")}`;
  });
  return items;
}

function filter(query) {
  const p = provider();
  const q = query.replace(/[\r\n\t]+/g, " ").trim();
  // “apikey” as the exact first word (any case) opens the API key rows; it is never a ticker search
  const ak = /^apikey(?:\s+([\s\S]*))?$/i.exec(q);
  if (ak) return { items: keyItems(p, (ak[1] || "").trim()) };
  if (q.startsWith(":")) return settingsItems(q);
  if (p.needsKey && !(KEY = getKey(p))) {
    const items = [info(`Set your ${p.name} API key`, `Save it via “${keyCommand()}” · or pick Yahoo Finance (no key) in the Workflow’s Configuration`, "key", { autocomplete: "apikey " })];
    const clip = clipboardText();
    if (plausibleKey(clip)) items.push(saveKeyItem("clipboard", clip));
    items.push(getKeyItem(p));
    return { items };
  }
  return q === "" ? watchlistItems() : searchItems(q);
}

function refresh(symbols) {
  $.setsid(); // leave Alfred's process group so a new keystroke doesn't kill the refresh
  const pid = PID;
  writeFile(lockPath(), JSON.stringify({ started: now(), symbols, pid }));
  try {
    refreshQuotes(cleanSymbols(symbols));
  } finally {
    const l = readJSON(lockPath(), null);
    if (!l || l.pid === pid) removeFile(lockPath()); // never another refresh's lock
  }
  return "";
}

// ---------- actions ----------

function reopen() {
  const kw = kwStock();
  exec("/usr/bin/osascript", ["-e", "on run argv", "-e", 'tell application id "com.runningwithcrayons.Alfred" to search (item 1 of argv)', "-e", "end run", `${kw} `]);
}

function act(arg) {
  const action = env("stocks_action", "open");
  const p = provider();
  // test suite only: don't launch apps ("1": say what would have opened, "silent": print what Alfred would get)
  const test = env("STOCKS_TEST_NOOPEN", "0") !== "0", report = env("STOCKS_TEST_NOOPEN", "0") === "1";
  switch (action) {
    case "open":
      const url = /^(https:\/\/|stocks:\/\/)/.test(arg) ? $.NSURL.URLWithString(arg) : null;
      if (!url || url.isNil()) return "";
      if (!test) $.NSWorkspace.sharedWorkspace.openURL(url);
      return report ? `open ${arg}` : "";
    case "toggle":
    case "top": {
      const sym = arg.trim().toUpperCase();
      if (!SYMBOL_RE.test(sym)) return "Not a valid symbol";
      const [ok, msg] = withWatchlistLock(() => {
        const list = loadWatchlist().symbols;
        let next;
        if (action === "top") {
          if (!list.includes(sym) && list.length >= MAX_WATCHLIST) return [false, `The watchlist is full (${MAX_WATCHLIST} symbols)`];
          next = [sym, ...list.filter((s) => s !== sym)];
          if (!saveWatchlist(next)) return [false, "Couldn’t save the watchlist"];
          return [true, list.includes(sym) ? `Moved ${sym} to the top of the watchlist` : `Added ${sym} to the top of the watchlist`];
        }
        if (list.includes(sym)) {
          next = list.filter((s) => s !== sym);
          return saveWatchlist(next) ? [true, `Removed ${sym} from the watchlist`] : [false, "Couldn’t save the watchlist"];
        }
        if (list.length >= MAX_WATCHLIST) return [false, `The watchlist is full (${MAX_WATCHLIST} symbols)`];
        return saveWatchlist([...list, sym]) ? [true, `Added ${sym} to the watchlist`] : [false, "Couldn’t save the watchlist"];
      });
      if (ok && env("stocks_reopen", "0") === "1" && !test) reopen();
      return msg;
    }
    case "restore":
      return withWatchlistLock(() => saveWatchlist(arg === "-" ? [] : arg.split(/\s+/))) ? "Watchlist repaired" : "Couldn’t save the watchlist";
    case "reset": {
      return withWatchlistLock(() => {
        if (exists(watchlistPath())) FM.copyItemAtPathToPathError(watchlistPath(), `${watchlistPath()}.backup-${Math.round(Date.now() / 1000)}`, $());
        pruneBackups();
        return saveWatchlist(defaultWatchlist());
      }) ? "Watchlist reset" : "Couldn’t save the watchlist";
    }
    case "clearcache":
      for (const f of [quotesPath(), searchPath(), statusPath(), lastRefreshPath()]) removeFile(f);
      FM.removeItemAtPathError(`${cacheDir()}/spark`, $());
      return "Cleared cached quotes";
    case "savekey": {
      const key = env("stocks_key", "").trim(); // from the Script Filter's variables, never argv
      if (!p.needsKey) return `Couldn’t save the API key: ${p.name} doesn’t use one`;
      if (!validKey(key)) return `Couldn’t save the API key: it doesn’t look like a ${p.name} API key`;
      if (!setKey(p, key)) return "Couldn’t save the API key: the Keychain refused it";
      if (env("stocks_key_source", "") === "clipboard") clearClipboardIf(key);
      removeFile(statusPath());
      return "API key saved";
    }
    case "delkey":
      if (!getKey(p)) return "Couldn’t remove the API key: none is saved";
      if (!deleteKey(p)) return "Couldn’t remove the API key: the Keychain refused it";
      removeFile(statusPath());
      return "API key removed";
    case "config":
      if (!test) exec("/usr/bin/osascript", ["-e", "on run argv", "-e", 'tell application id "com.runningwithcrayons.Alfred" to reveal workflow (item 1 of argv)', "-e", "end run", BUNDLE]);
      return report ? "config" : "";
  }
  return "";
}

// Alfred rejects the whole JSON when a string holds an unpaired surrogate (from "&#xD800;" or a bad API).
// Bidi overrides and control characters (from an API's names or the query) are removed from display
// text; newlines stay (Large Type). Args are URLs, validated symbols or fixed words, so nothing real is lost.
function wellFormed(k, v) {
  if (typeof v !== "string") return v;
  return v
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (m) => (m.length === 2 ? m : "\uFFFD"))
    .replace(/[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]+/g, " ");
}

function run(argv) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "filter": {
        // the query comes in stocks_query (see workflow.json) or, for tests, as arguments
        const res = filter(rest.length ? rest.join(" ") : env("stocks_query", ""));
        stableUids(res.items || []);
        return JSON.stringify(Object.assign({ skipknowledge: true }, res), wellFormed);
      }
      case "refresh":
        refresh(rest);
        return undefined;
      case "act": // "" would still print a newline, and Alfred's notification would show up empty
        return act(rest.join(" ")) || undefined;
      case "fmt": // formatting check used by the test suite: fmt <price[,hint] | t:epoch>… [-AppleXxx value]…
        return JSON.stringify(rest.filter((x, i) => !/^-Apple/.test(x) && !/^-Apple/.test(rest[i - 1] || "")).map((x) => {
          if (x.startsWith("t:")) return fmtTime(Number(x.slice(2)), now());
          const [v, h] = x.split(",");
          return fmtPrice(num(v), h === undefined || h === "" ? null : Number(h));
        }));
    }
    return undefined;
  } catch (e) {
    if (cmd !== "filter") return `Error: ${redact(e.message)}`;
    return JSON.stringify({ items: [info("Something went wrong", oneLine(redact(e.message), 200), "error")] }, wellFormed);
  }
}
