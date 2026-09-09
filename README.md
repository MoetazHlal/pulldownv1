# pulldown

A small site for downloading YouTube videos and Instagram reels: pick a
platform, paste a link, choose a quality, download the file. Dark mode
toggle top right.

## Read this before deploying

Cloudflare Workers is an edge JavaScript runtime — it has no filesystem, no
`ffmpeg`, and no way to run tools like `yt-dlp`. On top of that, YouTube
actively blocks requests from datacenter IP ranges (which is what every
cloud platform, including Cloudflare, uses) and requires a bot-verification
token that only a real, persistent backend can generate.

So **this repo is two things**:

1. **The website** (this Worker + the `public/` frontend) — fully built,
   ready to deploy, dark mode and all.
2. **A thin proxy layer** that calls out to a separate extraction backend
   you point it at. That backend does the actual work of resolving a
   YouTube/Instagram link into a downloadable file.

The extraction backend of choice is **[cobalt](https://github.com/imputnet/cobalt)**,
the standard open-source tool for this (39k+ GitHub stars, MIT licensed).
The public `cobalt.tools` instance no longer works for YouTube because
YouTube blocked it — so you'll self-host your own small instance. It takes
about five minutes.

## 1. Deploy the cobalt backend

### Option A — Render, free ($0/month)

Render's free tier needs no credit card and supports Docker deploys:

1. Go to [render.com](https://render.com) → **New → Web Service** → **Deploy an existing image**.
2. Image: `ghcr.io/imputnet/cobalt:11`
3. Port: `9000`
4. Add an environment variable `API_URL` set to the `.onrender.com` URL Render
   assigns you, with a trailing slash (e.g. `https://pulldown-cobalt.onrender.com/`).
   You'll need to create the service once to see the URL, then edit the env
   var and redeploy.
5. Optionally add `API_AUTH_REQUIRED=1` and `API_KEYS=<a-random-uuid-you-pick>`
   to require a key — recommended once this is public, so strangers can't run
   bandwidth through your instance for free.
6. Deploy.

Caveat: free services sleep after 15 minutes of no traffic and take
30–60 seconds to wake on the next request. Every request after that is
normal speed. Fine for personal use; not for something you expect steady
traffic on.

### Option B — Railway ($5/month, no sleep)

- **[Deploy Cobalt API on Railway](https://railway.com/deploy/cobalt-media-downloader)**

No cold starts, but Railway no longer has a meaningful free tier — budget
~$5/month.

### Option C — your own server / VPS / always-free cloud VM

Run the official Docker image anywhere that isn't a serverless/edge platform:

```bash
docker run -d -p 9000:9000 \
  -e API_URL=https://your-domain-or-ip:9000/ \
  ghcr.io/imputnet/cobalt:11
```

If you want $0/month with no cold starts, Oracle Cloud's Always Free tier
and Google Cloud's Always Free `e2-micro` VM both give you a small
permanently-free instance capable of running this — more setup than
Render, but no sleep and no time limit.

---

Whichever option you pick, note down:
- its base URL (e.g. `https://pulldown-cobalt.onrender.com`)
- if you turned on auth, its API key

Keep authentication turned on once this is reachable from the public
internet — otherwise anyone can run bandwidth through your instance.

## 2. Point the Worker at it

```bash
npm install -g wrangler   # if you don't have it
cd pulldown
npx wrangler secret put COBALT_API_URL
# paste your cobalt instance URL when prompted, e.g.
# https://your-app.up.railway.app

# only if your instance has auth enabled:
npx wrangler secret put COBALT_API_KEY
```

## 3. Deploy the site

```bash
npx wrangler deploy
```

Wrangler will print your `*.workers.dev` URL. Open it — you should see the
site. If `COBALT_API_URL` isn't set, the app will tell you so in the status
line instead of failing silently.

## How it works

```
browser  →  Worker (/api/meta)      →  YouTube oEmbed (title/thumbnail)
browser  →  Worker (/api/download)  →  cobalt backend (resolves a file URL)
browser  →  Worker (/api/stream)    →  proxies the actual bytes, sets a
                                        proper filename for the download
```

- `/api/meta` fetches a title/thumbnail preview. YouTube's public oEmbed
  endpoint provides this directly. Instagram no longer exposes oEmbed
  without a Meta app token, so Instagram links show a generic preview
  instead of a real thumbnail.
- `/api/download` asks the cobalt backend to resolve the link at the
  requested quality. YouTube requests carry your chosen resolution;
  Instagram requests just ask for the best available file, since reels
  don't expose selectable resolutions the way YouTube does.
- If a link resolves to multiple files (e.g. an Instagram carousel post),
  the API returns a "picker" list and the UI lets you choose which one to
  download.
- `/api/stream` proxies the resolved file through your Worker so the
  browser gets a clean download with the right filename, rather than
  redirecting to the backend's own URL.

## A note on quality selection

cobalt resolves a video to the quality you request — it doesn't expose a
"here are the exact 6 resolutions available for this specific video" list
up front. The quality dropdown offers cobalt's standard set (144p through
4K, plus audio-only MP3); if your exact pick isn't available for a given
video, cobalt falls back to the closest one it has.

## Use responsibly

Only download content you have the rights to use, and check the terms of
service for YouTube and Instagram before downloading from them. This tool
doesn't bypass paywalls or private accounts — it only reaches content
already viewable in a browser.

## Project structure

```
wrangler.toml       Worker + static assets config
src/index.js         API routes (/api/meta, /api/download, /api/stream)
public/index.html    Page markup
public/styles.css    Theme tokens, light/dark mode, layout
public/app.js        Platform switching, fetch/download flow
```
