import {
  createSupabaseServerClient,
  resolveTenant,
} from "~/lib/supabase.server";
import type { Route } from "./+types/site-webmanifest";

// Per-tenant PWA manifest. Each sector subdomain installs as its own
// home-screen app (own name, own identity) rather than every tenant
// sharing one generic "Sahityotsav" install. Apex / reserved hosts
// (sahityotsav.live, www, owner, etc.) return 404 — only real tenant
// subdomains are installable.
export async function loader({ request }: Route.LoaderArgs) {
  const tenant = resolveTenant(request);
  if (!tenant) {
    return new Response("Not found", { status: 404 });
  }

  const { supabase } = createSupabaseServerClient(request);
  const { data: org } = await supabase
    .from("organizations")
    .select("name")
    .eq("subdomain", tenant)
    .maybeSingle();
  if (!org) {
    return new Response("Not found", { status: 404 });
  }

  const orgName = org.name?.trim() || "Sahityotsav";
  // Keep short_name actually short (12-char hard limit on iOS home
  // screen before it ellipsises). For longer org names, fall back to
  // the first word so the home-screen label stays readable.
  const shortName = orgName.length <= 12 ? orgName : orgName.split(/\s+/)[0];

  const manifest = {
    name: `${orgName} Sahityotsav — Results`,
    short_name: shortName,
    description: `Live results from ${orgName} Sahityotsav.`,
    start_url: "/?src=pwa",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#FBF4E4",
    theme_color: "#0B090A",
    icons: [
      {
        src: "/web-app-manifest-192x192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any maskable",
      },
      {
        src: "/web-app-manifest-512x512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any maskable",
      },
    ],
  };

  return new Response(JSON.stringify(manifest, null, 2), {
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
      // Short edge cache — org renames are rare but should propagate
      // within minutes, not hours.
      "Cache-Control": "public, max-age=300, s-maxage=300",
    },
  });
}
