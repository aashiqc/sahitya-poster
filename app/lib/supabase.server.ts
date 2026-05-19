import {
  createServerClient,
  parseCookieHeader,
  serializeCookieHeader,
} from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "./env";
import { DEV_DEFAULT_TENANT, RESERVED_SUBDOMAINS, ROOT_DOMAIN } from "./constants";

export function createSupabaseServerClient(request: Request) {
  const { url, anonKey } = getSupabaseEnv();
  const headers = new Headers();

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return parseCookieHeader(request.headers.get("Cookie") ?? "")
          .filter((c): c is { name: string; value: string } => c.value !== undefined);
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) =>
          headers.append("Set-Cookie", serializeCookieHeader(name, value, options)),
        );
      },
    },
  });

  return { supabase, headers };
}

/**
 * Resolve the tenant subdomain from the request host.
 *
 * Production: `<tenant>.sahityotsav.live` → `"<tenant>"`. The apex,
 * `www`, and other reserved hosts have no tenant (→ "").
 *
 * Dev/preview (localhost, *.workers.dev, anything not under ROOT_DOMAIN):
 * use the `?tenant=` query param, else VITE_DEV_DEFAULT_TENANT, else
 * the built-in default.
 */
export function resolveTenant(request: Request): string {
  const url = new URL(request.url);
  const host = url.hostname; // no port

  if (host === ROOT_DOMAIN || host.endsWith(`.${ROOT_DOMAIN}`)) {
    if (host === ROOT_DOMAIN) return ""; // apex landing — not a tenant
    const sub = host.slice(0, host.length - ROOT_DOMAIN.length - 1).split(".")[0];
    if (!sub || RESERVED_SUBDOMAINS.has(sub)) return "";
    return sub;
  }

  // localhost / *.workers.dev / preview deployments
  return url.searchParams.get("tenant")?.trim() || DEV_DEFAULT_TENANT;
}

/** Per-request canonical origin (e.g. https://pantharangadi.sahityotsav.live).
 *  Used for absolute canonical / Open Graph / share URLs so every tenant
 *  gets its own correct links. */
export function siteUrlFromRequest(request: Request): string {
  return new URL(request.url).origin;
}

/**
 * Load the tenant's current event, resolved from the request host.
 * Replaces the old single-tenant loadEvent(). Throws a 404 (rendered by
 * the branded boundary) when the subdomain is unknown or has no current
 * event — never a 500.
 */
export async function loadTenantEvent(
  request: Request,
  supabase: SupabaseClient,
) {
  const sub = resolveTenant(request);
  if (!sub) {
    throw new Response("This address isn’t set up for a Sahityotsav yet.", {
      status: 404,
    });
  }
  const { data, error } = await supabase
    .from("events")
    .select(
      "id, slug, name, name_ml, status, starts_on, ends_on, organization_id, standings_template, final_poster_url, result_template, poster_lang, poster_name, poster_font_en, poster_font_ml, poster_layout, poster_date, poster_time, poster_place, organizations!inner(name, slug, subdomain)",
    )
    .eq("organizations.subdomain", sub)
    .eq("is_current", true)
    .maybeSingle();
  if (error || !data) {
    // No event visible. organizations is public-readable, so we can
    // tell "sector not live yet" (org exists, event still draft/private
    // — RLS hides it from the public client) apart from a genuinely
    // unknown subdomain, and word the 404 accordingly.
    const { data: org } = await supabase
      .from("organizations")
      .select("name")
      .eq("subdomain", sub)
      .maybeSingle();
    throw new Response(
      org
        ? `${org.name}’s results aren’t published yet — please check back soon.`
        : `No Sahityotsav sector at “${sub}”.`,
      { status: 404 },
    );
  }
  return data;
}

export async function requireAdmin(request: Request) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Response(null, {
      status: 302,
      headers: { ...Object.fromEntries(headers), Location: "/admin/login" },
    });
  }
  const { data: profile } = await supabase
    .from("profiles")
    .select("user_id, organization_id, role, full_name, organizations(slug, name)")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!profile) {
    throw new Response(
      "Your account is not invited as an admin. Contact your sector lead.",
      { status: 403, headers: Object.fromEntries(headers) },
    );
  }
  return { supabase, headers, user, profile };
}
