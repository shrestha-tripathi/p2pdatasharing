// One-shot: generate PWA icons (192, 512, 512-maskable) from favicon.svg.
// Run via `node scripts/gen-icons.mjs`.
import sharp from "sharp";
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

// Re-color the SVG to white so it renders on the black bg
const whiteSvg = svg.toString().replace(/fill: #000/g, "fill: #fff").replace(/fill=\"#000\"/g, 'fill="#fff"');
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
