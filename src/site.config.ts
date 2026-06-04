/**
 * Central site configuration — single source of truth for brand name,
 * domain, signaling endpoint, and SEO meta. Override via PUBLIC_* env vars.
 *
 * Nothing in /src should hardcode the brand name — always import from here so
 * a domain rename is one `.env` edit away.
 */

const env = import.meta.env;

export const site = {
  name: env.PUBLIC_SITE_NAME ?? "WebFileSend",
  shortName: env.PUBLIC_SITE_SHORT_NAME ?? "WebFileSend",
  domain: env.PUBLIC_SITE_DOMAIN ?? "webfilesend.com",
  url: env.PUBLIC_SITE_URL ?? "https://webfilesend.com",
  tagline:
    env.PUBLIC_SITE_TAGLINE ??
    "Send files browser to browser across any network — no upload, no server, no size limit.",
  description:
    env.PUBLIC_SITE_DESCRIPTION ??
    "Truly peer-to-peer file transfer that works across any network, anywhere in the world. Direct browser-to-browser via WebRTC — your files never touch a server. No signup, no install, no size limit. End-to-end encrypted by default.",
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
