import { Form, data, redirect, useActionData, useNavigation } from "react-router";
import type { Route } from "./+types/admin.login";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient, resolveTenant } from "~/lib/supabase.server";
import { ownerEmails } from "~/lib/supabase.owner.server";
import { ROOT_DOMAIN } from "~/lib/constants";

export function meta() {
  return [{ title: "Admin sign in · Sahityotsav" }];
}

const NO_SECTOR = "__no_sector__";

/** Where to send the admin after a successful sign-in.
 *
 *  On a tenant subdomain → just /admin on the same host (existing
 *  behaviour, plus the dev `?tenant=` carry-through).
 *
 *  On the apex / a reserved host → look up the user's organisation and
 *  302 to their own sector's admin (cross-host absolute URL). Auth
 *  cookies are now zone-scoped (Domain=.sahityotsav.live) so the
 *  session travels with the redirect. If the user has no profile row
 *  yet, signal NO_SECTOR so the caller can show a friendly error
 *  instead of redirecting them in circles. */
async function postLoginRedirect(
  request: Request,
  supabase: SupabaseClient,
  context: unknown,
): Promise<string> {
  const sub = resolveTenant(request);
  if (sub) {
    const t = new URL(request.url).searchParams.get("tenant");
    return t ? `/admin?tenant=${encodeURIComponent(t)}` : "/admin";
  }
  // Apex sign-in. Route the signed-in user to the right console:
  //  - owner-allowlisted email → the owner console
  //  - an org-bound profile     → that organisation's admin
  //  - neither                  → show a friendly error (NO_SECTOR)
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "/admin/login";
  if (
    user.email &&
    ownerEmails(context).includes(user.email.toLowerCase())
  ) {
    return `https://owner.${ROOT_DOMAIN}/owner`;
  }
  const { data: profile } = await supabase
    .from("profiles")
    .select("organizations(subdomain)")
    .eq("user_id", user.id)
    .maybeSingle();
  const orgSub = (
    profile?.organizations as { subdomain?: string } | null
  )?.subdomain;
  return orgSub ? `https://${orgSub}.${ROOT_DOMAIN}/admin` : NO_SECTOR;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    const dest = await postLoginRedirect(request, supabase, context);
    if (dest !== NO_SECTOR)
      return redirect(dest, { headers: Object.fromEntries(headers) });
    // Signed in but neither owner nor org-bound — fall through to
    // render the form with an error rather than a redirect loop.
  }
  return data(null, { headers: Object.fromEntries(headers) });
}

type ActionResult = { error: string } | { message: string } | undefined;

export async function action({ request, context }: Route.ActionArgs): Promise<Response | ActionResult> {
  const formData = await request.formData();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const intent = String(formData.get("intent") ?? "signin");

  if (!email || !password) return { error: "Email and password are required." };
  if (password.length < 6) return { error: "Password must be at least 6 characters." };

  const { supabase, headers } = createSupabaseServerClient(request);

  if (intent === "signup") {
    // Public self-signup is disabled. Admin accounts are provisioned by
    // the owner console (which creates the auth user + an org-bound
    // profile via the service role). Reject the intent server-side so
    // removing the button isn't the only gate.
    return {
      error: "Sign-up is closed. Ask the owner to create your account.",
    };
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: error.message };
  const dest = await postLoginRedirect(request, supabase, context);
  if (dest === NO_SECTOR) {
    return {
      error:
        "Your account isn’t linked to an organisation yet. Ask the owner to invite you.",
    };
  }
  return redirect(dest, { headers: Object.fromEntries(headers) });
}

export default function AdminLogin() {
  const actionData = useActionData() as ActionResult;
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <div className="min-h-dvh flex items-center justify-center bg-stone-50 px-4 py-12">
      <Form
        method="post"
        className="w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-7 shadow-sm space-y-5"
      >
        <div>
          <p className="text-xs font-medium tracking-widest text-brand-700 uppercase">
            Sahityotsav · Admin
          </p>
          <h1 className="text-2xl font-semibold tracking-tight mt-1">Sign in</h1>
          <p className="text-sm text-stone-500 mt-1">
            Accounts are created by the owner. You'll be taken to your
            own dashboard after signing in.
          </p>
        </div>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-stone-700">Email</span>
          <input
            name="email"
            type="email"
            autoComplete="email"
            required
            className="w-full rounded-xl border border-stone-300 bg-white px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-brand-600"
            placeholder="you@example.com"
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-stone-700">Password</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            minLength={6}
            required
            className="w-full rounded-xl border border-stone-300 bg-white px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-brand-600"
            placeholder="At least 6 characters"
          />
        </label>

        {actionData && "error" in actionData && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {actionData.error}
          </p>
        )}
        {actionData && "message" in actionData && (
          <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            {actionData.message}
          </p>
        )}

        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            name="intent"
            value="signin"
            disabled={busy}
            className="flex-1 rounded-xl bg-brand-700 hover:bg-brand-800 text-white py-2.5 text-sm font-medium disabled:opacity-50 transition"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </Form>
    </div>
  );
}
