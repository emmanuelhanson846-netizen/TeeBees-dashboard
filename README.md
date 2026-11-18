# 🐝 TeeBees — The Creator Hive

A live social-media analytics dashboard that pulls a creator's **Instagram** and
**TikTok** performance into one place. New followers, likes, comments, shares,
views and fresh posts stream into **The Buzz** feed automatically, with charts
that update without a page reload.

Built as a single, self-contained web app: a **zero-dependency Node server** and
a **vanilla HTML / CSS / JavaScript** front-end — no frameworks, no build step,
no chart library.

---

## 📸 Preview

> Opens in **demo mode** with sample data — no account or API keys required.

**Light**

![TeeBees dashboard — light mode](screenshots/dashboard-light.jpg)

**Dark**

![TeeBees dashboard — dark mode](screenshots/dashboard-dark.jpg)

---

## ✨ Highlights (for the UI/front-end side)

- **Dependency-free charts.** Line charts, sparklines, horizontal bars, a heatmap
  and gauges are all hand-built with the Canvas/SVG primitives in
  `js/charts.js` — no Chart.js, no D3.
- **Light / Dark / Auto theming.** A single `data-theme` attribute drives the
  whole palette via CSS custom properties, applied before first paint so there's
  no flash. *Auto* follows the device setting.
- **Responsive layout** that holds up from wide desktop down to mobile.
- **Live updates** without reloads — the server polls the platforms and the
  front-end re-renders only what changed.
- **Graceful demo mode** — with no accounts connected (or opened as a static
  site), the exact same UI renders from seeded sample data.
- **A content pipeline board** (Ideas → Drafting → Scheduled → Live) saved per
  signed-in user in `localStorage`.

## 🧱 Tech

| Layer | What it uses |
|---|---|
| Server | Node 18+ (standard library only — **no npm dependencies**) |
| Front-end | Vanilla HTML, CSS, JavaScript (no framework, no bundler) |
| Charts | Custom, dependency-free (`js/charts.js`) |
| Auth | OAuth with Instagram & TikTok; optional Google sign-in |
| Storage | Local `data/store.json` on the user's own machine |

---

## 🚀 Run it

### Demo only (no keys needed)

```bash
npm start
```
Open **http://localhost:5173**, then click **"Just looking? Explore the demo →"**.
The dashboard loads with sample data.

### Full app (your real accounts)

1. Copy `.env.example` to `.env` and add your keys (see **Connecting accounts**).
2. `npm start`
3. Sign up with Google, Instagram or TikTok and connect your accounts.

> `.env` and `data/` hold your private keys and tokens and are **git-ignored** —
> they never leave your machine.

---

## 🌐 Deploy the public demo (static, no backend)

Because the UI renders sample data on its own, the **demo** can be hosted as a
plain static site on Netlify, Vercel or GitHub Pages — **without** `server.js`,
`.env` or `data/`.

1. Deploy these only: `index.html`, `login.html`, `css/`, `js/`.
2. Link straight to the dashboard with the demo flag: `https://<your-host>/?demo=1`
   (the sign-up buttons show *"setup needed"* since there's no backend — expected
   for a demo).

The full, account-connected app is designed to run **locally** on the creator's
own computer, which keeps their tokens private.

---

## 🔌 Connecting accounts (full app)

### Instagram
**Requirement:** a **Professional** Instagram account (Creator or Business) —
*Settings → Account type and tools → Switch to professional account*.

1. Create an app at https://developers.facebook.com/apps
   (use case: **"Manage messaging & content on Instagram"**).
2. Open **Instagram → API setup with Instagram login**.
3. Under **Roles → Roles**, add your account as an **Instagram Tester**, then
   accept the invite in the Instagram app.
4. Either paste a token into `.env` (`INSTAGRAM_ACCESS_TOKEN=IGAA…`), **or** add
   `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` and use the dashboard's **Connect**
   button (redirect URL `http://localhost:5173/auth/instagram/callback`).
5. `npm start`.

### TikTok
1. At https://developers.tiktok.com, **Manage apps → Connect an app**.
2. Add **Login Kit** and **Display API**.
3. Enable scopes: `user.info.basic`, `user.info.profile`, `user.info.stats`,
   `video.list`.
4. Add a **Sandbox** with your own account as a target user (no review needed).
5. Redirect URI: `http://localhost:5173/auth/tiktok/callback`.
6. Put `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` in `.env`, then **Connect**.

> If a platform refuses `http://localhost`, tunnel it:
> `npx cloudflared tunnel --url http://localhost:5173`, then set `PUBLIC_URL`
> and the redirect URLs to the `https://….trycloudflare.com` address.

---

## ⏱️ How "real-time" works

- Every **2 minutes** (`POLL_SECONDS` in `.env`) the server checks profiles,
  posts, follower counts, likes, comments, shares and views; anything new lands
  in **The Buzz** and the charts update live.
- Heavier Instagram insights (reach, saves, shares, views) refresh every 15 min
  to stay inside rate limits.
- Instagram returns ~30 days of history; TikTok daily views and follower growth
  are tracked from the day you connect and fill in over time.

**What no app can show** (platform API limits): who liked/viewed a post, DMs,
story viewers, TikTok profile views, or activity on accounts you don't own.

---

## 🗂️ Project structure

```
server.js           local server: logins, polling, live updates (no dependencies)
index.html          dashboard shell
login.html          sign-in / demo entry
css/styles.css      light & dark themes
js/data.js          demo data
js/charts.js        dependency-free charts
js/app.js           dashboard logic (demo + live modes)
screenshots/        preview images (this README)
.env                your keys (git-ignored, never commit)
data/               your tokens + history (git-ignored, auto-created)
```

## 🔒 Privacy

- Tokens live only on the user's PC in `data/store.json`.
- The server accepts connections only from the local machine.
- `.env` and `data/` are git-ignored — never share them.

---

*Built by Toro-Obong Emmanuel Hanson — UI Developer & Designer.*
