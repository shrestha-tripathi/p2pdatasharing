/**
 * Central site configuration — single source of truth for brand name,
 * domain, tagline, and SEO meta. Override via environment variables
 * (PUBLIC_SITE_NAME, PUBLIC_SITE_DOMAIN, etc.) when the domain is finalized.
 *
 * Nothing in /src should hardcode the name "p2pdatesharing" — always
 * import from here so a rename is one env var away.
 */

const env = import.meta.env;

export const site = {
  name: env.PUBLIC_SITE_NAME ?? "P2P Date Sharing",
  shortName: env.PUBLIC_SITE_SHORT_NAME ?? "P2PShare",
  domain: env.PUBLIC_SITE_DOMAIN ?? "p2pdatesharing.local",
  url: env.PUBLIC_SITE_URL ?? "https://p2pdatesharing.local",
  tagline:
    env.PUBLIC_SITE_TAGLINE ??
    "Peer-to-peer file sharing — files never touch a server.",
  description:
    env.PUBLIC_SITE_DESCRIPTION ??
    "Send files directly browser-to-browser using WebRTC. End-to-end encrypted, zero uploads, no signup.",
  author: env.PUBLIC_SITE_AUTHOR ?? "Shrestha Tripathi",
  locale: env.PUBLIC_SITE_LOCALE ?? "en-US",
  twitter: env.PUBLIC_SITE_TWITTER ?? "",
} as const;

export type SiteConfig = typeof site;
