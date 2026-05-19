// This app is multi-tenant: many Sahityotsav sectors/units/divisions are
// served from one deployment, each on its own subdomain of ROOT_DOMAIN.
// The tenant (and thus the event) is resolved per-request from the host
// — see loadTenantEvent() in supabase.server.ts. There is no hardcoded
// event slug anymore.

// Root domain every tenant subdomain lives under (Cloudflare DNS).
// A tenant is reached at https://<subdomain>.sahityotsav.live
export const ROOT_DOMAIN = "sahityotsav.live";

// Hosts under ROOT_DOMAIN that are NOT tenants (apex/www landing, the
// owner console, future app/api hosts). A tenant subdomain may never be
// one of these.
export const RESERVED_SUBDOMAINS = new Set([
  "www",
  "owner",
  "app",
  "api",
]);

// The owner console clones this tenant's current event (its levels +
// programs) as the canonical seed when provisioning a new sector.
export const TEMPLATE_SUBDOMAIN =
  (import.meta.env.VITE_TEMPLATE_SUBDOMAIN as string | undefined) ??
  "pantharangadi";

// In local dev / preview (localhost, *.workers.dev) there is no tenant
// subdomain, so fall back to this tenant. Override per-machine with
// VITE_DEV_DEFAULT_TENANT, or per-request with ?tenant=<subdomain>.
export const DEV_DEFAULT_TENANT =
  (import.meta.env.VITE_DEV_DEFAULT_TENANT as string | undefined) ??
  "pantharangadi";

// Last-resort canonical origin, used only when a real request host is
// unavailable (e.g. build time). At runtime SITE_URL is per-request,
// derived from the actual tenant host via siteUrlFromRequest().
export const SITE_URL_FALLBACK =
  (import.meta.env.VITE_SITE_URL as string | undefined) ??
  `https://pantharangadi.${ROOT_DOMAIN}`;
