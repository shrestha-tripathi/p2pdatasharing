import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { site } from "../site.config";

/**
 * Dynamic sitemap.
 *
 * Static pages list is hand-maintained — small site, low churn, and we want
 * explicit control over what's indexed (e.g. /transfer is a stateful app
 * surface, not content, so it's excluded from indexing intentionally).
 *
 * Blog posts are auto-included from the content collection so adding a new
 * .md file in src/content/blog/ updates the sitemap with zero manual work.
 *
 * Priority guide:
 *   1.0  — homepage (single most important entry point)
 *   0.8  — high-value landing pages (local-network, install)
 *   0.7  — primary content (how-it-works, blog index, about)
 *   0.6  — blog posts (long-tail SEO content), faq
 *   0.5  — contact, privacy (technical)
 *   0.3  — legal documents (privacy-policy, terms) — needed for AdSense
 *           + trust signals, but not high SEO targets
 */
export const GET: APIRoute = async () => {
  const today = new Date().toISOString().slice(0, 10);

  const staticPages = [
    { path: "/", priority: "1.0", changefreq: "weekly" },
    { path: "/how-it-works", priority: "0.7", changefreq: "monthly" },
    { path: "/local-network", priority: "0.8", changefreq: "monthly" },
    { path: "/install", priority: "0.8", changefreq: "monthly" },
    { path: "/faq", priority: "0.6", changefreq: "monthly" },
    { path: "/blog", priority: "0.7", changefreq: "weekly" },
    { path: "/about", priority: "0.7", changefreq: "monthly" },
    { path: "/contact", priority: "0.5", changefreq: "yearly" },
    { path: "/privacy", priority: "0.5", changefreq: "yearly" },
    { path: "/privacy-policy", priority: "0.3", changefreq: "yearly" },
    { path: "/terms", priority: "0.3", changefreq: "yearly" },
  ];

  // Auto-include all non-draft blog posts. Each post's pubDate becomes its
  // lastmod so Google knows when content was last updated.
  const posts = await getCollection("blog", ({ data }) => !data.draft);
  const blogPosts = posts.map((p) => ({
    path: `/blog/${p.id}`,
    priority: "0.6",
    changefreq: "monthly",
    lastmod: (p.data.updatedDate ?? p.data.pubDate).toISOString().slice(0, 10),
  }));

  const allPages = [
    ...staticPages.map((p) => ({ ...p, lastmod: today })),
    ...blogPosts,
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allPages
  .map(
    (p) => `  <url>
    <loc>${new URL(p.path, site.url).toString()}</loc>
    <lastmod>${p.lastmod}</lastmod>
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
