import { Form, data, useActionData, useNavigation } from "react-router";
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

  const tenants = (orgs ?? []).map((o) => {
    const ev = (events ?? []).find(
      (e) => e.organization_id === o.id && e.is_current,
    );
    return {
      name: o.name,
      subdomain: o.subdomain as string | null,
      event: ev ? { name: ev.name, status: ev.status } : null,
    };
  });

  return data({ tenants, rootDomain: ROOT_DOMAIN });
}

type ActionResult = { error: string } | { ok: true; message: string };

export async function action({
  request,
  context,
}: Route.ActionArgs): Promise<ActionResult> {
  await requireOwner(request, context, () => userEmail(request));
  const svc = createServiceRoleClient(context);
  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");

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
    if (adminPassword.length < 8) {
      return { error: "Admin password must be at least 8 characters." };
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
      message: `Created ${orgName} → https://${subdomain}.${ROOT_DOMAIN} · admin ${adminEmail} · ${
        tplPrograms?.length ?? 0
      } programs seeded (event is draft — admin publishes it).`,
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

export default function OwnerConsole({ loaderData }: Route.ComponentProps) {
  const { tenants, rootDomain } = loaderData;
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const field =
    "w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm focus:outline-none focus:border-stone-500";

  return (
    <div className="min-h-dvh bg-stone-50 px-4 py-10">
      <div className="mx-auto max-w-3xl space-y-8">
        <header>
          <p className="font-display text-[11px] font-bold tracking-[0.3em] uppercase text-brand-700">
            Sahityotsav · Owner
          </p>
          <h1 className="text-2xl font-semibold tracking-tight mt-1">
            Tenants
          </h1>
        </header>

        {actionData && "error" in actionData && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
            {actionData.error}
          </p>
        )}
        {actionData && "ok" in actionData && (
          <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3">
            {actionData.message}
          </p>
        )}

        <section className="rounded-xl border border-stone-200 bg-white">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-stone-400">
              <tr>
                <th className="px-4 py-3">Sector</th>
                <th className="px-4 py-3">Address</th>
                <th className="px-4 py-3">Current event</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.subdomain ?? t.name} className="border-t border-stone-100">
                  <td className="px-4 py-3 font-medium">{t.name}</td>
                  <td className="px-4 py-3">
                    {t.subdomain ? (
                      <a
                        className="text-brand-700 hover:underline"
                        href={`https://${t.subdomain}.${rootDomain}`}
                      >
                        {t.subdomain}.{rootDomain}
                      </a>
                    ) : (
                      <span className="text-stone-400">— not set —</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {t.event ? (
                      <span>
                        {t.event.name}{" "}
                        <span className="text-xs text-stone-400">
                          ({t.event.status})
                        </span>
                      </span>
                    ) : (
                      <span className="text-stone-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="rounded-xl border border-stone-200 bg-white p-6">
          <h2 className="text-lg font-semibold tracking-tight">
            Create tenant
          </h2>
          <p className="text-xs text-stone-500 mt-1">
            Provisions org + a draft current event, clones the canonical
            levels &amp; programs from{" "}
            <code className="rounded bg-stone-100 px-1.5 py-0.5">
              {TEMPLATE_SUBDOMAIN}
            </code>
            , and creates the admin login. The admin signs in at{" "}
            <code className="rounded bg-stone-100 px-1.5 py-0.5">
              {"<subdomain>"}.{rootDomain}/admin
            </code>{" "}
            and publishes when ready.
          </p>
          <Form method="post" className="mt-4 grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="intent" value="create_tenant" />
            <label className="space-y-1">
              <span className="text-xs font-medium text-stone-600">
                Sector / org name
              </span>
              <input name="org_name" required className={field} placeholder="SSF Valanchery Sector" />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-stone-600">
                Subdomain
              </span>
              <input
                name="subdomain"
                required
                className={field}
                placeholder="valanchery"
                pattern="[a-z0-9-]+"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-stone-600">
                Event name
              </span>
              <input name="event_name" required className={field} placeholder="Saaheethyolsav 26" />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-stone-600">
                Event name (Malayalam, optional)
              </span>
              <input name="event_name_ml" className={field} lang="ml" />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-stone-600">
                Admin email
              </span>
              <input
                name="admin_email"
                type="email"
                required
                className={field}
                placeholder="admin@example.com"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-stone-600">
                Admin initial password
              </span>
              <input
                name="admin_password"
                type="text"
                required
                minLength={8}
                className={field}
                placeholder="≥ 8 chars"
              />
            </label>
            <div className="sm:col-span-2">
              <button
                type="submit"
                disabled={busy}
                className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50"
              >
                {busy ? "Creating…" : "Create tenant"}
              </button>
            </div>
          </Form>
        </section>

        <section className="rounded-xl border border-stone-200 bg-white p-6">
          <h2 className="text-lg font-semibold tracking-tight">
            Re-sync canonical programs
          </h2>
          <p className="text-xs text-stone-500 mt-1">
            Idempotently adds any canonical levels/programs missing from a
            tenant's current event (existing rows untouched).
          </p>
          <Form method="post" className="mt-4 flex flex-wrap items-end gap-3">
            <input type="hidden" name="intent" value="resync_programs" />
            <label className="space-y-1">
              <span className="text-xs font-medium text-stone-600">
                Tenant subdomain
              </span>
              <input name="subdomain" required className={field} placeholder="valanchery" />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="rounded-md border border-stone-300 px-4 py-2 text-sm font-medium hover:bg-stone-50 disabled:opacity-50"
            >
              {busy ? "Syncing…" : "Re-sync"}
            </button>
          </Form>
        </section>
      </div>
    </div>
  );
}
