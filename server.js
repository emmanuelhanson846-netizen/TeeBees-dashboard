/* TeeBees local server — v3
   - Sign up / log in with Google, Instagram or TikTok (cookie sessions)
   - Every TeeBees user owns their own tracked social accounts (up to 8)
   - Polls the official APIs and streams live updates to each signed-in user (SSE)
   No dependencies: requires Node 18+ (built-in fetch). Data lives in data/store.json. */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/* ───────────── config ───────────── */
(function loadEnv() {
  const f = path.join(__dirname, ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined)
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

const PORT = +process.env.PORT || 5173;
const BASE = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const SECURE = BASE.startsWith("https://");
const POLL_MS = Math.max(60, +process.env.POLL_SECONDS || 120) * 1000;
const INSIGHTS_MS = 15 * 60 * 1000;
const MAX_ACCOUNTS = 8; // one fixed, colour-blind-safe chart colour per account
const SESSION_DAYS = 30;
const GOOGLE = { id: process.env.GOOGLE_CLIENT_ID || "", secret: process.env.GOOGLE_CLIENT_SECRET || "" };
const IG = {
  id: process.env.INSTAGRAM_APP_ID || "", secret: process.env.INSTAGRAM_APP_SECRET || "",
  envToken: process.env.INSTAGRAM_ACCESS_TOKEN || "", graph: "https://graph.instagram.com",
  scopes: "instagram_business_basic,instagram_business_manage_insights",
};
const TT = { key: process.env.TIKTOK_CLIENT_KEY || "", secret: process.env.TIKTOK_CLIENT_SECRET || "", scopes: "user.info.basic,user.info.profile,user.info.stats,video.list" };
const providers = () => ({ google: !!(GOOGLE.id && GOOGLE.secret), instagram: !!(IG.id && IG.secret), tiktok: !!(TT.key && TT.secret) });

/* ───────────── store ───────────── */
const DATA_DIR = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");
fs.mkdirSync(DATA_DIR, { recursive: true });
let store = { version: 3, users: {}, sessions: {}, accounts: {} };
try {
  const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  if (raw.version === 3) store = raw;
  else if (raw.tokens) {
    // migrate v2 (single owner) → accounts claimed by the first user who signs up
    for (const pf of ["instagram", "tiktok"]) {
      if (!raw.tokens[pf]) continue;
      const L = raw.latest?.[pf];
      const ext = pf === "instagram" ? L?.profile?.user_id || raw.tokens[pf].user_id : raw.tokens[pf].open_id;
      const id = newId("acc");
      store.accounts[id] = { id, owner: null, platform: pf, externalId: String(ext || id), token: raw.tokens[pf], latest: L, history: raw.history?.[pf] || {}, activity: (raw.activity || []).filter((a) => a.pf === pf), addedAt: Date.now() };
    }
  }
} catch (_) {}
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 1)), 200);
}
function newId(prefix) { return prefix + "_" + crypto.randomBytes(6).toString("hex"); }
const dayKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
const hist = (acc, day) => (acc.history[day] ||= {});
const userAccounts = (u) => (u?.accounts || []).map((id) => store.accounts[id]).filter(Boolean);

/* ───────────── users & sessions ───────────── */
function createUser({ name, email, avatar, provider, externalId }) {
  const u = { id: newId("usr"), name: name || "Creator", email: email || null, avatar: avatar || null, providers: { [provider]: externalId }, accounts: [], createdAt: Date.now(), lastLogin: provider };
  store.users[u.id] = u;
  // claim accounts migrated from an older single-user version
  for (const a of Object.values(store.accounts)) if (!a.owner && u.accounts.length < MAX_ACCOUNTS) { a.owner = u.id; u.accounts.push(a.id); }
  return u;
}
const findUser = (fn) => Object.values(store.users).find(fn);
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
}
function currentUser(req) {
  const sid = parseCookies(req).tb_sid;
  const s = sid && store.sessions[sid];
  if (!s || s.expires < Date.now()) return null;
  return store.users[s.userId] || null;
}
function sessionCookie(userId) {
  const sid = crypto.randomBytes(32).toString("hex");
  store.sessions[sid] = { userId, expires: Date.now() + SESSION_DAYS * 864e5 };
  save();
  return `tb_sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${SECURE ? "; Secure" : ""}`;
}
const clearCookie = `tb_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE ? "; Secure" : ""}`;
function purgeSessions() { for (const [k, s] of Object.entries(store.sessions)) if (s.expires < Date.now()) delete store.sessions[k]; }

/* ───────────── HTTP helpers ───────────── */
async function getJSON(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch (_) { body = { raw: text }; }
  if (!res.ok || body.error_message || (body.error && body.error.code && body.error.code !== "ok") || (body.error && typeof body.error === "string")) {
    const msg = body.error_message || body.error_description || body.error?.message || body.error || `HTTP ${res.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return body;
}
const form = (o) => new URLSearchParams(o).toString();
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function readBody(req, limit = 10240) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (d) => { b += d; if (b.length > limit) { reject(new Error("Body too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(new Error("Invalid JSON")); } });
  });
}

/* ───────────── Instagram ───────────── */
async function igRefreshIfNeeded(acc) {
  const t = acc.token;
  const age = Date.now() - (t.refreshed_at || 0);
  const expSoon = t.expires_at && t.expires_at - Date.now() < 10 * 864e5;
  if ((expSoon || !t.expires_at) && age > 864e5) {
    try {
      const r = await getJSON(`${IG.graph}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(t.access_token)}`);
      Object.assign(t, { access_token: r.access_token, expires_at: Date.now() + r.expires_in * 1000, refreshed_at: Date.now() });
    } catch (_) { t.refreshed_at = Date.now(); }
  }
}
async function igMediaInsights(id, tok) {
  for (const metric of ["reach,saved,shares,views", "reach,saved", "reach"]) {
    try {
      const r = await getJSON(`${IG.graph}/${id}/insights?metric=${metric}&access_token=${tok}`);
      const out = {};
      for (const m of r.data || []) out[m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? 0;
      return out;
    } catch (_) {}
  }
  return {};
}
async function igProfile(token) {
  return getJSON(`${IG.graph}/me?fields=user_id,username,name,profile_picture_url,followers_count,follows_count,media_count&access_token=${encodeURIComponent(token)}`);
}
async function syncInstagram(acc, withInsights) {
  await igRefreshIfNeeded(acc);
  const tok = encodeURIComponent(acc.token.access_token);
  const profile = await igProfile(acc.token.access_token);
  const fields = "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url";
  const media = [];
  let url = `${IG.graph}/me/media?fields=${fields}&limit=50&access_token=${tok}`;
  for (let page = 0; url && page < 2; page++) { const r = await getJSON(url); media.push(...(r.data || [])); url = r.paging?.next; }
  const prev = acc.latest;
  const prevIns = Object.fromEntries((prev?.media || []).map((m) => [m.id, m.insights || {}]));
  for (const m of media) m.insights = prevIns[m.id] || {};
  if (withInsights) {
    for (const m of media.slice(0, 12)) m.insights = await igMediaInsights(m.id, tok);
    const until = Math.floor(Date.now() / 1000), since = until - 29 * 86400;
    for (const metric of ["reach", "follower_count"]) {
      try {
        const r = await getJSON(`${IG.graph}/me/insights?metric=${metric}&period=day&since=${since}&until=${until}&access_token=${tok}`);
        for (const v of r.data?.[0]?.values || []) hist(acc, dayKey(new Date(v.end_time).getTime() - 3600e3))[metric === "reach" ? "reach" : "follows"] = v.value;
      } catch (_) {}
    }
  }
  hist(acc, dayKey(Date.now())).followers = profile.followers_count;
  const next = { profile, media, syncedAt: Date.now() };
  diffActivity(acc, prev, next);
  acc.latest = next;
  acc.username = profile.username;
  acc.avatar = profile.profile_picture_url;
}

/* ───────────── TikTok ───────────── */
async function ttToken(params) {
  const r = await getJSON("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ client_key: TT.key, client_secret: TT.secret, ...params }),
  });
  return { access_token: r.access_token, refresh_token: r.refresh_token, open_id: r.open_id, expires_at: Date.now() + r.expires_in * 1000, refresh_expires_at: Date.now() + r.refresh_expires_in * 1000 };
}
async function ttProfile(accessToken) {
  const u = await getJSON("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url,username,follower_count,following_count,likes_count,video_count", { headers: { Authorization: `Bearer ${accessToken}` } });
  return u.data.user;
}
async function syncTikTok(acc) {
  if (acc.token.expires_at - Date.now() < 5 * 60e3) acc.token = await ttToken({ grant_type: "refresh_token", refresh_token: acc.token.refresh_token });
  const auth = { Authorization: `Bearer ${acc.token.access_token}` };
  const profile = await ttProfile(acc.token.access_token);
  const fields = "id,title,video_description,create_time,cover_image_url,share_url,view_count,like_count,comment_count,share_count";
  const videos = [];
  let cursor, more = true;
  for (let page = 0; more && page < 5; page++) {
    const r = await getJSON(`https://open.tiktokapis.com/v2/video/list/?fields=${fields}`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(cursor ? { max_count: 20, cursor } : { max_count: 20 }),
    });
    videos.push(...(r.data?.videos || []));
    cursor = r.data?.cursor; more = r.data?.has_more;
  }
  const h = hist(acc, dayKey(Date.now()));
  h.followers = profile.follower_count;
  h.totalViews = videos.reduce((a, v) => a + (v.view_count || 0), 0);
  const prev = acc.latest;
  const next = { profile, videos, syncedAt: Date.now() };
  diffActivity(acc, prev, next);
  acc.latest = next;
  acc.username = profile.username || profile.display_name;
  acc.avatar = profile.avatar_url;
}

/* ───────────── posts + activity ───────────── */
const PF = {
  instagram: { name: "Instagram", short: "IG" },
  tiktok: { name: "TikTok", short: "TT" },
};
function posts(acc, data = acc.latest) {
  if (!data) return [];
  if (acc.platform === "instagram")
    return data.media.map((m) => ({
      id: m.id, title: (m.caption || "").split("\n")[0].slice(0, 90) || `Untitled ${m.media_type.toLowerCase()}`,
      type: m.media_product_type === "REELS" ? "Reel" : m.media_type === "CAROUSEL_ALBUM" ? "Carousel" : m.media_product_type === "STORY" ? "Story" : "Post",
      ts: new Date(m.timestamp).getTime(), url: m.permalink,
      views: m.insights?.views ?? m.insights?.reach ?? null, likes: m.like_count || 0, comments: m.comments_count || 0, shares: m.insights?.shares || 0, saves: m.insights?.saved || 0,
    }));
  return data.videos.map((v) => ({
    id: v.id, title: (v.title || v.video_description || "Untitled video").split("\n")[0].slice(0, 90), type: "Video",
    ts: v.create_time * 1000, url: v.share_url, views: v.view_count || 0, likes: v.like_count || 0, comments: v.comment_count || 0, shares: v.share_count || 0, saves: 0,
  }));
}
const nf = new Intl.NumberFormat("en");
const pending = new Map(); // userId -> new activity items since last broadcast
function logActivity(acc, ico, text) {
  const item = { ico, text, acc: acc.id, t: Date.now() };
  acc.activity = [item, ...(acc.activity || [])].slice(0, 100);
  if (acc.owner) { if (!pending.has(acc.owner)) pending.set(acc.owner, []); pending.get(acc.owner).push(item); }
}
function diffActivity(acc, prev, next) {
  const who = `${PF[acc.platform].name} @${escHtml(next.profile.username || next.profile.display_name || "you")}`;
  if (!prev) return logActivity(acc, "🔌", `Now tracking <b>${who}</b>`);
  const fOld = prev.profile.followers_count ?? prev.profile.follower_count;
  const fNew = next.profile.followers_count ?? next.profile.follower_count;
  if (fNew > fOld) logActivity(acc, "🐝", `+${nf.format(fNew - fOld)} new follower${fNew - fOld > 1 ? "s" : ""} on ${who}`);
  if (fNew < fOld) logActivity(acc, "🍂", `${nf.format(fOld - fNew)} unfollow${fOld - fNew > 1 ? "s" : ""} on ${who}`);
  const old = Object.fromEntries(posts(acc, prev).map((p) => [p.id, p]));
  const now = posts(acc, next);
  for (const p of now) {
    const o = old[p.id], t = `<b>${escHtml(p.title.slice(0, 50))}</b>`;
    if (!o) { logActivity(acc, "🚀", `New ${p.type.toLowerCase()} on ${who}: ${t}`); continue; }
    const bits = [];
    if (p.likes > o.likes) bits.push(`+${nf.format(p.likes - o.likes)} likes`);
    if (p.comments > o.comments) bits.push(`+${nf.format(p.comments - o.comments)} comments`);
    if (p.shares > o.shares) bits.push(`+${nf.format(p.shares - o.shares)} shares`);
    if (p.views != null && o.views != null && p.views - o.views >= 50) bits.push(`+${nf.format(p.views - o.views)} views`);
    if (bits.length) logActivity(acc, p.comments > o.comments ? "💬" : "💛", `${bits.join(", ")} on ${t}`);
  }
  for (const id in old) if (!now.some((p) => p.id === id)) logActivity(acc, "🗑️", `A post on ${who} was removed or archived`);
}

/* ───────────── per-user dashboard payload ───────────── */
function accountInfo(acc, i) {
  return { id: acc.id, platform: acc.platform, platformName: PF[acc.platform].name, username: acc.username || null, avatar: acc.avatar || null,
    color: `var(--series-${i + 1})`, syncedAt: acc.latest?.syncedAt || null, error: acc.error || null, addedAt: acc.addedAt };
}
function statusFor(user) {
  return {
    user: user && { id: user.id, name: user.name, email: user.email, avatar: user.avatar, lastLogin: user.lastLogin, providers: Object.keys(user.providers) },
    accounts: userAccounts(user).map(accountInfo),
    providers: providers(), envInstagramToken: !!IG.envToken, maxAccounts: MAX_ACCOUNTS, pollSeconds: POLL_MS / 1000,
  };
}
function buildDashboard(user) {
  const DAYS = 180;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dates = Array.from({ length: DAYS }, (_, i) => { const d = new Date(today); d.setDate(d.getDate() - (DAYS - 1 - i)); return d; });
  const keys = dates.map(dayKey);
  const daily = {}, platforms = [], works = [], activity = [];
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  userAccounts(user).forEach((acc, idx) => {
    activity.push(...(acc.activity || []));
    if (!acc.latest) return;
    const ps = posts(acc);
    works.push(...ps.map((p) => ({ ...p, id: `${acc.id}_${p.id}`, platform: acc.id, status: "live", date: dayKey(p.ts), source: "api" })));
    const byDay = {};
    for (const p of ps) {
      const k = dayKey(p.ts), e = p.likes + p.comments + p.shares + p.saves;
      (byDay[k] ||= { eng: 0, views: 0 });
      byDay[k].eng += e; byDay[k].views += p.views || 0;
      const d = new Date(p.ts); heat[d.getDay()][d.getHours()] += e;
    }
    const H = acc.history;
    daily[acc.id] = keys.map((k, i) => {
      const h = H[k] || {}, ph = H[keys[i - 1]] || {};
      const delta = (f) => (h[f] != null && ph[f] != null ? Math.max(0, h[f] - ph[f]) : null);
      const reach = acc.platform === "instagram" ? h.reach ?? byDay[k]?.views ?? 0 : delta("totalViews") ?? byDay[k]?.views ?? 0;
      const follows = (acc.platform === "instagram" ? h.follows : null) ?? delta("followers") ?? 0;
      return { reach, engagements: byDay[k]?.eng || 0, follows, posted: byDay[k] ? 1 : 0 };
    });
    platforms.push({
      id: acc.id, platform: acc.platform, name: `${PF[acc.platform].short} @${acc.username}`, short: PF[acc.platform].short,
      color: `var(--series-${idx + 1})`, followers: acc.latest.profile.followers_count ?? acc.latest.profile.follower_count,
      username: acc.username, avatar: acc.avatar, syncedAt: acc.latest.syncedAt,
      base: Math.max(1, Math.round(ps.reduce((a, p) => a + (p.views || 0), 0) / Math.max(1, ps.length))),
    });
  });
  activity.sort((a, b) => b.t - a.t);
  return { live: platforms.length > 0, platforms, dates: dates.map((d) => d.toISOString()), daily, heat, works, activity: activity.slice(0, 40), status: statusFor(user) };
}

/* ───────────── sync loop + SSE ───────────── */
const clients = new Map(); // res -> userId
function pushTo(userId, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [res, uid] of clients) if (uid === userId) res.write(msg);
}
function broadcastUser(userId) {
  const u = store.users[userId];
  if (!u) return;
  pushTo(userId, "dashboard", buildDashboard(u));
  const items = pending.get(userId);
  if (items?.length) { pushTo(userId, "activity", items); pending.delete(userId); }
}
async function syncAccount(acc, withInsights) {
  try {
    if (acc.platform === "instagram") await syncInstagram(acc, withInsights);
    else await syncTikTok(acc);
    delete acc.error;
  } catch (e) { acc.error = e.message; console.error(`[${acc.platform} ${acc.username || acc.id}]`, e.message); }
}
let lastInsights = 0, syncing = false;
async function syncAll(force, onlyUser) {
  if (syncing) return;
  syncing = true;
  const withInsights = force || Date.now() - lastInsights > INSIGHTS_MS;
  if (withInsights && !onlyUser) lastInsights = Date.now();
  const list = Object.values(store.accounts).filter((a) => a.owner && a.token && (!onlyUser || a.owner === onlyUser));
  for (const acc of list) await syncAccount(acc, withInsights);
  const cutoff = dayKey(Date.now() - 370 * 864e5);
  for (const a of list) for (const k in a.history) if (k < cutoff) delete a.history[k];
  purgeSessions();
  save();
  syncing = false;
  for (const uid of new Set(clients.values())) broadcastUser(uid);
}
setInterval(syncAll, POLL_MS);
setInterval(() => { for (const res of clients.keys()) res.write(`event: ping\ndata: ${Date.now()}\n\n`); }, 25000);

/* ───────────── linking social accounts to users ───────────── */
function upsertAccount(user, platform, externalId, token) {
  let acc = Object.values(store.accounts).find((a) => a.platform === platform && a.externalId === String(externalId));
  if (acc && acc.owner && acc.owner !== user.id) throw new Error(`This ${PF[platform].name} account is already linked to another TeeBees user.`);
  if (!acc) {
    if (user.accounts.length >= MAX_ACCOUNTS) throw new Error(`You can track up to ${MAX_ACCOUNTS} accounts. Remove one first.`);
    acc = { id: newId("acc"), platform, externalId: String(externalId), history: {}, activity: [], addedAt: Date.now() };
    store.accounts[acc.id] = acc;
  }
  acc.owner = user.id;
  acc.token = token;
  delete acc.error;
  if (!user.accounts.includes(acc.id)) user.accounts.push(acc.id);
  // let this social account be used to sign in, unless another user already signs in with it
  if (!findUser((u) => u.id !== user.id && u.providers[platform] === String(externalId))) user.providers[platform] = String(externalId);
  save();
  return acc;
}
/* Shared end of every social OAuth callback: either sign in / sign up, or add the account to the signed-in user. */
async function finishSocial(res, st, platform, externalId, token, profile) {
  externalId = String(externalId);
  if (st.intent === "connect") {
    const user = store.users[st.userId];
    if (!user) return redirect(res, "/login.html?error=" + encodeURIComponent("Please sign in again."));
    try { await syncAccount(upsertAccount(user, platform, externalId, token), true); }
    catch (e) { return redirect(res, "/?error=" + encodeURIComponent(e.message) + "#accounts"); }
    save(); broadcastUser(user.id);
    return redirect(res, `/?added=${platform}#accounts`);
  }
  let user = findUser((u) => u.providers[platform] === externalId);
  const isNew = !user;
  if (!user) user = createUser({ name: profile.name, avatar: profile.avatar, provider: platform, externalId });
  user.lastLogin = platform;
  try { await syncAccount(upsertAccount(user, platform, externalId, token), true); }
  catch (e) { console.error(e.message); }
  return redirect(res, isNew ? "/?welcome=1" : "/", sessionCookie(user.id));
}

/* ───────────── HTTP server ───────────── */
const oauthStates = new Map();
function newState(data) {
  for (const [k, v] of oauthStates) if (Date.now() - v.t > 10 * 60e3) oauthStates.delete(k);
  const s = crypto.randomBytes(16).toString("hex");
  oauthStates.set(s, { ...data, t: Date.now() });
  return s;
}
function takeState(s) { const v = oauthStates.get(s); oauthStates.delete(s); return v && Date.now() - v.t < 10 * 60e3 ? v : null; }

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const PUBLIC = new Set(["index.html", "login.html", "css", "js", "assets"]);
function send(res, code, body, type = "application/json", headers = {}) {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
function redirect(res, to, cookie) {
  const h = { Location: to, "Cache-Control": "no-store" };
  if (cookie) h["Set-Cookie"] = cookie;
  res.writeHead(302, h); res.end();
}
const authFail = (res, msg) => redirect(res, "/login.html?error=" + encodeURIComponent(msg));
const intentOf = (url) => (url.searchParams.get("intent") === "connect" ? "connect" : "login");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  if (!["localhost", "127.0.0.1", "[::1]", new URL(BASE).hostname].includes(host)) return send(res, 403, { error: "Forbidden host" });
  const p = url.pathname;
  const user = currentUser(req);

  try {
    /* ── public API ── */
    if (p === "/api/auth/providers") return send(res, 200, providers());
    if (p === "/api/me") return user ? send(res, 200, statusFor(user)) : send(res, 401, { error: "Not signed in", providers: providers() });

    /* ── signed-in API ── */
    if (p.startsWith("/api/")) {
      if (!user) return send(res, 401, { error: "Not signed in" });
      if (p === "/api/dashboard") return send(res, 200, buildDashboard(user));
      if (p === "/api/stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        res.write(`event: dashboard\ndata: ${JSON.stringify(buildDashboard(user))}\n\n`);
        clients.set(res, user.id);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (req.method !== "POST" || req.headers["x-teebees"] !== "1") return send(res, 403, { error: "Forbidden" });
      if (p === "/api/logout") {
        const sid = parseCookies(req).tb_sid;
        delete store.sessions[sid]; save();
        return send(res, 200, { ok: true }, "application/json", { "Set-Cookie": clearCookie });
      }
      if (p === "/api/sync") { await syncAll(true, user.id); return send(res, 200, statusFor(user)); }
      if (p === "/api/accounts/instagram-token") {
        const body = await readBody(req);
        const token = (body.useEnv ? IG.envToken : body.token || "").trim();
        if (!token) return send(res, 400, { error: "Paste an Instagram access token first." });
        let prof;
        try { prof = await igProfile(token); } catch (e) { return send(res, 400, { error: "Instagram rejected that token: " + e.message }); }
        try {
          const acc = upsertAccount(user, "instagram", prof.user_id || prof.id, { access_token: token, refreshed_at: Date.now() });
          await syncAccount(acc, true); save(); broadcastUser(user.id);
          return send(res, 200, statusFor(user));
        } catch (e) { return send(res, 400, { error: e.message }); }
      }
      const rm = p.match(/^\/api\/accounts\/(acc_[a-f0-9]+)\/remove$/);
      if (rm) {
        const acc = store.accounts[rm[1]];
        if (!acc || acc.owner !== user.id) return send(res, 404, { error: "Account not found" });
        delete store.accounts[acc.id];
        user.accounts = user.accounts.filter((id) => id !== acc.id);
        save(); broadcastUser(user.id);
        return send(res, 200, statusFor(user));
      }
      return send(res, 404, { error: "Unknown endpoint" });
    }

    /* ── Google sign-in (OpenID Connect) ── */
    if (p === "/auth/google") {
      if (!providers().google) return authFail(res, "Google sign-in isn't set up yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env (see README).");
      const state = newState({ provider: "google", intent: "login" });
      return redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(GOOGLE.id)}&redirect_uri=${encodeURIComponent(BASE + "/auth/google/callback")}&response_type=code&scope=${encodeURIComponent("openid email profile")}&prompt=select_account&state=${state}`);
    }
    if (p === "/auth/google/callback") {
      const st = takeState(url.searchParams.get("state"));
      if (!st) return authFail(res, "Sign-in expired. Please try again.");
      if (url.searchParams.get("error")) return authFail(res, "Google sign-in was cancelled.");
      const tok = await getJSON("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form({ code: url.searchParams.get("code"), client_id: GOOGLE.id, client_secret: GOOGLE.secret, redirect_uri: BASE + "/auth/google/callback", grant_type: "authorization_code" }),
      });
      const info = await getJSON("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tok.access_token}` } });
      if (!info.sub) return authFail(res, "Google didn't return an account id.");
      let u = findUser((x) => x.providers.google === info.sub);
      const isNew = !u;
      if (!u) u = createUser({ name: info.name || info.email, email: info.email, avatar: info.picture, provider: "google", externalId: info.sub });
      Object.assign(u, { lastLogin: "google", email: info.email || u.email, avatar: u.avatar || info.picture });
      save();
      return redirect(res, isNew ? "/?welcome=1" : "/", sessionCookie(u.id));
    }

    /* ── Instagram: sign in / sign up, or add account ── */
    if (p === "/auth/instagram") {
      const intent = intentOf(url);
      if (intent === "connect" && !user) return authFail(res, "Please sign in first.");
      if (!providers().instagram) {
        const msg = "Instagram login isn't set up yet. Add INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET to .env (see README).";
        return intent === "connect" ? redirect(res, "/?error=" + encodeURIComponent(msg) + "#accounts") : authFail(res, msg);
      }
      const state = newState({ provider: "instagram", intent, userId: user?.id });
      return redirect(res, `https://www.instagram.com/oauth/authorize?enable_fb_login=0&force_authentication=1&client_id=${IG.id}&redirect_uri=${encodeURIComponent(BASE + "/auth/instagram/callback")}&response_type=code&scope=${IG.scopes}&state=${state}`);
    }
    if (p === "/auth/instagram/callback") {
      const st = takeState(url.searchParams.get("state"));
      if (!st) return authFail(res, "Sign-in expired. Please try again.");
      if (url.searchParams.get("error")) return st.intent === "connect" ? redirect(res, "/#accounts") : authFail(res, "Instagram sign-in was cancelled.");
      const code = (url.searchParams.get("code") || "").replace(/#_$/, "");
      let short = await getJSON("https://api.instagram.com/oauth/access_token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form({ client_id: IG.id, client_secret: IG.secret, grant_type: "authorization_code", redirect_uri: BASE + "/auth/instagram/callback", code }),
      });
      if (Array.isArray(short.data)) short = short.data[0];
      const long = await getJSON(`${IG.graph}/access_token?grant_type=ig_exchange_token&client_secret=${IG.secret}&access_token=${encodeURIComponent(short.access_token)}`);
      const token = { access_token: long.access_token, expires_at: Date.now() + long.expires_in * 1000, refreshed_at: Date.now() };
      const prof = await igProfile(token.access_token);
      return finishSocial(res, st, "instagram", prof.user_id || short.user_id, token, { name: prof.name || prof.username, avatar: prof.profile_picture_url });
    }

    /* ── TikTok: sign in / sign up, or add account ── */
    if (p === "/auth/tiktok") {
      const intent = intentOf(url);
      if (intent === "connect" && !user) return authFail(res, "Please sign in first.");
      if (!providers().tiktok) {
        const msg = "TikTok login isn't set up yet. Add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET to .env (see README).";
        return intent === "connect" ? redirect(res, "/?error=" + encodeURIComponent(msg) + "#accounts") : authFail(res, msg);
      }
      const state = newState({ provider: "tiktok", intent, userId: user?.id });
      return redirect(res, `https://www.tiktok.com/v2/auth/authorize/?client_key=${TT.key}&scope=${TT.scopes}&response_type=code&redirect_uri=${encodeURIComponent(BASE + "/auth/tiktok/callback")}&state=${state}`);
    }
    if (p === "/auth/tiktok/callback") {
      const st = takeState(url.searchParams.get("state"));
      if (!st) return authFail(res, "Sign-in expired. Please try again.");
      if (url.searchParams.get("error")) return st.intent === "connect" ? redirect(res, "/#accounts") : authFail(res, "TikTok sign-in was cancelled.");
      const token = await ttToken({ code: url.searchParams.get("code"), grant_type: "authorization_code", redirect_uri: BASE + "/auth/tiktok/callback" });
      const prof = await ttProfile(token.access_token);
      return finishSocial(res, st, "tiktok", token.open_id, token, { name: prof.display_name || prof.username, avatar: prof.avatar_url });
    }

    /* ── pages ── */
    if ((p === "/" || p === "/index.html") && !user && !url.searchParams.has("demo")) return redirect(res, "/login.html");
    if (p === "/login.html" && user) return redirect(res, "/");

    /* ── static files (public folders only; resolved path is checked so "..\" tricks can't escape) ── */
    const rel = p === "/" ? "index.html" : decodeURIComponent(p).replace(/^\/+/, "");
    const file = path.resolve(__dirname, rel);
    const inside = path.relative(__dirname, file);
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside) || !PUBLIC.has(inside.split(path.sep)[0]))
      return send(res, 404, "Not found", "text/plain");
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, "Not found", "text/plain");
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
      res.end(buf);
    });
  } catch (e) {
    console.error(e);
    if (p.startsWith("/auth/")) return authFail(res, "Something went wrong: " + e.message);
    send(res, 500, { error: e.message });
  }
});

// Only reachable from this computer — your tokens are never exposed to your network.
server.listen(PORT, "127.0.0.1", () => {
  const pv = providers();
  console.log(`\n🐝 TeeBees running at http://localhost:${PORT}`);
  console.log(`   Sign-in options: Google ${pv.google ? "✓" : "✗"}  Instagram ${pv.instagram ? "✓" : "✗"}  TikTok ${pv.tiktok ? "✓" : "✗"}   (✗ = add keys to .env)`);
  console.log(`   ${Object.keys(store.users).length} user(s), ${Object.keys(store.accounts).length} tracked account(s). Polling every ${POLL_MS / 1000}s\n`);
  syncAll(true);
});
http.createServer((req, res) => server.emit("request", req, res)).listen(PORT, "::1").on("error", () => {});
