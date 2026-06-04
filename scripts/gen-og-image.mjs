// Generate the Open Graph preview image (1200x630, social-card standard).
// Run via `node scripts/gen-og-image.mjs`.
import sharp from "sharp";
import { writeFileSync } from "node:fs";

const W = 1200;
const H = 630;

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a0a0a"/>
      <stop offset="100%" stop-color="#1a1a1a"/>
    </linearGradient>
    <radialGradient id="glow" cx="80%" cy="20%" r="60%">
      <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>

  <!-- Grid texture -->
  <g stroke="#ffffff" stroke-opacity="0.04" stroke-width="1">
    ${Array.from({length: 24}, (_, i) => `<line x1="${i * 50}" y1="0" x2="${i * 50}" y2="${H}"/>`).join("")}
    ${Array.from({length: 13}, (_, i) => `<line x1="0" y1="${i * 50}" x2="${W}" y2="${i * 50}"/>`).join("")}
  </g>

  <!-- Top-left brand row -->
  <g transform="translate(80, 80)">
    <!-- Logo glyph (simplified A from favicon) -->
    <g fill="#ffffff">
      <path d="M0 80 L25 0 L50 0 L75 80 L60 80 L55 60 L20 60 L15 80 Z M25 45 L50 45 L37.5 15 Z"/>
    </g>
    <text x="95" y="55" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="32" font-weight="600" fill="#ffffff">FileTransferNow</text>
  </g>

  <!-- Big headline -->
  <g transform="translate(80, 280)">
    <text font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="84" font-weight="700" fill="#ffffff" letter-spacing="-2">
      <tspan x="0" y="0">Send files,</tspan>
      <tspan x="0" y="100">browser to browser.</tspan>
    </text>
  </g>

  <!-- Subline -->
  <g transform="translate(80, 510)">
    <text font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="32" font-weight="400" fill="#a1a1aa">
      No uploads · No signup · No size limits
    </text>
  </g>

  <!-- Accent pill bottom-right -->
  <g transform="translate(${W - 280}, ${H - 90})">
    <rect width="200" height="44" rx="22" fill="#3b82f6"/>
    <text x="100" y="29" text-anchor="middle" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="16" font-weight="600" fill="#ffffff" letter-spacing="0.5">END-TO-END P2P</text>
  </g>
</svg>
`;

const buf = await sharp(Buffer.from(svg)).png({ quality: 92 }).toBuffer();
writeFileSync("public/og-image.png", buf);
console.log(`✓ Generated public/og-image.png (${W}x${H}, ${(buf.length / 1024).toFixed(1)} KB)`);
