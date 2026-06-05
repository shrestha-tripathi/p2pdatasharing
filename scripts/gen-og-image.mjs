// Generate the Open Graph preview image (1200x630, social-card standard).
// Run via `node scripts/gen-og-image.mjs`.
//
// Design: dark background with subtle radial accent glow, the actual
// FileTransferNow brand mark (portal spiral + paper plane) on the left,
// and the headline + subline on the right. Matches the favicon / nav /
// footer so the OG card is brand-consistent across all share unfurls.
import sharp from "sharp";
import { writeFileSync } from "node:fs";

const W = 1200;
const H = 630;

// Brand mark — same geometry as public/favicon.svg, scaled up.
// Drawn into its own viewport (0 0 512 512) inside a group transform.
const brandMark = `
  <g transform="translate(80, 105) scale(0.7)">
    <!-- Portal spiral -->
    <path
      d="M 286.0 256.0 C 288.6 261.7, 289.2 268.4, 288.1 274.5 C 286.8 281.8, 283.1 288.9, 278.1 294.2 C 272.3 300.5, 264.3 305.1, 256.0 307.2 C 246.6 309.7, 236.1 309.4, 226.8 306.5 C 216.4 303.3, 206.6 296.9, 199.3 288.7 C 191.3 279.7, 185.7 267.9, 183.5 256.0 C 181.1 242.9, 182.4 228.7, 187.1 216.2 C 192.1 202.6, 201.4 190.1, 212.7 180.9 C 224.9 171.1, 240.4 164.5, 256.0 162.2 C 272.8 159.8, 290.7 162.2, 306.4 168.7 C 323.2 175.6, 338.5 187.6, 349.5 202.0 C 361.2 217.5, 368.7 236.8, 371.0 256.0 C 373.4 276.4, 370.0 298.2, 361.7 317.0 C 353.0 337.0, 338.2 355.1, 320.6 367.9 C 302.0 381.4, 278.9 390.0, 256.0 392.2 C 231.9 394.6, 206.4 390.2, 184.3 380.1 C 161.2 369.5, 140.4 352.0, 125.7 331.2 C 110.4 309.4, 100.8 282.6, 98.5 256.0 C 96.1 228.2, 101.6 198.9, 113.5 173.7 C 125.9 147.4, 146.2 123.8, 170.2 107.3 C 195.2 90.2, 225.8 79.5, 256.0 77.2 C 287.4 74.9, 320.5 81.3, 348.9 95.1 C 378.4 109.3, 404.7 132.4, 423.1 159.5 C 442.1 187.7, 453.7 222.1, 456.0 256.0"
      fill="none" stroke="#ffffff" stroke-width="14"
      stroke-linecap="round" stroke-linejoin="round" opacity="0.45"/>
    <path d="M110 350 L430 130 L290 380 L240 300 Z" fill="#ffffff"/>
    <path d="M240 300 L430 130 L290 250 Z" fill="#ffffff" opacity="0.5"/>
  </g>
`;

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a0a0a"/>
      <stop offset="100%" stop-color="#1a1a1a"/>
    </linearGradient>
    <radialGradient id="glow" cx="85%" cy="20%" r="60%">
      <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>

  <!-- Subtle grid texture -->
  <g stroke="#ffffff" stroke-opacity="0.04" stroke-width="1">
    ${Array.from({length: 24}, (_, i) => `<line x1="${i * 50}" y1="0" x2="${i * 50}" y2="${H}"/>`).join("")}
    ${Array.from({length: 13}, (_, i) => `<line x1="0" y1="${i * 50}" x2="${W}" y2="${i * 50}"/>`).join("")}
  </g>

  ${brandMark}

  <!-- Wordmark next to the logo -->
  <text x="510" y="225" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="44" font-weight="700" fill="#ffffff" letter-spacing="-0.5">FileTransferNow</text>

  <!-- Big headline below the logo row -->
  <g transform="translate(80, 380)">
    <text font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="68" font-weight="700" fill="#ffffff" letter-spacing="-2">
      <tspan x="0" y="0">Send files,</tspan>
      <tspan x="0" y="84">browser to browser.</tspan>
    </text>
  </g>

  <!-- Subline -->
  <g transform="translate(80, 565)">
    <text font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="28" font-weight="400" fill="#a1a1aa">
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
