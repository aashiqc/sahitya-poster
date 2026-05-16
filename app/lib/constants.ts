// This app is dedicated to a single event. The slug is the immutable handle
// used by every loader to fetch the event row. Change this only when starting
// a fresh event year.
export const EVENT_SLUG = "saaheethyolsav-26";

// Canonical public origin for absolute canonical / Open Graph / Twitter
// URLs. Build-time overridable per deploy target via VITE_SITE_URL
// (e.g. the Cloudflare Workers URL); defaults to the Vercel domain.
export const SITE_URL =
  (import.meta.env.VITE_SITE_URL as string | undefined) ??
  "https://ssfpantharangadi.vercel.app";
