// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// site + base allow deploys to either:
//   - GitHub Pages project site (https://<user>.github.io/<repo>/)  -> base = "/<repo>/"
//   - Custom domain / Cloudflare Pages                              -> base = "/"
// Drive both via env so the same build pipeline works in both worlds.
const SITE = process.env.PUBLIC_SITE_URL ?? 'https://shrestha-tripathi.github.io';
const BASE = process.env.PUBLIC_BASE_PATH ?? '/p2pdatasharing/';

// https://astro.build/config
export default defineConfig({
  site: SITE,
  base: BASE,
  trailingSlash: 'ignore',
  vite: {
    plugins: [tailwindcss()],
  },
  // Shiki dual-theme syntax highlighting.
  // - github-light  → applied by default
  // - github-dark   → activated via CSS when html[data-theme="dark"] (see global.css)
  // Astro emits both palettes inline; the CSS swap is zero-runtime.
  // wrap=true → soft-wrap long lines on narrow viewports (mobile readability).
  markdown: {
    shikiConfig: {
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
      wrap: true,
    },
  },
});
