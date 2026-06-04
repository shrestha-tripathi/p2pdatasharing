import type { APIRoute } from "astro";
import { site } from "../site.config";

/**
 * Dynamic sitemap. Pages list is hand-maintained — small site, low churn,
 * and we want explicit control over what's indexed (e.g. /transfer is a
 * stateful app surface, not content, so it's excluded).
 */
export const GET: APIRoute = () => {
  const today = new Date().toISOString().slice(0, 10);
  const pages = [
    { path: "/", priority: "1.0", changefreq: "weekly" },
    { path: "/how-it-works", priority: "0.7", changefreq: "monthly" },
    { path: "/privacy", priority: "0.5", changefreq: "monthly" },
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages
  .map(
    (p) => `  <url>
    <loc>${new URL(p.path, site.url).toString()}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`,
  )
  .join("\n")}
</urlset>
`;

  return new Response(xml, {
    status: 200,
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
};
