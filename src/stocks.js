#!/usr/bin/osascript -l JavaScript
// Stocks for Alfred — quotes, search and a watchlist without dependencies.
// Usage: osascript -l JavaScript stocks.js <filter|refresh|act> [args…]
//   filter <query>      Script Filter JSON (watchlist when the query is empty)
//   refresh <symbols…>  background quote refresh (spawned by filter)
//   act <arg>           run the action chosen in Alfred ($stocks_action)
ObjC.import("Foundation");
ObjC.import("AppKit");
ObjC.bindFunction("setsid", ["int", []]);

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
const LOCK_TTL = 30; // a refresh lock older than this is considered dead
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
    return v && typeof v === "object" ? v : fallback;
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

// Start a detached process (stdout/stderr to /dev/null so Alfred doesn't wait for it).
function spawn(path, args) {
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath(path);
  task.arguments = args;
  const nul = $.NSFileHandle.fileHandleWithNullDevice;
  task.standardInput = nul;
  task.standardOutput = nul;
  task.standardError = nul;
  return task.launchAndReturnError($());
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
function httpMany(reqs) {
  if (!reqs.length) return [];
  // Alfred kills a running Script Filter when the query changes: remove what such runs left behind
  const t = Date.now() / 1000;
  for (const f of listDir(cacheDir())) if (f.startsWith("tmp-") && t - mtime(`${cacheDir()}/${f}`) > 120) FM.removeItemAtPathError(`${cacheDir()}/${f}`, $());
  const dir = mkdirs(`${cacheDir()}/tmp-${$.NSUUID.UUID.UUIDString.js}`);
  const lines = ["parallel", "parallel-max = 8"];
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
    this.kind = kind; // auth | rate | network | server | parse | nokey
    this.status = status || 0;
  }
}

// Throw for transport/HTTP failures, parse the JSON body otherwise.
function parseBody(p, r, { notFoundOk = false } = {}) {
  if (r.status === 0) {
    const why = { 6: "can’t find the server", 7: "can’t connect", 28: "timed out", 35: "secure connection failed", 60: "certificate problem" }[r.exit];
    throw new ProviderError("network", why || `network error (${redact(r.error) || "curl " + r.exit})`);
  }
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
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
}

// ---------- market state ----------

// US equity sessions in New York time (holidays aren't known: they show as regular).
function usState(t) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" })
    .formatToParts(new Date(t * 1000))) parts[p.type] = p.value;
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return "CLOSED";
  const m = Number(parts.hour) * 60 + Number(parts.minute);
  return m >= 240 && m < 570 ? "PRE" : m >= 570 && m < 960 ? "REGULAR" : m >= 960 && m < 1200 ? "POST" : "CLOSED";
}
function looksUS(sym) {
  return /^[A-Z]{1,5}([.\-][A-Z])?$/.test(sym);
}

// State of a cached quote at time t (computed at display time, so a cached quote doesn't lie).
function stateOf(q, t) {
  if (q.periods) {
    const inside = (p) => p && t >= p.start && t < p.end;
    return inside(q.periods.regular) ? "REGULAR" : inside(q.periods.pre) ? "PRE" : inside(q.periods.post) ? "POST" : "CLOSED";
  }
  if (q.usHours) {
    // the provider's open/closed flag only holds for the session it was fetched in (it catches holidays)
    const live = usState(t);
    return live === "REGULAR" && q.open === false && usState(q.fetched) === "REGULAR" && t - q.fetched < 8 * 3600 ? "CLOSED" : live;
  }
  return q.state || null;
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
      return { url: `${this.base()}/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m`, ua: YAHOO_UA };
    },
    parseQuote(sym, v) {
      const c = v.chart;
      if (!c || typeof c !== "object") throw new ProviderError("parse", "unexpected quote response");
      if (c.error) {
        if (/not found|delisted/i.test(`${c.error.code} ${c.error.description}`)) return null;
        throw new ProviderError("server", str(c.error.description) || "quote error");
      }
      const r = Array.isArray(c.result) ? c.result[0] : null;
      if (!r || !r.meta) return null;
      const m = r.meta;
      const price = num(m.regularMarketPrice);
      if (price === null) return null;
      const q0 = (((r.indicators || {}).quote || [])[0] || {});
      const series = (Array.isArray(q0.close) ? q0.close : []).map(num).filter((x) => x !== null);
      const p = m.currentTradingPeriod;
      const period = (x) => (x && num(x.start) !== null && num(x.end) !== null ? { start: num(x.start), end: num(x.end) } : null);
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
    base: () => env("STOCKS_FINNHUB_URL", "https://finnhub.io/api/v1"),
    searchReq(q, key) {
      return { url: `${this.base()}/search?q=${encodeURIComponent(q)}`, headers: { "X-Finnhub-Token": key } };
    },
    parseSearch(v) {
      if (v.error) throw new ProviderError("auth", redact(str(v.error)) || "API error");
      if (!Array.isArray(v.result)) throw new ProviderError("parse", "unexpected search response");
      return v.result
        .filter((x) => x && typeof x.symbol === "string")
        .map((x) => ({ symbol: x.symbol.toUpperCase(), name: name(x.description), exchange: "", type: str(x.type) }));
    },
    quoteReq(sym, key) {
      return { url: `${this.base()}/quote?symbol=${encodeURIComponent(sym)}`, headers: { "X-Finnhub-Token": key } };
    },
    parseQuote(sym, v) {
      if (v.error) throw new ProviderError(/limit/i.test(v.error) ? "rate" : "auth", redact(str(v.error)));
      const price = num(v.c);
      // unknown symbols come back as all zeros with null change
      if (price === null || (price === 0 && !num(v.t) && num(v.d) === null)) return null;
      const us = looksUS(sym);
      return {
        symbol: sym, name: "", price, prev: num(v.pc), change: num(v.d), pct: num(v.dp), low: num(v.l), high: num(v.h),
        currency: us ? "USD" : "", exchange: "", type: "", time: num(v.t), usHours: us,
      };
    },
  },

  alphavantage: {
    id: "alphavantage",
    name: "Alpha Vantage",
    needsKey: true,
    keyURL: "https://www.alphavantage.co/support/#api-key",
    searchQuotes: 1, // free plan: 25 calls/day
    base: () => env("STOCKS_ALPHAVANTAGE_URL", "https://www.alphavantage.co"),
    // Alpha Vantage only accepts the key as a query parameter; the URL goes to curl on stdin
    searchReq(q, key) {
      return { url: `${this.base()}/query?function=SYMBOL_SEARCH&keywords=${encodeURIComponent(q)}&apikey=${encodeURIComponent(key)}` };
    },
    check(v) {
      // errors and rate limits arrive as HTTP 200 with a message
      const msg = str(v.Note) || str(v.Information);
      if (msg) throw new ProviderError(/api key|apikey/i.test(msg) && !/rate|limit|frequency|per day/i.test(msg) ? "auth" : "rate", /rate|limit|frequency|per day/i.test(msg) ? "rate limit reached (25 requests a day on the free plan)" : "API key rejected");
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
        low: num(g["04. low"]), high: num(g["03. high"]), currency: us ? "USD" : "", exchange: "", type: "", usHours: us,
      };
    },
  },

  twelvedata: {
    id: "twelvedata",
    name: "Twelve Data",
    needsKey: true,
    keyURL: "https://twelvedata.com/pricing",
    searchQuotes: 4, // free plan: 8 credits/minute
    base: () => env("STOCKS_TWELVEDATA_URL", "https://api.twelvedata.com"),
    searchReq(q, key) {
      return { url: `${this.base()}/symbol_search?symbol=${encodeURIComponent(q)}&outputsize=10`, headers: { Authorization: `apikey ${key}` } };
    },
    check(v) {
      if (v.status === "error") {
        const code = num(v.code);
        if (code === 401 || code === 403) throw new ProviderError("auth", "API key rejected");
        if (code === 429) throw new ProviderError("rate", "rate limit reached (8 requests a minute on the free plan)");
        if (code === 404 || code === 400) return "notfound";
        throw new ProviderError("server", redact(str(v.message)).slice(0, 80) || "API error");
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
      };
      if (us) Object.assign(q, { usHours: true, open: v.is_market_open === true ? true : v.is_market_open === false ? false : undefined });
      else if (typeof v.is_market_open === "boolean") q.state = v.is_market_open ? "REGULAR" : "CLOSED";
      return q;
    },
  },
};

function provider() {
  return PROVIDERS[env("provider", "yahoo")] || PROVIDERS.yahoo;
}

// ---------- keychain ----------

const SECURITY = env("STOCKS_SECURITY", "/usr/bin/security"); // test suite only: a fake that doesn't touch your keychains

function getKey(p) {
  const r = exec(SECURITY, ["find-generic-password", "-s", BUNDLE, "-a", p.id, "-w"]);
  return r.status === 0 ? r.stdout.replace(/\n$/, "") : "";
}
function setKey(p, key) {
  return exec(SECURITY, ["add-generic-password", "-U", "-s", BUNDLE, "-a", p.id, "-l", `${p.name} API key (Alfred Stocks)`, "-w", key]).status === 0;
}
function deleteKey(p) {
  return exec(SECURITY, ["delete-generic-password", "-s", BUNDLE, "-a", p.id]).status === 0;
}
function validKey(k) {
  return /^[A-Za-z0-9._\-]{8,128}$/.test(k);
}

// ---------- formatting ----------

function systemLocale() {
  const id = $.NSLocale.currentLocale.localeIdentifier.js; // e.g. "de_CH" or "en_US@rg=dezzzz"
  return id.split("@")[0].replace(/_/g, "-");
}

const LOCALE = (() => {
  for (const cand of [env("number_locale", "").trim(), systemLocale(), "en-US"]) {
    if (!cand) continue;
    try {
      if (Intl.NumberFormat.supportedLocalesOf([cand]).length) return cand;
    } catch (e) {
      /* invalid tag */
    }
  }
  return "en-US";
})();

const NF = {};
function nf(min, max, grouping = true) {
  const k = `${min}/${max}/${grouping}`;
  return NF[k] || (NF[k] = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: grouping }));
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
  return nf(d.min, d.max, grouping).format(v);
}

function signed(s, v) {
  return v > 0 ? "+" + s : s;
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
  return signed(nf(d.min, d.max).format(v), v);
}

function fmtPct(v) {
  if (v === null || !Number.isFinite(v)) return "—";
  return signed(nf(2, 2).format(v), v) + "%";
}

function fmtTime(t, ref) {
  const opts = ref - t > 20 * 3600 ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } : { hour: "numeric", minute: "2-digit" };
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
const sparkDir = () => mkdirs(`${cacheDir()}/spark`);

// {SYMBOL: entry}; entries from another provider are ignored
function loadQuotes() {
  const all = readJSON(quotesPath(), {});
  const p = provider().id, out = {};
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
  const s = stateOf(e, t);
  return s === "CLOSED" ? CLOSED_TTL : OPEN_TTL;
}
function fresh(e, t) {
  // a timestamp from the future (the clock was changed) doesn't keep a quote fresh forever
  return !!e && e.fetched <= t + 60 && t - e.fetched < ttl(e, t);
}

function setStatus(err) {
  writeFile(statusPath(), JSON.stringify(err ? { provider: provider().id, at: now(), kind: err.kind, message: redact(err.message), status: err.status } : { provider: provider().id, at: now(), ok: true }));
}
function lastError() {
  const s = readJSON(statusPath(), {});
  return s.provider === provider().id && !s.ok && s.message ? s : null;
}

function refreshRunning() {
  const l = readJSON(lockPath(), null);
  return !!l && now() - (l.started || 0) < LOCK_TTL && Date.now() / 1000 - mtime(lockPath()) < LOCK_TTL;
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

// Fetch quotes for symbols; returns {entries, error}. Entries are cached (with sparklines).
function fetchQuotes(symbols, names = {}) {
  const p = provider();
  const key = p.needsKey ? KEY || (KEY = getKey(p)) : "";
  if (p.needsKey && !key) return { entries: {}, error: new ProviderError("nokey", "no API key") };
  const resps = httpMany(symbols.map((s) => p.quoteReq(s, key)));
  const t = now(), old = loadQuotes(), entries = {};
  let error = null;
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
      error = error || e;
    }
  });
  saveQuotes(entries);
  pruneSparklines(entries);
  setStatus(error); // a successful fetch (search or refresh) clears the watchlist's error row
  return { entries, error };
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
  const hit = cache[k];
  if (hit && Array.isArray(hit.results) && now() - hit.at < (hit.results.length ? SEARCH_TTL : EMPTY_SEARCH_TTL) && hit.at <= now() + 60) return hit.results;
  const key = p.needsKey ? KEY || (KEY = getKey(p)) : "";
  let results = p.parseSearch(parseBody(p, httpMany([p.searchReq(q, key)])[0]));
  const plain = q.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (!results.length && plain !== q) results = p.parseSearch(parseBody(p, httpMany([p.searchReq(plain, key)])[0]));
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

function saveWatchlist(symbols) {
  const path = watchlistPath();
  if (exists(path) && loadWatchlist().damaged) // keep a backup of an unreadable file
    FM.copyItemAtPathToPathError(path, `${path}.damaged-${Math.round(Date.now() / 1000)}`, $());
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
  return Object.assign({ title, subtitle, arg, variables: { stocks_action: action }, icon: icon(iconName), mods: { cmd: off, alt: off, ctrl: off } }, extra);
}

function errorItem(err, p) {
  const hints = {
    auth: p.needsKey ? "↩ Set a new API key" : "The provider blocked the request. ↩ Pick another provider in the Workflow’s Configuration",
    rate: "Wait a little, or ↩ pick another provider in the Workflow’s Configuration",
    network: "Check your internet connection",
    nokey: "↩ Set your API key",
  };
  const sub = hints[err.kind] || "The service may have changed or be down. ↩ Pick another provider in the Workflow’s Configuration";
  const title = `${p.name}: ${redact(err.message)}${err.status && !/\d{3}/.test(err.message) ? ` (HTTP ${err.status})` : ""}`;
  if ((err.kind === "auth" && p.needsKey) || err.kind === "nokey")
    return info(title, sub, "error", { valid: false, autocomplete: ":key " });
  if (err.kind === "network") return info(title, sub, "error");
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
  if (state) parts.push(STATE_LABEL[state]);
  if (t - q.fetched > ttl(q, t) * 3) parts.push(`as of ${fmtTime(q.fetched, t)}`);
  const url = siteURL(q.symbol, q);
  const plain = fmtPrice(q.price, q.hint, false);
  const iconPath = q.spark && enabled("sparklines", true) && exists(q.spark) ? { path: q.spark } : icon(change === null || change === 0 ? "flat" : change > 0 ? "up" : "down");
  const title = `${q.symbol}   ${price}${cur}   ${arrow}${fmtChange(change, q.price, q.hint)} (${fmtPct(pct)})`;
  const item = {
    title,
    subtitle: parts.join(" · "),
    arg: url,
    autocomplete: q.symbol,
    quicklookurl: /^https:/.test(url) ? url : `https://finance.yahoo.com/quote/${encodeURIComponent(q.symbol)}/`,
    variables: { stocks_action: "open" },
    icon: iconPath,
    text: { copy: plain, largetype: `${q.symbol}  ${price}${cur}\n${arrow}${fmtChange(change, q.price, q.hint)} (${fmtPct(pct)})` },
    mods: {
      cmd: { arg: plain, valid: true, subtitle: `Copy the price: ${plain}` },
      alt: {
        arg: q.symbol,
        valid: true,
        subtitle: inWatchlist ? `Remove ${q.symbol} from the watchlist` : `Add ${q.symbol} to the watchlist`,
        variables: { stocks_action: "toggle", stocks_reopen: watchMode ? "1" : "0" },
      },
    },
  };
  if (watchMode) item.mods.ctrl = { arg: q.symbol, valid: true, subtitle: `Move ${q.symbol} to the top of the watchlist`, variables: { stocks_action: "top", stocks_reopen: "1" } };
  return item;
}

// a symbol without a quote (not loaded yet, not quoted by a keyed plan, or unknown)
function plainItem(sym, meta, inWatchlist, watchMode, subtitle) {
  const url = siteURL(sym, null);
  const item = {
    title: meta && meta.name ? `${sym}   ${oneLine(meta.name, 60)}` : sym,
    subtitle: subtitle || [meta && meta.exchange, meta && meta.type].filter(Boolean).join(" · ") || `Open in ${siteName()}`,
    arg: url,
    autocomplete: sym,
    variables: { stocks_action: "open" },
    icon: icon("flat"),
    mods: {
      cmd: { arg: sym, valid: true, subtitle: `Copy ${sym}` },
      alt: {
        arg: sym,
        valid: true,
        subtitle: inWatchlist ? `Remove ${sym} from the watchlist` : `Add ${sym} to the watchlist`,
        variables: { stocks_action: "toggle", stocks_reopen: watchMode ? "1" : "0" },
      },
    },
  };
  if (watchMode) item.mods.ctrl = { arg: sym, valid: true, subtitle: `Move ${sym} to the top of the watchlist`, variables: { stocks_action: "top", stocks_reopen: "1" } };
  return item;
}

function startRefresh(symbols) {
  if (env("STOCKS_SYNC", "0") === "1") {
    // test suite only: refresh in-process
    fetchQuotes(symbols);
    return false;
  }
  writeFile(lockPath(), JSON.stringify({ started: now(), symbols }));
  const script = `${FM.currentDirectoryPath.js}/stocks.js`;
  if (!spawn("/usr/bin/osascript", ["-l", "JavaScript", script, "refresh", ...symbols])) {
    removeFile(lockPath());
    return false;
  }
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
  const stale = wl.symbols.filter((s) => !fresh(quotes[s], t));
  let running = refreshRunning();
  const err0 = lastError();
  // after a failure, wait before trying again: with rerun this would otherwise hammer a rate-limited API
  const backoff = err0 && t - err0.at >= 0 && t - err0.at < RETRY_AFTER;
  if (stale.length && !running && !backoff) {
    running = startRefresh(stale);
    quotes = loadQuotes();
  }
  const err = lastError();
  if (err && !running) items.push(errorItem(err, p));
  for (const s of wl.symbols) {
    const q = quotes[s];
    if (q && !q.missing) items.push(quoteItem(q, t, true, true));
    else if (q && q.missing) items.push(plainItem(s, null, true, true, `No data from ${p.name}: unknown or delisted symbol`));
    else items.push(plainItem(s, null, true, true, running ? "Loading…" : "No quote yet"));
  }
  return running ? { items, rerun: 0.5 } : { items };
}

function searchItems(query) {
  const p = provider(), t = now();
  const wl = new Set(loadWatchlist().symbols);
  const typed = query.trim().toUpperCase();
  const typedIsSymbol = !/\s/.test(typed) && typed.length <= 15 && SYMBOL_RE.test(typed);
  let results, error = null;
  try {
    results = search(query.trim());
  } catch (e) {
    if (!(e instanceof ProviderError)) e = new ProviderError("parse", "unexpected response");
    error = e;
    results = [];
  }
  const meta = {};
  for (const r of results) meta[r.symbol] = r;
  const symbols = results.map((r) => r.symbol);
  // An exact ticker goes first. One the search doesn't know is still tried: first when typed in
  // capitals ("TWTR"), last when it's probably a name ("tesco"), so it doesn't use up a keyed plan's
  // few quotes (Alpha Vantage quotes one result per search)
  const q0 = query.trim();
  if (typedIsSymbol && meta[typed]) symbols.splice(0, symbols.length, typed, ...symbols.filter((s) => s !== typed));
  else if (typedIsSymbol && q0 === q0.toUpperCase()) symbols.unshift(typed);
  else if (typedIsSymbol) symbols.push(typed);
  const wanted = symbols.slice(0, p.searchQuotes);
  let quotes = loadQuotes();
  const stale = wanted.filter((s) => !fresh(quotes[s], t));
  if (stale.length && !error) {
    const names = {};
    for (const s of stale) if (meta[s] && meta[s].name) names[s] = meta[s].name;
    const res = fetchQuotes(stale, names);
    error = res.error;
    quotes = loadQuotes();
  }
  const items = [];
  if (error) items.push(errorItem(error, p));
  for (const s of symbols) {
    const q = quotes[s];
    if (q && !q.missing) items.push(quoteItem(q, t, wl.has(s), false));
    else if (q && q.missing) {
      if (meta[s]) items.push(plainItem(s, meta[s], wl.has(s), false, "No quote available"));
    } else if (meta[s]) items.push(plainItem(s, meta[s], wl.has(s), false, [meta[s].exchange, meta[s].type, "⇥ to load the quote"].filter(Boolean).join(" · ")));
  }
  if (!items.length) {
    if (typedIsSymbol && quotes[typed] && quotes[typed].missing)
      items.push(info(`No data for ${typed}`, `${p.name} has no quote for this symbol: it may be delisted or misspelt`, "search"));
    else items.push(info(`No results for “${oneLine(query, 40)}”`, "Try a ticker such as AAPL, BTC-USD or EURUSD=X", "search"));
  }
  return { items };
}

function settingsItems(query) {
  const p = provider();
  const [cmd, ...rest] = query.slice(1).split(/\s+/);
  const argText = rest.join(" ").trim();
  if (cmd === "key" && p.needsKey) {
    if (argText) {
      if (!validKey(argText)) return { items: [info("That doesn’t look like an API key", "Paste the key exactly as shown on the provider’s site", "error")] };
      const shown = argText.length > 10 ? `${argText.slice(0, 4)}…${argText.slice(-4)}` : "…";
      return { items: [actionItem(`Save ${p.name} API key ${shown}`, "↩ Store it in your macOS Keychain", "savekey", argText, "key")] };
    }
    const items = [
      info(`Paste your ${p.name} API key after “:key ”`, "It is stored in your macOS Keychain, never in the workflow’s files", "key"),
      actionItem(`Get a free ${p.name} API key`, p.keyURL, "open", p.keyURL, "search"),
    ];
    if (getKey(p)) items.push(actionItem(`Remove the saved ${p.name} API key`, "↩ Delete it from the Keychain", "delkey", p.id, "error"));
    return { items };
  }
  const all = [
    p.needsKey ? info(":key  Set API key", `Save your ${p.name} API key in the Keychain`, "key", { autocomplete: ":key " }) : null,
    actionItem(":reset  Reset the watchlist", `↩ Replace it with ${defaultWatchlist().join(", ")} (a backup is kept)`, "reset", "reset", "watch", { autocomplete: ":reset" }),
    actionItem(":cache  Clear cached quotes", "↩ Fetch everything again", "clearcache", "clearcache", "refresh", { autocomplete: ":cache" }),
    actionItem(":config  Open the Workflow’s Configuration", `Provider: ${p.name}${p.id === "yahoo" ? " (unofficial API, no key)" : ""} · Opens in ${siteName()}`, "config", "config", "settings", { autocomplete: ":config" }),
  ].filter(Boolean);
  const matches = all.filter((i) => i.title.slice(1).startsWith(cmd || ""));
  return { items: matches.length ? matches : all };
}

function filter(query) {
  const p = provider();
  const q = query.replace(/[\r\n\t]+/g, " ").trim();
  if (q.startsWith(":")) return settingsItems(q);
  if (p.needsKey && !(KEY = getKey(p))) {
    return {
      items: [
        info(`Set your ${p.name} API key`, "⇥ then paste the key · or pick Yahoo Finance (no key) in the Workflow’s Configuration", "key", { autocomplete: ":key " }),
        actionItem(`Get a free ${p.name} API key`, p.keyURL, "open", p.keyURL, "search"),
      ],
    };
  }
  return q === "" ? watchlistItems() : searchItems(q);
}

function refresh(symbols) {
  $.setsid(); // leave Alfred's process group so a new keystroke doesn't kill the refresh
  writeFile(lockPath(), JSON.stringify({ started: now(), symbols, pid: $.NSProcessInfo.processInfo.processIdentifier }));
  try {
    fetchQuotes(cleanSymbols(symbols));
  } finally {
    removeFile(lockPath());
  }
  return "";
}

// ---------- actions ----------

function reopen() {
  const kw = env("keyword_stock", "stock");
  exec("/usr/bin/osascript", ["-e", "on run argv", "-e", 'tell application id "com.runningwithcrayons.Alfred" to search (item 1 of argv)', "-e", "end run", `${kw} `]);
}

function act(arg) {
  const action = env("stocks_action", "open");
  const p = provider();
  const test = env("STOCKS_TEST_NOOPEN", "0") === "1"; // test suite only: don't launch apps
  switch (action) {
    case "open":
      const url = /^(https:\/\/|stocks:\/\/)/.test(arg) ? $.NSURL.URLWithString(arg) : null;
      if (!url || url.isNil()) return "";
      if (!test) $.NSWorkspace.sharedWorkspace.openURL(url);
      return test ? `open ${arg}` : "";
    case "toggle":
    case "top": {
      const sym = arg.trim().toUpperCase();
      if (!SYMBOL_RE.test(sym)) return "Not a valid symbol";
      const list = loadWatchlist().symbols;
      let msg, next;
      if (action === "top") {
        next = [sym, ...list.filter((s) => s !== sym)];
        msg = `Moved ${sym} to the top of the watchlist`;
      } else if (list.includes(sym)) {
        next = list.filter((s) => s !== sym);
        msg = `Removed ${sym} from the watchlist`;
      } else if (list.length >= MAX_WATCHLIST) {
        return `The watchlist is full (${MAX_WATCHLIST} symbols)`;
      } else {
        next = [...list, sym];
        msg = `Added ${sym} to the watchlist`;
      }
      if (!saveWatchlist(next)) return "Could not save the watchlist";
      if (env("stocks_reopen", "0") === "1" && !test) reopen();
      return msg;
    }
    case "restore":
      return saveWatchlist(arg === "-" ? [] : arg.split(/\s+/)) ? "Watchlist repaired" : "Could not save the watchlist";
    case "reset": {
      if (exists(watchlistPath())) FM.copyItemAtPathToPathError(watchlistPath(), `${watchlistPath()}.backup-${Math.round(Date.now() / 1000)}`, $());
      return saveWatchlist(defaultWatchlist()) ? "Watchlist reset" : "Could not save the watchlist";
    }
    case "clearcache":
      for (const f of [quotesPath(), searchPath(), statusPath()]) removeFile(f);
      FM.removeItemAtPathError(`${cacheDir()}/spark`, $());
      return "Cleared cached quotes";
    case "savekey":
      if (!p.needsKey || !validKey(arg)) return "Not saved: invalid API key";
      if (!setKey(p, arg)) return "Could not save the key to the Keychain";
      removeFile(statusPath());
      return `Saved the ${p.name} API key`;
    case "delkey":
      return deleteKey(p) ? `Removed the ${p.name} API key` : "No API key to remove";
    case "config":
      if (!test) exec("/usr/bin/osascript", ["-e", "on run argv", "-e", 'tell application id "com.runningwithcrayons.Alfred" to reveal workflow (item 1 of argv)', "-e", "end run", BUNDLE]);
      return test ? "config" : "";
  }
  return "";
}

function run(argv) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "filter":
        return JSON.stringify(Object.assign({ skipknowledge: true }, filter(rest.join(" "))));
      case "refresh":
        return refresh(rest);
      case "act":
        return act(rest.join(" "));
      case "fmt": // formatting check used by the test suite: fmt <price[,hint]>…
        return JSON.stringify(rest.map((x) => {
          const [v, h] = x.split(",");
          return fmtPrice(num(v), h === undefined || h === "" ? null : Number(h));
        }));
    }
    return "";
  } catch (e) {
    if (cmd !== "filter") return `Error: ${redact(e.message)}`;
    return JSON.stringify({ items: [info("Something went wrong", redact(e.message), "error")] });
  }
}
