import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

/**
 * Blog content collection.
 *
 * Why a content collection (and not just .astro files in /pages/blog/)?
 *   - Typesafe frontmatter validation (catch bad metadata at build time)
 *   - Automatic file globbing — drop a .md file in /content/blog/ and it
 *     gets picked up by the [...slug].astro route without manual wiring
 *   - Astro generates a sitemap entry per post automatically
 *
 * Each post requires: title, description, pubDate. Optional: updatedDate,
 * tags (for filtering / related posts), draft (excludes from prod build),
 * heroImage (OG card override).
 */
const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string().max(100),
    description: z.string().max(200),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
    heroImage: z.string().optional(),
  }),
});

export const collections = { blog };
