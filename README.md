# WAZAMBI messaging

Team messaging for crews on the move: one-to-one and group chats, voice and
video calls, photos, files and voice notes, and a live team map. It runs in
any modern browser and installs to the home screen as an app.

## What's in it

| | |
|---|---|
| **Chats** | Real-time messages with sent / delivered / read ticks, typing indicators, replies (swipe right on phones), emoji reactions, links, unread counts, search, and drafts that survive a reload. Messages typed while offline are queued and sent on reconnect. |
| **Groups** | Create groups, add and remove members (admins), rename, mute, leave. Sender names on messages. |
| **Media** | Photos (shrunk on the phone before upload), videos, documents up to 50 MB, voice notes up to 5 minutes. Drag and drop or paste images on desktop. Files live in a private storage bucket and are shown through short-lived signed links. |
| **Calls** | One-to-one voice and video calls over WebRTC: ringing, accept/decline, busy and missed detection, mute, camera on/off, front/back camera, connection-quality warning, minimise to keep chatting, and a call history tab. A ring reaches a phone four ways (live change, inbox nudge, Web Push with Answer/Decline buttons, and a check whenever the app wakes), and both sides re-read the call from the database every 2 s while it rings, so a decline or hang-up is never missed. Call times come from the server clock. |
| **Companies** | Each company is a private workspace with roles (owner, admin, dispatcher, driver), invite links (`/join/CODE`) and saved places. |
| **Jobs** | Every delivery is a thread: status track, timeline, notes and photos, customer messages, geofence arrivals, a sealed proof of delivery (photo, signature, GPS, SHA-256 hash chain) with a printable PDF (`/proof?job=…`), and a public tracking link for the customer (`/t/<token>`, no account needed). |
| **Team map** | Opt-in live location sharing (only while the app is open), teammates on a map, battery level, street or satellite view, weather. |
| **Account** | Password, magic-link or Google sign-in; profile photo, bio and work details; followers; theme (system, light, dark); notification and sound settings; change password; recent sign-ins; sign out of other devices. |

## How it fits together

```
Browser (public/)                      Render (server.js)             Supabase
─────────────────                      ──────────────────             ────────
index.html  sign in / sign up   ──►  static files, brotli/gzip,      Auth
app.html    the app                   security headers (CSP),        Postgres + row-level security
js/app/*    ES modules, no build      /config.js runtime config,     Realtime (messages, calls, typing, presence)
sw.js       offline shell             /api/weather proxy             Storage (chat_media private, avatars public)
                │                                                         ▲
                └──────────── reads / writes directly, protected by RLS ──┘
                └──────────── WebRTC audio/video peer-to-peer (STUN/TURN)
```

* The **server has no runtime dependencies** (Node built-ins only), so it starts
  instantly on Render. It serves `public/`, the browser builds of
  `@supabase/supabase-js` and `leaflet` from `node_modules`, and keeps the
  weather API key off the client.
* **Security lives in the database.** Every table has row-level security: you
  can only read messages you sent, received or that belong to a group you're
  in; recipients can only change read/delivery fields; call rows are visible
  to the two participants only. The migrations are in `supabase/migrations/`.
* **Fast start:** the chat list paints from the last session's cache before
  the network answers, one database call (`get_chat_list`) returns every
  conversation with its last message and unread count, and the map library is
  only downloaded when you open the Map tab.

```
public/
  index.html, app.html, sw.js, manifest.webmanifest
  css/       base.css (design tokens), auth.css, app.css
  js/lib/    supabase client, DOM + formatting helpers, icons
  js/app/    main (boot), state, data (all queries), realtime, router,
             chatList, conversation, media, voice, calls, groups,
             profile, settings, map, notify, ui
supabase/migrations/   database changes applied for this version
test/                  fake Supabase + browser walkthrough (see below)
```

## Running locally

```bash
npm install
cp .env.example .env     # optional: weather key, TURN relay
npm run dev              # http://localhost:3000
npm run check            # syntax + import checks for every browser module
```

## Configuration (Render → Environment)

| Variable | Needed | What it does |
|---|---|---|
| `SUPABASE_URL` | yes | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | yes | The project's anon (public) key |
| `OPENWEATHER_API_KEY` | no | Turns on the weather card on the map |
| `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | recommended | A TURN relay so calls connect on strict mobile and office networks (e.g. Metered, Twilio, Cloudflare Calls) |

In Supabase → Authentication → URL configuration, set the **Site URL** to your
Render URL and add `https://<your-app>.onrender.com/app` to **Redirect URLs**
(needed for magic links, password resets and Google sign-in). To turn on
Google sign-in, enable the Google provider under Authentication → Providers.

## Testing

`test/` contains an in-memory stand-in for Supabase (database rules,
realtime, storage) and a Playwright walkthrough that signs two people in and
exercises messaging, reactions, replies, photos, files, voice notes, the
offline outbox, groups, a real WebRTC video call, declined calls, the map,
settings and profiles. `test/e2e_calls_jobs.py` freezes or drops one
device's live connection and checks that calls still ring and stop on both
sides, then runs a job from creation to proof of delivery and the customer
tracking page.

```bash
pip install playwright && playwright install chromium
test/run-local.sh                                  # main walkthrough
TEST=test/e2e_calls_jobs.py test/run-local.sh      # calls across devices + jobs
TEST=test/e2e_fixes.py test/run-local.sh           # microphone + password reset
node --experimental-strip-types test/unit/webpush.test.mjs
```

## License

MIT, see [LICENSE](LICENSE).
