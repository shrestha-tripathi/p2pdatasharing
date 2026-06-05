/**
 * Central site configuration — single source of truth for brand name,
 * domain, signaling endpoint, and SEO meta. Override via PUBLIC_* env vars.
 *
 * Nothing in /src should hardcode the brand name — always import from here so
 * a domain rename is one `.env` edit away.
 */

const env = import.meta.env;

export const site = {
  name: env.PUBLIC_SITE_NAME ?? "FileTransferNow",
  shortName: env.PUBLIC_SITE_SHORT_NAME ?? "FileTransferNow",
  domain: env.PUBLIC_SITE_DOMAIN ?? "filetransfernow.com",
  url: env.PUBLIC_SITE_URL ?? "https://filetransfernow.com",
  /**
   * Short memorable tagline shown in hero + OG cards.
   * 3-4 words, positions us as the anti-cloud option.
   */
  tagline: env.PUBLIC_SITE_TAGLINE ?? "Files, finally direct.",
  /**
   * Meta description — under 160 chars so Google doesn't truncate.
   * Front-loads the highest-intent keywords: 'send files', 'no upload',
   * 'peer-to-peer', 'no size limit', 'free'.
   */
  description:
    env.PUBLIC_SITE_DESCRIPTION ??
    "Send files browser-to-browser with no upload, no signup, and no size limit. Free peer-to-peer file transfer over WebRTC, end-to-end encrypted, works across any network.",
  /**
   * SEO keywords meta — low ranking weight in 2026 but free signal for
   * Bing, Yandex, DuckDuckGo. Curated for actual user search intent.
   */
  keywords:
    env.PUBLIC_SITE_KEYWORDS ??
    "send large files online, peer to peer file transfer, browser file sharing, no upload file transfer, free file transfer, p2p file sharing, webrtc file transfer, send big files without limit, secure file sharing, end to end encrypted file transfer, no signup file transfer, wetransfer alternative, send file directly browser to browser",
  author: env.PUBLIC_SITE_AUTHOR ?? "Shrestha Tripathi",
  locale: env.PUBLIC_SITE_LOCALE ?? "en-US",
  twitter: env.PUBLIC_SITE_TWITTER ?? "",
  /**
   * Public contact email shown on /contact and /privacy-policy.
   * Set via env so a domain change doesn't require code edits.
   */
  contactEmail: env.PUBLIC_SITE_CONTACT_EMAIL ?? "hello@filetransfernow.com",
  /**
   * Public GitHub repo URL for the project. Surfaced on /contact, /about,
   * and /privacy as the canonical "audit the source" link.
   */
  githubRepo:
    env.PUBLIC_SITE_GITHUB_REPO ??
    "https://github.com/shrestha-tripathi/p2pdatasharing",
  /**
   * Jurisdiction whose law governs the Terms & Conditions. Defaults to
   * India since the author is based there; override via env if the
   * operating entity changes country.
   */
  jurisdiction: env.PUBLIC_SITE_JURISDICTION ?? "India",
  /**
   * Public WebSocket URL of the signaling server. Used only for SDP/ICE
   * handshake — zero file bytes ever flow through it.
   */
  signalingUrl: env.PUBLIC_SIGNALING_URL ?? "ws://localhost:8080",
} as const;

export type SiteConfig = typeof site;
