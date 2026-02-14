# Messaging Service

Production messaging platform with a Node.js API, Supabase-backed auth/data, and static web clients.

## What was improved

This repository now includes a broader hardening pass across backend and client layers:

- API security headers, safer error exposure, request throttling, and stricter input validation.
- Better startup/shutdown behavior for server reliability in managed runtimes.
- Service worker cache strategy updated to avoid caching authenticated API requests.
- Offline fallback page and tighter PWA manifest defaults.
- Stronger client-side validation and safer form behavior on login/signup pages.

## Runtime

- Node.js `>=18`
- Supabase project + anon key

## Environment variables

The API supports both `SUPABASE_KEY` and `SUPABASE_ANON_KEY` (for deployment compatibility).

Required/used keys:

- `PORT`
- `NODE_ENV`
- `CLIENT_ORIGIN` (comma-separated list supported)
- `SUPABASE_URL`
- `SUPABASE_KEY` or `SUPABASE_ANON_KEY`
- `RENDER_EXTERNAL_URL` / `RENDER_EXTERNAL_HOSTNAME` / `PUBLIC_BASE_URL` (optional keep-alive source)

## Run locally

```bash
npm install
npm start
```

Then open:

- `http://localhost:3000/login.html`
- `http://localhost:3000/message.html`

## Security notes

- Do not replace live credentials in this repo unless coordinated with deployment.
- Keep Supabase RLS policies strict; this API relies on Supabase auth + table permissions.
- Prefer setting secrets via deployment environment variables over source defaults.

## Deployment

Render config is included in `render.yaml`.


## Keep-alive behavior

- The API pings `${baseUrl}/health` every 14 minutes to reduce free-tier sleeping.
- `baseUrl` is resolved in this order: `RENDER_EXTERNAL_URL`, `PUBLIC_BASE_URL`, `RENDER_EXTERNAL_HOSTNAME` (as `https://...`), then `https://messaging-app.onrender.com`.
