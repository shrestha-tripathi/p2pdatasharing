// Service worker — minimal: handles the POST /transfer share-target
// request by stashing incoming files in a Cache and redirecting the
// browser to /transfer?shared=1. The transfer page reads them on boot.
//
// We intentionally do NOT do offline caching of the site here — keeps the
// SW dead simple and avoids stale-asset bugs. The browser cache + CF edge
// already handle that.

const SHARE_CACHE = "share-target-v1";
const SHARE_KEY = "/__shared__";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Web Share Target POST → store files, redirect to /transfer?shared=1
  if (event.request.method === "POST" && url.pathname.endsWith("/transfer")) {
    event.respondWith(handleShare(event.request));
    return;
  }
  // The transfer page, after loading, asks for /__shared__ to retrieve files.
  if (event.request.method === "GET" && url.pathname.endsWith(SHARE_KEY)) {
    event.respondWith(serveShared());
    return;
  }
});

async function handleShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll("files").filter((f) => f instanceof File);
    if (files.length > 0) {
      const cache = await caches.open(SHARE_CACHE);
      // Stash each file as a Response in the cache keyed by index
      // (Cache API stores Responses, so we wrap each Blob.)
      await Promise.all(
        files.map(async (file, idx) => {
          const headers = new Headers({
            "x-name": encodeURIComponent(file.name),
            "x-type": file.type || "application/octet-stream",
            "x-size": String(file.size),
          });
          await cache.put(
            new Request(`${SHARE_KEY}/${idx}`),
            new Response(file, { headers }),
          );
        }),
      );
      // Store the count so the page knows how many to read
      await cache.put(
        new Request(`${SHARE_KEY}/meta`),
        new Response(JSON.stringify({ count: files.length }), {
          headers: { "content-type": "application/json" },
        }),
      );
    }
    // Redirect to the transfer page — it'll pick up the files
    return Response.redirect("/transfer?shared=1", 303);
  } catch (e) {
    return Response.redirect("/transfer?shareError=" + encodeURIComponent(e.message), 303);
  }
}

async function serveShared() {
  const cache = await caches.open(SHARE_CACHE);
  const meta = await cache.match(`${SHARE_KEY}/meta`);
  if (!meta) {
    return new Response(JSON.stringify({ count: 0 }), {
      headers: { "content-type": "application/json" },
    });
  }
  const { count } = await meta.json();
  const files = [];
  for (let i = 0; i < count; i++) {
    const r = await cache.match(`${SHARE_KEY}/${i}`);
    if (!r) continue;
    const blob = await r.blob();
    const name = decodeURIComponent(r.headers.get("x-name") || `shared-${i}`);
    const type = r.headers.get("x-type") || blob.type;
    files.push({ name, type, blob });
  }
  // Clear cache so files don't stick around
  await cache.delete(`${SHARE_KEY}/meta`);
  for (let i = 0; i < count; i++) await cache.delete(`${SHARE_KEY}/${i}`);

  // Return a JSON manifest + the page reconstructs Files via fetch of each blob URL.
  // Simpler: return a multipart response. Even simpler: return one Response per file via separate fetches.
  // Cleanest: encode all files into a single multipart/form-data Response.
  const form = new FormData();
  for (const f of files) {
    form.append("files", new File([f.blob], f.name, { type: f.type }));
  }
  return new Response(form);
}
