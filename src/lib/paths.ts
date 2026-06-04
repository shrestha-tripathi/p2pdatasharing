/**
 * Resolve an internal path against Astro's configured `base` so links work
 * on both GitHub Pages (under /p2pdatasharing/) and root deploys.
 * Always call this for in-app navigation hrefs.
 */
export function withBase(path: string): string {
  const base = import.meta.env.BASE_URL || "/";
  const clean = path.startsWith("/") ? path.slice(1) : path;
  return base.endsWith("/") ? base + clean : `${base}/${clean}`;
}
