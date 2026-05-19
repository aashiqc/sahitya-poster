import {
  Form,
  data,
  redirect,
  useActionData,
  useNavigation,
} from "react-router";
import type { Route } from "./+types/owner";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import {
  createServiceRoleClient,
  requireOwner,
} from "~/lib/supabase.owner.server";
import {
  RESERVED_SUBDOMAINS,
  ROOT_DOMAIN,
  TEMPLATE_SUBDOMAIN,
} from "~/lib/constants";

export function meta() {
  return [{ title: "Owner console · Sahityotsav" }];
}

const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Production: https://<sub>.sahityotsav.live. Local dev / preview (no
// wildcard DNS): point at the current origin with ?tenant=<sub> so the
// links actually work while developing.
function tenantUrl(request: Request, sub: string): string {
  const u = new URL(request.url);
  const underRoot =
    u.hostname === ROOT_DOMAIN || u.hostname.endsWith(`.${ROOT_DOMAIN}`);
  return underRoot
    ? `https://${sub}.${ROOT_DOMAIN}`
    : `${u.origin}/?tenant=${sub}`;
}

// Strong random password for the admin-reset action. Shown to the owner
// once (the only time any plaintext exists); only the bcrypt hash is
// stored. Uses Web Crypto (available in workerd + Node).
function genPassword(len = 14): string {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let s = "";
  for (const b of buf) s += a[b % a.length];
  return s;
}

async function userEmail(request: Request): Promise<string | null> {
  const { supabase } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.email ?? null;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireOwner(request, context, () => userEmail(request));
  const svc = createServiceRoleClient(context);

  const { data: orgs } = await svc
    .from("organizations")
    .select("id, name, subdomain, created_at")
    .order("created_at", { ascending: true });

  const { data: events } = await svc
    .from("events")
    .select("organization_id, name, slug, status, is_current");

  const { data: profs } = await svc
    .from("profiles")
    .select("organization_id, user_id, role");

  // auth.users isn't exposed via PostgREST, so map id→email via the
  // admin API. Passwords are bcrypt-hashed and unrecoverable — only the
  // email is shown; "Reset password" issues (and reveals once) a new one.
  const { data: usersList } = await svc.auth.admin.listUsers({
    perPage: 1000,
  });
  const emailById = new Map<string, string | null>(
    (usersList?.users ?? []).map((u) => [u.id, u.email ?? null]),
  );

  const tenants = (orgs ?? []).map((o) => {
    const ev = (events ?? []).find(
      (e) => e.organization_id === o.id && e.is_current,
    );
    const sub = o.subdomain as string | null;
    const adminProf =
      (profs ?? []).find(
        (p) => p.organization_id === o.id && p.role === "admin",
      ) ?? (profs ?? []).find((p) => p.organization_id === o.id);
    const adminUserId = adminProf?.user_id ?? null;
    return {
      name: o.name,
      subdomain: sub,
      url: sub ? tenantUrl(request, sub) : null,
      event: ev ? { name: ev.name, status: ev.status } : null,
      adminEmail: adminUserId
        ? emailById.get(adminUserId) ?? null
        : null,
      adminUserId,
    };
  });

  return data({ tenants, rootDomain: ROOT_DOMAIN });
}

type ActionResult = { error: string } | { ok: true; message: string };

export async function action({
  request,
  context,
}: Route.ActionArgs): Promise<Response | ActionResult> {
  await requireOwner(request, context, () => userEmail(request));
  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");

  if (intent === "logout") {
    const { supabase, headers } = createSupabaseServerClient(request);
    await supabase.auth.signOut();
    return redirect("/admin/login", { headers: Object.fromEntries(headers) });
  }

  const svc = createServiceRoleClient(context);

  if (intent === "reset_admin_password") {
    const userId = String(fd.get("user_id") ?? "").trim();
    const email = String(fd.get("email") ?? "").trim();
    if (!userId) return { error: "No admin account on that tenant." };
    const pwd = genPassword();
    const { error } = await svc.auth.admin.updateUserById(userId, {
      password: pwd,
    });
    if (error) return { error: `Reset failed: ${error.message}` };
    return {
      ok: true,
      message: `New password for ${email || "admin"}: ${pwd}  — copy it now, it is shown only once.`,
    };
  }

  if (intent === "create_tenant") {
    const orgName = String(fd.get("org_name") ?? "").trim();
    const subdomain = String(fd.get("subdomain") ?? "")
      .trim()
      .toLowerCase();
    const eventName = String(fd.get("event_name") ?? "").trim();
    const eventNameMl = String(fd.get("event_name_ml") ?? "").trim() || null;
    const adminEmail = String(fd.get("admin_email") ?? "")
      .trim()
      .toLowerCase();
    const adminPassword = String(fd.get("admin_password") ?? "");

    if (!orgName || !eventName || !adminEmail) {
      return { error: "Org name, event name and admin email are required." };
    }
    if (!SUBDOMAIN_RE.test(subdomain) || RESERVED_SUBDOMAINS.has(subdomain)) {
      return {
        error:
          "Subdomain must be lowercase letters/numbers/hyphens and not a reserved word.",
      };
    }
    if (adminPassword.length < 6) {
      return { error: "Admin password must be at least 6 characters." };
    }

    const { data: dupe } = await svc
      .from("organizations")
      .select("id")
      .eq("subdomain", subdomain)
      .maybeSingle();
    if (dupe) return { error: `Subdomain “${subdomain}” is already taken.` };

    // Canonical seed: the template tenant's current event.
    const { data: tplOrg } = await svc
      .from("organizations")
      .select("id")
      .eq("subdomain", TEMPLATE_SUBDOMAIN)
      .maybeSingle();
    if (!tplOrg) return { error: "Template tenant not found." };
    const { data: tplEvent } = await svc
      .from("events")
      .select("id")
      .eq("organization_id", tplOrg.id)
      .eq("is_current", true)
      .maybeSingle();
    if (!tplEvent) return { error: "Template event not found." };

    const [{ data: tplLevels }, { data: tplPrograms }] = await Promise.all([
      svc
        .from("levels")
        .select("id, code, name_ml, sort_order")
        .eq("event_id", tplEvent.id),
      svc
        .from("programs")
        .select("code, name_ml, name_en, sort_order, level_id, is_active")
        .eq("event_id", tplEvent.id),
    ]);

    // Create the admin auth user FIRST. The most common failure
    // (duplicate email / weak password) then aborts with ZERO writes,
    // so the subdomain stays free and the owner can simply retry.
    const { data: createdUser, error: uErr } =
      await svc.auth.admin.createUser({
        email: adminEmail,
        password: adminPassword,
        email_confirm: true,
      });
    if (uErr || !createdUser.user) {
      return {
        error: `Admin login not created: ${
          uErr?.message ?? "unknown"
        }. Use a different email — nothing else was changed.`,
      };
    }
    const userId = createdUser.user.id;

    // From here every failure rolls back so create-tenant is
    // all-or-nothing and always retryable. Deletes are best-effort and
    // run in reverse FK order (programs/levels → event → org → user).
    let orgId: string | null = null;
    let eventId: string | null = null;
    const fail = async (msg: string): Promise<ActionResult> => {
      if (eventId) {
        await svc.from("programs").delete().eq("event_id", eventId);
        await svc.from("levels").delete().eq("event_id", eventId);
        await svc.from("events").delete().eq("id", eventId);
      }
      if (orgId) await svc.from("organizations").delete().eq("id", orgId);
      await svc.auth.admin.deleteUser(userId);
      return { error: `${msg} — rolled back; safe to retry.` };
    };

    // 1. Org
    const { data: org, error: oErr } = await svc
      .from("organizations")
      .insert({ slug: subdomain, name: orgName, subdomain })
      .select("id")
      .single();
    if (oErr || !org) return await fail(`Org: ${oErr?.message ?? "failed"}`);
    orgId = org.id;

    // 2. Event (current, draft)
    const { data: ev, error: eErr } = await svc
      .from("events")
      .insert({
        organization_id: org.id,
        slug: `${subdomain}-${slugify(eventName)}`,
        name: eventName,
        name_ml: eventNameMl,
        status: "draft",
        is_current: true,
      })
      .select("id")
      .single();
    if (eErr || !ev) return await fail(`Event: ${eErr?.message ?? "failed"}`);
    eventId = ev.id;

    // 3. Levels (remember code → new id)
    const levelIdByCode = new Map<string, string>();
    if (tplLevels && tplLevels.length) {
      const { data: newLevels, error: lErr } = await svc
        .from("levels")
        .insert(
          tplLevels.map((l) => ({
            event_id: ev.id,
            code: l.code,
            name_ml: l.name_ml,
            sort_order: l.sort_order,
          })),
        )
        .select("id, code");
      if (lErr) return await fail(`Levels: ${lErr.message}`);
      for (const nl of newLevels ?? []) levelIdByCode.set(nl.code, nl.id);
    }
    const tplLevelCodeById = new Map(
      (tplLevels ?? []).map((l) => [l.id, l.code]),
    );

    // 4. Programs (remap level_id by code)
    if (tplPrograms && tplPrograms.length) {
      const { error: pErr } = await svc.from("programs").insert(
        tplPrograms.map((p) => ({
          event_id: ev.id,
          code: p.code,
          name_ml: p.name_ml,
          name_en: p.name_en,
          sort_order: p.sort_order,
          level_id: p.level_id
            ? levelIdByCode.get(tplLevelCodeById.get(p.level_id) ?? "") ?? null
            : null,
          is_active: p.is_active,
        })),
      );
      if (pErr) return await fail(`Programs: ${pErr.message}`);
    }

    // 5. Org-bound admin profile
    const { error: prErr } = await svc.from("profiles").insert({
      user_id: userId,
      organization_id: org.id,
      role: "admin",
      full_name: `${orgName} admin`,
    });
    if (prErr) return await fail(`Profile: ${prErr.message}`);

    return {
      ok: true,
      message: `Created ${orgName} → ${tenantUrl(request, subdomain)} · login ${adminEmail} / ${adminPassword} · ${
        tplPrograms?.length ?? 0
      } programs seeded (event is draft — the admin signs in and publishes).`,
    };
  }

  if (intent === "resync_programs") {
    const subdomain = String(fd.get("subdomain") ?? "")
      .trim()
      .toLowerCase();
    const { data: org } = await svc
      .from("organizations")
      .select("id")
      .eq("subdomain", subdomain)
      .maybeSingle();
    if (!org) return { error: `No tenant “${subdomain}”.` };
    const { data: ev } = await svc
      .from("events")
      .select("id")
      .eq("organization_id", org.id)
      .eq("is_current", true)
      .maybeSingle();
    if (!ev) return { error: `Tenant “${subdomain}” has no current event.` };

    const { data: tplOrg } = await svc
      .from("organizations")
      .select("id")
      .eq("subdomain", TEMPLATE_SUBDOMAIN)
      .maybeSingle();
    const { data: tplEvent } = tplOrg
      ? await svc
          .from("events")
          .select("id")
          .eq("organization_id", tplOrg.id)
          .eq("is_current", true)
          .maybeSingle()
      : { data: null };
    if (!tplEvent) return { error: "Template event not found." };

    const [{ data: tplLevels }, { data: tplPrograms }, { data: curLevels }, { data: curPrograms }] =
      await Promise.all([
        svc.from("levels").select("code, name_ml, sort_order").eq("event_id", tplEvent.id),
        svc
          .from("programs")
          .select("code, name_ml, name_en, sort_order, level_id")
          .eq("event_id", tplEvent.id),
        svc.from("levels").select("id, code").eq("event_id", ev.id),
        svc.from("programs").select("code").eq("event_id", ev.id),
      ]);

    const curLevelByCode = new Map(
      (curLevels ?? []).map((l) => [l.code, l.id]),
    );
    const missingLevels = (tplLevels ?? []).filter(
      (l) => !curLevelByCode.has(l.code),
    );
    if (missingLevels.length) {
      const { data: ins } = await svc
        .from("levels")
        .insert(
          missingLevels.map((l) => ({
            event_id: ev.id,
            code: l.code,
            name_ml: l.name_ml,
            sort_order: l.sort_order,
          })),
        )
        .select("id, code");
      for (const nl of ins ?? []) curLevelByCode.set(nl.code, nl.id);
    }
    const tplLevelCodeById = new Map(
      (await svc.from("levels").select("id, code").eq("event_id", tplEvent.id)).data?.map(
        (l) => [l.id, l.code],
      ) ?? [],
    );
    const haveProgram = new Set((curPrograms ?? []).map((p) => p.code));
    const missingPrograms = (tplPrograms ?? []).filter(
      (p) => !haveProgram.has(p.code),
    );
    if (missingPrograms.length) {
      const { error: pErr } = await svc.from("programs").insert(
        missingPrograms.map((p) => ({
          event_id: ev.id,
          code: p.code,
          name_ml: p.name_ml,
          name_en: p.name_en,
          sort_order: p.sort_order,
          level_id: p.level_id
            ? curLevelByCode.get(tplLevelCodeById.get(p.level_id) ?? "") ?? null
            : null,
          is_active: true,
        })),
      );
      if (pErr) return { error: `Programs: ${pErr.message}` };
    }
    return {
      ok: true,
      message: `Synced ${subdomain}: +${missingLevels.length} levels, +${missingPrograms.length} programs.`,
    };
  }

  return { error: `Unknown intent: ${intent}` };
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "published"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
      : status === "draft"
      ? "bg-amber-50 text-amber-700 ring-amber-600/25"
      : "bg-stone-100 text-stone-500 ring-stone-400/20";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ring-1 ring-inset ${tone}`}
    >
      <span className="size-1.5 rounded-full bg-current opacity-70" />
      {status}
    </span>
  );
}

const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E\")";

export default function OwnerConsole({ loaderData }: Route.ComponentProps) {
  const { tenants, rootDomain } = loaderData;
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  const field =
    "w-full rounded-lg border border-stone-300/80 bg-white px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 transition focus:outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-600/10";
  const lbl =
    "block text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500";

  const liveCount = tenants.filter(
    (t) => t.event?.status === "published",
  ).length;

  return (
    <div className="relative min-h-dvh bg-[#F7F4EC] text-stone-900">
      <style>{`@keyframes ownerRise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}.o-rise{animation:ownerRise .7s cubic-bezier(.2,.7,.2,1) both}`}</style>
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-0 opacity-[0.04] mix-blend-multiply"
        style={{ backgroundImage: GRAIN }}
      />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          background:
            "radial-gradient(880px 460px at 80% -10%, rgba(200,162,74,0.12), transparent 60%)",
        }}
      />

      {/* ── Masthead ── */}
      <header className="sticky top-0 z-30 bg-[#1B1714] text-[#EDE6D8]">
        <div className="mx-auto flex max-w-[1240px] items-center justify-between gap-6 px-8 py-4">
          <div className="flex items-center gap-4">
            <div className="grid size-9 place-items-center rounded-md border border-[#C8A24A]/40 bg-[#C8A24A]/10 font-[Fraunces,serif] text-lg leading-none text-[#E8C879]">
              സ
            </div>
            <div className="leading-tight">
              <p className="text-[10px] font-semibold uppercase tracking-[0.34em] text-[#C8A24A]">
                Sahityotsav
              </p>
              <p className="font-[Fraunces,serif] text-[15px] tracking-tight text-[#F4EEE0]">
                Owner console
              </p>
            </div>
          </div>
          <div className="flex items-center gap-5">
            <span className="hidden text-xs text-[#9b9080] sm:inline">
              {tenants.length} sector{tenants.length === 1 ? "" : "s"} ·{" "}
              <span className="text-[#C8A24A]">{liveCount} live</span>
            </span>
            <Form method="post">
              <button
                type="submit"
                name="intent"
                value="logout"
                className="rounded-md border border-[#3a322b] px-3 py-1.5 text-xs font-medium text-[#cfc5b3] transition hover:border-[#C8A24A]/50 hover:text-[#F4EEE0]"
              >
                Sign out
              </button>
            </Form>
          </div>
        </div>
        <div className="h-px w-full bg-gradient-to-r from-transparent via-[#C8A24A]/55 to-transparent" />
      </header>

      <main className="relative z-10 mx-auto max-w-[1240px] px-8 pb-24 pt-12">
        {/* ── Title ── */}
        <div className="o-rise">
          <p className="flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.28em] text-brand-700">
            <span className="h-px w-8 bg-brand-700/50" />
            Tenancy
          </p>
          <h1 className="mt-3 font-[Fraunces,serif] text-[2.6rem] font-semibold leading-none tracking-tight text-stone-900">
            Tenants
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-stone-500">
            Every sector runs on its own subdomain from a single deployment.
            Provision a sector, seed its canonical programs, and hand its
            admin the keys — all from this desk.
          </p>
        </div>

        {actionData && "error" in actionData && (
          <div className="o-rise mt-7 rounded-xl border border-red-200 bg-red-50/80 px-5 py-3.5 text-sm text-red-800">
            {actionData.error}
          </div>
        )}
        {actionData && "ok" in actionData && (
          <div className="o-rise mt-7 rounded-xl border border-emerald-200 bg-emerald-50/80 px-5 py-3.5 text-sm leading-relaxed text-emerald-800">
            {actionData.message}
          </div>
        )}

        {/* ── Tenants ledger ── */}
        <section
          className="o-rise mt-9 overflow-hidden rounded-2xl border border-stone-200/80 bg-white shadow-[0_18px_44px_-28px_rgba(28,23,20,0.28)]"
          style={{ animationDelay: ".05s" }}
        >
          <div className="flex items-center justify-between border-b border-stone-100 px-6 py-4">
            <h2 className="font-[Fraunces,serif] text-lg tracking-tight">
              Active sectors
            </h2>
            <span className="rounded-full bg-stone-100 px-2.5 py-1 text-[11px] font-medium tabular-nums text-stone-500">
              {tenants.length}
            </span>
          </div>
          {tenants.length === 0 ? (
            <p className="px-6 py-16 text-center text-sm text-stone-400">
              No sectors yet — provision the first one below.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-[0.16em] text-stone-400">
                    <th className="w-14 py-3 pl-6 pr-3 font-semibold">#</th>
                    <th className="px-3 py-3 font-semibold">Sector</th>
                    <th className="px-3 py-3 font-semibold">Address</th>
                    <th className="px-3 py-3 font-semibold">Current event</th>
                    <th className="px-3 py-3 pr-6 font-semibold">Admin</th>
                  </tr>
                </thead>
                <tbody>
                  {tenants.map((t, i) => (
                    <tr
                      key={t.subdomain ?? t.name}
                      className="group border-t border-stone-100 align-top transition-colors hover:bg-[#FBF8F1]"
                    >
                      <td className="py-5 pl-6 pr-3 font-[Fraunces,serif] text-base tabular-nums text-stone-300">
                        {String(i + 1).padStart(2, "0")}
                      </td>
                      <td className="px-3 py-5">
                        <div className="font-medium text-stone-900">
                          {t.name}
                        </div>
                        {t.subdomain && (
                          <div className="mt-0.5 font-mono text-[11px] text-stone-400">
                            {t.subdomain}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-5">
                        {t.url ? (
                          <a
                            href={t.url}
                            className="font-mono text-[12.5px] text-brand-700 underline-offset-2 hover:underline break-all"
                          >
                            {t.url.replace(/^https?:\/\//, "")}
                          </a>
                        ) : (
                          <span className="text-stone-300">— not set —</span>
                        )}
                      </td>
                      <td className="px-3 py-5">
                        {t.event ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusPill status={t.event.status} />
                            <span className="text-stone-700">
                              {t.event.name}
                            </span>
                          </div>
                        ) : (
                          <span className="text-stone-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-5 pr-6">
                        {t.adminEmail ? (
                          <div className="space-y-1.5">
                            <div className="font-mono text-[12.5px] text-stone-700 break-all">
                              {t.adminEmail}
                            </div>
                            {t.adminUserId && (
                              <Form method="post">
                                <input
                                  type="hidden"
                                  name="intent"
                                  value="reset_admin_password"
                                />
                                <input
                                  type="hidden"
                                  name="user_id"
                                  value={t.adminUserId}
                                />
                                <input
                                  type="hidden"
                                  name="email"
                                  value={t.adminEmail}
                                />
                                <button
                                  type="submit"
                                  className="text-[11px] font-medium text-stone-400 underline decoration-dotted underline-offset-4 transition hover:text-brand-700"
                                >
                                  Reset password
                                </button>
                              </Form>
                            )}
                          </div>
                        ) : (
                          <span className="text-stone-300">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── Work area ── */}
        <div className="mt-8 grid gap-6 lg:grid-cols-12">
          <section
            className="o-rise rounded-2xl border border-stone-200/80 bg-white p-7 shadow-[0_18px_44px_-30px_rgba(28,23,20,0.25)] lg:col-span-7"
            style={{ animationDelay: ".1s" }}
          >
            <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-brand-700">
              <span className="size-1.5 rotate-45 bg-brand-700/60" />
              Provision
            </p>
            <h2 className="mt-2.5 font-[Fraunces,serif] text-2xl tracking-tight">
              Create a tenant
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-stone-500">
              Creates the org + a draft event, clones canonical levels &amp;
              programs from{" "}
              <code className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[12px] text-stone-700">
                {TEMPLATE_SUBDOMAIN}
              </code>
              , and mints the admin login.
            </p>
            <Form method="post" className="mt-6 grid gap-5 sm:grid-cols-2">
              <input type="hidden" name="intent" value="create_tenant" />
              <label className="space-y-1.5">
                <span className={lbl}>Sector / org name</span>
                <input
                  name="org_name"
                  required
                  className={field}
                  placeholder="SSF Valanchery Sector"
                />
              </label>
              <label className="space-y-1.5">
                <span className={lbl}>Subdomain</span>
                <input
                  name="subdomain"
                  required
                  className={`${field} font-mono`}
                  placeholder="valanchery"
                  pattern="[a-z0-9-]+"
                />
              </label>
              <label className="space-y-1.5">
                <span className={lbl}>Event name</span>
                <input
                  name="event_name"
                  required
                  className={field}
                  placeholder="Saaheethyolsav 26"
                />
              </label>
              <label className="space-y-1.5">
                <span className={lbl}>Event name · Malayalam</span>
                <input
                  name="event_name_ml"
                  className={field}
                  lang="ml"
                  placeholder="optional"
                />
              </label>
              <label className="space-y-1.5">
                <span className={lbl}>Admin email</span>
                <input
                  name="admin_email"
                  type="email"
                  required
                  className={`${field} font-mono`}
                  placeholder="admin@example.com"
                />
              </label>
              <label className="space-y-1.5">
                <span className={lbl}>Admin initial password</span>
                <input
                  name="admin_password"
                  type="text"
                  required
                  minLength={6}
                  className={`${field} font-mono`}
                  placeholder="≥ 6 chars"
                />
              </label>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1 sm:col-span-2">
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-lg bg-brand-700 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-800 disabled:opacity-50"
                >
                  {busy ? "Creating…" : "Create tenant"}
                </button>
                <span className="text-xs text-stone-400">
                  Admin signs in at{" "}
                  <span className="font-mono text-stone-500">
                    &lt;subdomain&gt;.{rootDomain}/admin
                  </span>
                </span>
              </div>
            </Form>
          </section>

          <div className="space-y-6 lg:col-span-5">
            <section
              className="o-rise rounded-2xl border border-stone-200/80 bg-white p-7 shadow-[0_18px_44px_-30px_rgba(28,23,20,0.25)]"
              style={{ animationDelay: ".15s" }}
            >
              <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-brand-700">
                <span className="size-1.5 rotate-45 bg-brand-700/60" />
                Maintain
              </p>
              <h2 className="mt-2.5 font-[Fraunces,serif] text-2xl tracking-tight">
                Re-sync programs
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-stone-500">
                Idempotently adds any canonical levels / programs missing
                from a tenant's current event. Existing rows are untouched.
              </p>
              <Form method="post" className="mt-6 space-y-4">
                <input type="hidden" name="intent" value="resync_programs" />
                <label className="space-y-1.5">
                  <span className={lbl}>Tenant subdomain</span>
                  <input
                    name="subdomain"
                    required
                    className={`${field} font-mono`}
                    placeholder="valanchery"
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy}
                  className="w-full rounded-lg border border-stone-300 px-4 py-2.5 text-sm font-semibold text-stone-800 transition hover:border-stone-400 hover:bg-stone-50 disabled:opacity-50"
                >
                  {busy ? "Syncing…" : "Re-sync canonical programs"}
                </button>
              </Form>
            </section>

            <section
              className="o-rise rounded-2xl border border-dashed border-stone-300 bg-[#FBF8F1] p-7"
              style={{ animationDelay: ".2s" }}
            >
              <p className="font-[Fraunces,serif] text-base tracking-tight text-stone-800">
                How provisioning flows
              </p>
              <ol className="mt-4 space-y-3 text-sm text-stone-600">
                {[
                  "Owner creates the sector here — org, draft event, seeded programs, admin login.",
                  "Sector admin signs in, imports results, and hits Publish.",
                  "The public reads it at the sector's own subdomain.",
                ].map((step, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="grid size-5 shrink-0 place-items-center rounded-full bg-brand-700/10 font-[Fraunces,serif] text-[11px] text-brand-700">
                      {i + 1}
                    </span>
                    <span className="leading-relaxed">{step}</span>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
