import { Form, data, redirect, useActionData, useNavigation } from "react-router";
import type { Route } from "./+types/admin.login";
import { createSupabaseServerClient } from "~/lib/supabase.server";

export function meta() {
  return [{ title: "Admin sign in · Sahityotsav" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    return redirect("/admin", { headers: Object.fromEntries(headers) });
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
  if (password.length < 8) return { error: "Password must be at least 8 characters." };

  const { supabase, headers } = createSupabaseServerClient(request);

  if (intent === "signup") {
    const { data: signUpData, error } = await supabase.auth.signUp({ email, password });
    if (error) return { error: error.message };
    if (signUpData.session) {
      return redirect("/admin", { headers: Object.fromEntries(headers) });
    }
    return { message: "Account created. Check your email to confirm before signing in." };
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: error.message };
  return redirect("/admin", { headers: Object.fromEntries(headers) });
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
            Only invited emails get access.
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
            minLength={8}
            required
            className="w-full rounded-xl border border-stone-300 bg-white px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-brand-600"
            placeholder="At least 8 characters"
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
          <button
            type="submit"
            name="intent"
            value="signup"
            disabled={busy}
            className="flex-1 rounded-xl border border-stone-300 hover:bg-stone-50 text-stone-700 py-2.5 text-sm font-medium disabled:opacity-50 transition"
          >
            Create account
          </button>
        </div>
      </Form>
    </div>
  );
}
