// pulldown — Worker entry point
//
// Routes:
//   GET  /api/meta        ?url=<video url>&platform=youtube|instagram   -> title/thumbnail preview
//   POST /api/download    { url, platform, quality }                    -> resolves a direct file
//   GET  /api/stream      ?u=<resolved url>&name=<filename>              -> proxies the actual bytes
//   *    everything else                                                -> static assets (public/)
//
// All extraction work happens on a separate cobalt-compatible backend
// configured via COBALT_API_URL / COBALT_API_KEY. See README.md.

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function detectPlatform(url) {
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  if (host.includes("youtube.com") || host.includes("youtu.be")) return "youtube";
  if (host.includes("instagram.com")) return "instagram";
  return null;
}

async function handleMeta(request, env) {
  const url = new URL(request.url).searchParams.get("url") || "";
  if (!isHttpUrl(url)) return json({ error: "Enter a valid link." }, 400);

  const platform = detectPlatform(url);
  if (!platform) return json({ error: "That link doesn't look like YouTube or Instagram." }, 400);

  if (platform === "youtube") {
    try {
      const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
      const res = await fetch(oembed);
      if (!res.ok) throw new Error("oembed failed");
      const data = await res.json();
      return json({
        platform,
        title: data.title || "YouTube video",
        author: data.author_name || null,
        thumbnail: data.thumbnail_url || null,
      });
    } catch {
      return json({ platform, title: "YouTube video", author: null, thumbnail: null });
    }
  }

  // Instagram's oEmbed endpoint now requires an authenticated Meta app token,
  // so we can't reliably fetch a title/thumbnail for reels without one.
  // We degrade gracefully to a generic preview rather than pretending to know
  // details we don't have.
  return json({ platform, title: "Instagram reel", author: null, thumbnail: null });
}

async function resolveWithCobalt(env, { url, quality }) {
  const base = env.COBALT_API_URL;
  if (!base) {
    return { error: "not_configured" };
  }

  const body = {
    url,
    downloadMode: quality === "audio" ? "audio" : "auto",
    audioFormat: "mp3",
  };
  if (quality && quality !== "audio" && quality !== "best") {
    body.videoQuality = quality;
  }

  const headers = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (env.COBALT_API_KEY) {
    headers["authorization"] = `Api-Key ${env.COBALT_API_KEY}`;
  }

  let res;
  try {
    res = await fetch(base.replace(/\/+$/, "") + "/", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch {
    return { error: "backend_unreachable" };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { error: "backend_bad_response" };
  }

  if (data.status === "error") {
    const rawCode = data.error?.code || "";
    // cobalt codes look like "error.api.content.video.unavailable" — strip the
    // common "error.api." prefix so our lookup table can match on the
    // meaningful part.
    const code = rawCode.replace(/^error\.api\./, "");
    return { error: data.text || code || "extraction_failed" };
  }

  if (data.status === "picker" && Array.isArray(data.picker)) {
    return {
      picker: data.picker.map((item, i) => ({
        type: item.type || "video",
        url: item.url,
        thumb: item.thumb || null,
        label: item.type ? `${item.type} ${i + 1}` : `item ${i + 1}`,
      })),
    };
  }

  if (data.url) {
    return { url: data.url, filename: data.filename || null };
  }

  return { error: "extraction_failed" };
}

async function handleDownload(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Bad request." }, 400);
  }

  const { url, quality } = body || {};
  if (!isHttpUrl(url)) return json({ error: "Enter a valid link." }, 400);

  const platform = detectPlatform(url);
  if (!platform) return json({ error: "That link doesn't look like YouTube or Instagram." }, 400);

  const result = await resolveWithCobalt(env, { url, quality });

  if (result.error === "not_configured") {
    return json(
      {
        error:
          "The extraction backend isn't configured yet. Set COBALT_API_URL (see README.md) and redeploy.",
      },
      503
    );
  }
  if (result.error) {
    return json({ error: humanizeError(result.error, platform) }, 502);
  }

  return json(result);
}

function humanizeError(code, platform) {
  // YouTube specifically blocks requests from most shared/free hosting IP
  // ranges at the network level — a valid poToken doesn't fix this, it's an
  // IP reputation problem, not a code problem. Be upfront about it instead
  // of showing a vague error.
  if (platform === "youtube" && code === "content.video.unavailable") {
    return "YouTube is blocking this server's IP address right now — this happens on free/shared hosting and isn't specific to your link. Instagram reels aren't affected. See the README's \"YouTube reliability\" note for paid options that fix this.";
  }

  const map = {
    backend_unreachable: "Couldn't reach the extraction backend. Check COBALT_API_URL.",
    backend_bad_response: "The extraction backend returned something unexpected.",
    extraction_failed: "Couldn't get that video. It may be private, age-restricted, or removed.",
    "content.video.unavailable": "That video isn't available, or is blocked for this server.",
    "content.post.age": "That post is age-restricted.",
    "link.invalid": "That link isn't supported.",
  };
  return map[code] || "Couldn't process that link. Double-check the URL and try again.";
}

async function handleStream(request) {
  const params = new URL(request.url).searchParams;
  const src = params.get("u") || "";
  const name = params.get("name") || "download";

  if (!isHttpUrl(src)) return new Response("Bad source URL.", { status: 400 });

  const upstream = await fetch(src);
  if (!upstream.ok || !upstream.body) {
    return new Response("Couldn't fetch the file from the backend.", { status: 502 });
  }

  const headers = new Headers(upstream.headers);
  headers.set("content-disposition", `attachment; filename="${sanitizeFilename(name)}"`);
  headers.set("access-control-allow-origin", "*");
  return new Response(upstream.body, { status: 200, headers });
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 150) || "download";
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/meta" && request.method === "GET") {
      return handleMeta(request, env);
    }
    if (pathname === "/api/download" && request.method === "POST") {
      return handleDownload(request, env);
    }
    if (pathname === "/api/stream" && request.method === "GET") {
      return handleStream(request);
    }

    return env.ASSETS.fetch(request);
  },
};
