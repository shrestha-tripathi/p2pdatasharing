// One-shot: generate PWA icons (192, 512, 512-maskable) + favicon.ico
// from favicon.svg. Run via `node scripts/gen-icons.mjs`.
import sharp from "sharp";
import pngToIco from "png-to-ico";
import { readFileSync, writeFileSync } from "node:fs";

const svg = readFileSync("public/favicon.svg");

// Solid white background + the icon centered; maskable variant has a safe zone (10% padding).
const renderIcon = async (size, { maskable = false } = {}) => {
  const innerScale = maskable ? 0.7 : 0.82;
  const innerSize = Math.round(size * innerScale);
  const offset = Math.round((size - innerSize) / 2);
  const inner = await sharp(svg).resize(innerSize, innerSize).png().toBuffer();
  const composed = await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 }, // black bg (matches dark theme)
    },
  })
    .composite([{ input: inner, top: offset, left: offset }])
    .png()
    .toBuffer();
  return composed;
};

// Re-color the SVG so it renders as white on the black bg. The favicon.svg
// uses #0a0a0a (matching the dark-theme foreground color), and theme-adaptive
// CSS swaps stroke/fill to #fafafa via prefers-color-scheme. The CSS doesn't
// apply when sharp rasterizes the SVG, so we patch the source colors directly
// before rendering. Handles both stroke= and fill= attrs (the portal spiral
// is a stroked path, the paper plane is filled).
const whiteSvg = svg
  .toString()
  .replace(/stroke=\"#0a0a0a\"/g, 'stroke="#fafafa"')
  .replace(/fill=\"#0a0a0a\"/g, 'fill="#fafafa"')
  // Backward-compat with any leftover #000 references (legacy)
  .replace(/stroke=\"#000\"/g, 'stroke="#fafafa"')
  .replace(/fill=\"#000\"/g, 'fill="#fafafa"');
writeFileSync("/tmp/icon-white.svg", whiteSvg);

const renderWithColor = async (size, { maskable = false } = {}) => {
  const innerScale = maskable ? 0.65 : 0.78;
  const innerSize = Math.round(size * innerScale);
  const offset = Math.round((size - innerSize) / 2);
  const inner = await sharp("/tmp/icon-white.svg").resize(innerSize, innerSize).png().toBuffer();
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 10, g: 10, b: 10, alpha: 1 },
    },
  })
    .composite([{ input: inner, top: offset, left: offset }])
    .png()
    .toBuffer();
};

writeFileSync("public/icon-192.png", await renderWithColor(192));
writeFileSync("public/icon-512.png", await renderWithColor(512));
writeFileSync("public/icon-512-maskable.png", await renderWithColor(512, { maskable: true }));
writeFileSync("public/apple-touch-icon.png", await renderWithColor(180));
console.log("✓ Icons generated: 192, 512, 512-maskable, apple-touch (180)");

// favicon.ico — multi-resolution ICO container (16, 32, 48) so Windows,
// older browsers, and pinned tabs all get a crisp render. We re-use the
// black-bg + white-icon look so the favicon stays visible regardless of
// the browser's tab background color.
const ico16 = await renderWithColor(16);
const ico32 = await renderWithColor(32);
const ico48 = await renderWithColor(48);
const ico = await pngToIco([ico16, ico32, ico48]);
writeFileSync("public/favicon.ico", ico);
console.log(`✓ favicon.ico generated (multi-res: 16/32/48, ${(ico.length / 1024).toFixed(1)} KB)`);
