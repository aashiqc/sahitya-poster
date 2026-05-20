// Owner-console-only server helpers. This module is `*.server.ts`, so it
// is stripped from the client bundle — the SERVICE ROLE key never reaches
// the browser. The key + owner allowlist come from Cloudflare secrets
// (`wrangler secret put SUPABASE_SERVICE_ROLE_KEY` / `OWNER_EMAILS`), set
// in `.dev.vars` for local dev. They are NEVER `VITE_`-prefixed.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ROOT_DOMAIN } from "./constants";

type CfEnv = {
  SUPABASE_SERVICE_ROLE_KEY?: string;
  OWNER_EMAILS?: string;
};

function cfEnv(context: unknown): CfEnv {
  return (
    (context as { cloudflare?: { env?: CfEnv } } | undefined)?.cloudflare
      ?.env ?? {}
  );
}

/** Supabase client using the SERVICE ROLE key — bypasses RLS. Owner
 *  console only. */
export function createServiceRoleClient(context: unknown): SupabaseClient {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = cfEnv(context).SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Response(
      "Owner console not configured: missing SUPABASE_SERVICE_ROLE_KEY.",
      { status: 500 },
    );
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function ownerEmails(context: unknown): string[] {
  return (cfEnv(context).OWNER_EMAILS ?? "")
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Gate every owner-console loader/action:
 *  - host must be `owner.<root>` in production (dev hosts are exempt so
 *    it stays testable on localhost / *.workers.dev),
 *  - a user must be signed in (else 302 → /admin/login),
 *  - their email must be in the OWNER_EMAILS allowlist (else 403).
 * Returns the signed-in user's email; the service-role client is created
 * separately by the caller via createServiceRoleClient(context).
 */
export async function requireOwner(
  request: Request,
  context: unknown,
  getUserEmail: () => Promise<string | null>,
): Promise<string> {
  const host = new URL(request.url).hostname;
  const underRoot = host === ROOT_DOMAIN || host.endsWith(`.${ROOT_DOMAIN}`);
  if (underRoot && host !== `owner.${ROOT_DOMAIN}`) {
    throw new Response("Not found", { status: 404 });
  }

  const email = (await getUserEmail())?.toLowerCase() ?? null;
  if (!email) {
    throw new Response(null, {
      status: 302,
      headers: { Location: "/admin/login" },
    });
  }
  const allow = ownerEmails(context);
  if (allow.length === 0 || !allow.includes(email)) {
    throw new Response("Not authorized for the owner console.", {
      status: 403,
    });
  }
  return email;
}
