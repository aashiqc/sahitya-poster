import { Form, data, redirect, useActionData, useNavigation } from "react-router";
import type { Route } from "./+types/admin.login";
import { createSupabaseServerClient } from "~/lib/supabase.server";

export function meta() {
  return [{ title: "Admin sign in · Sahityotsav" }];
}

// In local dev there is no tenant subdomain, so the tenant rides in a
// ?tenant= query param. Carry it through the post-login redirect so a
// non-default sector's admin doesn't land on the wrong tenant (→ 403).
// Harmless in production (no such param; plain /admin).
function adminDest(request: Request): string {
  const t = new URL(request.url).searchParams.get("tenant");
  return t ? `/admin?tenant=${encodeURIComponent(t)}` : "/admin";
}

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    return redirect(adminDest(request), { headers: Object.fromEntries(headers) });
  }
  return data(null, { headers: Object.fromEntries(headers) });
}

type ActionResult = { error: string } | { message: string } | undefined;

export async function action({ request }: Route.ActionArgs): Promise<Response | ActionResult> {
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
      error: "Sign-up is closed. Ask your sector owner to create your account.",
    };
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: error.message };
  return redirect(adminDest(request), { headers: Object.fromEntries(headers) });
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
            Accounts are created by your sector owner.
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
