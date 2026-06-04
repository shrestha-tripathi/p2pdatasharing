/**
 * Central site configuration — single source of truth for brand name,
 * domain, signaling endpoint, and SEO meta. Override via PUBLIC_* env vars.
 *
 * Nothing in /src should hardcode the brand name — always import from here so
 * a domain rename is one `.env` edit away.
 */

const env = import.meta.env;

export const site = {
  name: env.PUBLIC_SITE_NAME ?? "Local Teleport",
  shortName: env.PUBLIC_SITE_SHORT_NAME ?? "Local Teleport",
  domain: env.PUBLIC_SITE_DOMAIN ?? "p2pdatasharing.local",
  url: env.PUBLIC_SITE_URL ?? "https://p2pdatasharing.local",
  tagline:
    env.PUBLIC_SITE_TAGLINE ??
    "Zero-cloud P2P file teleporter — browser to browser, never through a server.",
  description:
    env.PUBLIC_SITE_DESCRIPTION ??
    "Send files of any size directly browser-to-browser with WebRTC. No uploads, no signup, no size limits. End-to-end encrypted by default.",
  author: env.PUBLIC_SITE_AUTHOR ?? "Shrestha Tripathi",
  locale: env.PUBLIC_SITE_LOCALE ?? "en-US",
  twitter: env.PUBLIC_SITE_TWITTER ?? "",
  /**
   * Public WebSocket URL of the signaling server. Used only for SDP/ICE
   * handshake — zero file bytes ever flow through it.
   */
  signalingUrl: env.PUBLIC_SIGNALING_URL ?? "ws://localhost:8080",
} as const;

export type SiteConfig = typeof site;
