import {
  createServerClient,
  parseCookieHeader,
  serializeCookieHeader,
} from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "./env";
import { EVENT_SLUG } from "./constants";

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

export async function loadEvent(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("events")
    .select("id, slug, name, name_ml, status, starts_on, ends_on, organization_id, standings_template, final_poster_url, organizations(name, slug)")
    .eq("slug", EVENT_SLUG)
    .single();
  if (error || !data) {
    throw new Response("Event not configured", { status: 500 });
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
