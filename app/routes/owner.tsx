import {
  Form,
  Link,
  data,
  redirect,
  useActionData,
  useNavigation,
  useSearchParams,
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
    .select("id, name, subdomain, org_level, created_at")
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
      level: (o.org_level as string | null) ?? null,
      subdomain: sub,
      url: sub ? tenantUrl(request, sub) : null,
      event: ev ? { name: ev.name, status: ev.status } : null,
      adminEmail: adminUserId
        ? emailById.get(adminUserId) ?? null
        : null,
      adminUserId,
    };
  });

  // Pending access requests submitted from the apex landing form.
  const { data: pendingReqs } = await svc
    .from("access_requests")
    .select("id, name, mobile, organization_name, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  return data({
    tenants,
    rootDomain: ROOT_DOMAIN,
    accessRequests: (pendingReqs ?? []) as {
      id: string;
      name: string;
      mobile: string;
      organization_name: string;
      created_at: string;
    }[],
  });
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

  if (intent === "process_access_request") {
    const id = String(fd.get("request_id") ?? "").trim();
    const decision = String(fd.get("decision") ?? "").trim();
    if (!id) return { error: "Missing request id." };
    if (decision === "delete") {
      const { error } = await svc.from("access_requests").delete().eq("id", id);
      if (error) return { error: error.message };
      return { ok: true, message: "Request deleted." };
    }
    const next =
      decision === "approve"
        ? "approved"
        : decision === "reject"
          ? "rejected"
          : null;
    if (!next) return { error: "Unknown decision." };
    const { error } = await svc
      .from("access_requests")
      .update({ status: next })
      .eq("id", id);
    if (error) return { error: error.message };
    return {
      ok: true,
      message: next === "approved" ? "Request approved." : "Request rejected.",
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
    // Set when the owner started provisioning via the Approve link on
    // a pending access request. The row stays 'pending' until every
    // step below succeeds, so a failed/rolled-back attempt is fully
    // resumable from the same Approve link.
    const requestId = String(fd.get("request_id") ?? "").trim();
    const orgLevel = (() => {
      const v = String(fd.get("org_level") ?? "")
        .trim()
        .toLowerCase();
      return ["unit", "sector", "division", "district"].includes(v)
        ? v
        : "unit";
    })();

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
        .select("code, name_ml, name_en, sort_order, level_id")
        // Seed only the canonical ACTIVE programs — the template's own
        // per-program deactivations must not propagate to new tenants.
        .eq("event_id", tplEvent.id)
        .eq("is_active", true),
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
      .insert({ slug: subdomain, name: orgName, subdomain, org_level: orgLevel })
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
          is_active: true,
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

    // 6. Provisioning succeeded — only now flip the originating access
    // request to 'approved'. Best-effort: a failure here does NOT
    // unroll the tenant (the tenant exists and is usable); we just
    // log the message in the success banner so the owner can clean
    // the request up by hand.
    let requestNote = "";
    if (requestId) {
      const { error: reqErr } = await svc
        .from("access_requests")
        .update({ status: "approved" })
        .eq("id", requestId);
      if (reqErr) {
        requestNote = ` · ⚠ couldn't mark the access request approved (${reqErr.message})`;
      }
    }

    return {
      ok: true,
      message: `Created ${orgName} → ${tenantUrl(request, subdomain)} · login ${adminEmail} / ${adminPassword} · ${
        tplPrograms?.length ?? 0
      } programs seeded (event is draft — the admin signs in and publishes).${requestNote}`,
    };
  }

  if (intent === "delete_organization") {
    const subdomain = String(fd.get("subdomain") ?? "")
      .trim()
      .toLowerCase();
    const confirm = String(fd.get("confirm_subdomain") ?? "")
      .trim()
      .toLowerCase();
    if (!subdomain) return { error: "Missing subdomain." };
    if (subdomain === TEMPLATE_SUBDOMAIN)
      return {
        error: `Refusing to delete the template tenant (“${TEMPLATE_SUBDOMAIN}”) — every new tenant clones its programs from it.`,
      };
    if (subdomain !== confirm)
      return {
        error: `Confirmation didn't match — type “${subdomain}” exactly to delete the tenant.`,
      };

    // 1. Resolve the org
    const { data: org } = await svc
      .from("organizations")
      .select("id, name")
      .eq("subdomain", subdomain)
      .maybeSingle();
    if (!org)
      return { error: `No tenant “${subdomain}” to delete.` };

    // 2. Collect everything we'll need to nuke before the FK chain
    //    is broken: event ids (for storage prefixes + cascade) and
    //    admin user ids (auth.users isn't FK-linked, must delete
    //    explicitly via the admin API).
    const { data: events } = await svc
      .from("events")
      .select("id")
      .eq("organization_id", org.id);
    const eventIds = (events ?? []).map((e) => e.id);

    const { data: profs } = await svc
      .from("profiles")
      .select("user_id")
      .eq("organization_id", org.id);
    const userIds = Array.from(
      new Set((profs ?? []).map((p) => p.user_id).filter(Boolean) as string[]),
    );

    // 3. Storage cleanup — best-effort. We list each event's prefix in
    //    the `posters` bucket and remove the children, plus the
    //    `final/<event>.{png,jpg,jpeg,webp}` single-file outputs.
    //    Any failure here is logged into a tail note but doesn't abort
    //    the row deletes (orphaned files are at worst a few MB).
    const storageNotes: string[] = [];
    for (const eid of eventIds) {
      for (const prefix of [
        `templates/${eid}`,
        `templates/standings/${eid}`,
      ]) {
        try {
          const { data: items, error } = await svc.storage
            .from("posters")
            .list(prefix, { limit: 1000 });
          if (error) {
            storageNotes.push(`list ${prefix}: ${error.message}`);
            continue;
          }
          const paths = (items ?? [])
            .filter((it) => it.name && !it.name.startsWith("."))
            .map((it) => `${prefix}/${it.name}`);
          if (paths.length) {
            const { error: rmErr } = await svc.storage
              .from("posters")
              .remove(paths);
            if (rmErr) storageNotes.push(`remove ${prefix}: ${rmErr.message}`);
          }
        } catch (e) {
          storageNotes.push(`list ${prefix}: ${String(e)}`);
        }
      }
      // Final-poster object lives at `final/<event_id>.<ext>` (one
      // per event). Try the known image extensions; missing files
      // are silently ignored by Supabase Storage.
      try {
        await svc.storage
          .from("posters")
          .remove([
            `final/${eid}.png`,
            `final/${eid}.jpg`,
            `final/${eid}.jpeg`,
            `final/${eid}.webp`,
          ]);
      } catch (e) {
        storageNotes.push(`final ${eid}: ${String(e)}`);
      }
    }

    // 4. Delete events. FK cascades wipe levels, programs, results,
    //    result_winners, team_standings and posters in one statement.
    if (eventIds.length) {
      const { error: evErr } = await svc
        .from("events")
        .delete()
        .in("id", eventIds);
      if (evErr) return { error: `Events: ${evErr.message}` };
    }

    // 5. Profiles for this org (FK to organizations is RESTRICT, so
    //    these must go before the org row itself).
    const { error: prErr } = await svc
      .from("profiles")
      .delete()
      .eq("organization_id", org.id);
    if (prErr) return { error: `Profiles: ${prErr.message}` };

    // 6. The org row. `admin_invitations` cascades automatically.
    const { error: oErr } = await svc
      .from("organizations")
      .delete()
      .eq("id", org.id);
    if (oErr) return { error: `Organization: ${oErr.message}` };

    // 7. Auth users — only delete ones that have no remaining
    //    profile rows (defensive: in theory a user could be bound to
    //    multiple orgs; we never want to break the others).
    let deletedUsers = 0;
    for (const uid of userIds) {
      const { count } = await svc
        .from("profiles")
        .select("user_id", { count: "exact", head: true })
        .eq("user_id", uid);
      if ((count ?? 0) > 0) continue;
      const { error: uErr } = await svc.auth.admin.deleteUser(uid);
      if (!uErr) deletedUsers++;
      else storageNotes.push(`auth.user ${uid}: ${uErr.message}`);
    }

    const tail = storageNotes.length
      ? ` · ⚠ ${storageNotes.length} non-blocking issue(s): ${storageNotes.slice(0, 3).join("; ")}${storageNotes.length > 3 ? "…" : ""}`
      : "";
    return {
      ok: true,
      message: `Deleted “${org.name}” (${subdomain}) — ${eventIds.length} event(s), ${userIds.length} profile(s), ${deletedUsers} auth user(s) removed.${tail}`,
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
          .eq("event_id", tplEvent.id)
          .eq("is_active", true),
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
  const { tenants, rootDomain, accessRequests } = loaderData;
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  // "Approve" mode — driven by ?approve=<request_id>. When set, the
  // Create-tenant form prefills `org_name` from that request and
  // submits a hidden `request_id` so the action flips the row to
  // 'approved' only after provisioning succeeds.
  const [searchParams] = useSearchParams();
  const approveId = searchParams.get("approve");
  const approveRequest = approveId
    ? accessRequests.find((r) => r.id === approveId) ?? null
    : null;

  // "Delete tenant" mode — driven by ?delete=<subdomain>. Shows a
  // type-to-confirm panel under Create-tenant; the action wipes the
  // org's events / profiles / org row + storage objects + auth users.
  const deleteSub = searchParams.get("delete");
  const deleteTenant = deleteSub
    ? tenants.find((t) => t.subdomain === deleteSub) ?? null
    : null;

  const field =
    "w-full rounded-md border border-stone-300/80 bg-white px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 transition focus:outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/15";
  const lbl =
    "block text-[10px] font-semibold uppercase tracking-[0.13em] text-stone-500";
  const card =
    "o-rise rounded-xl border border-stone-200/80 bg-white shadow-[0_14px_34px_-26px_rgba(28,23,20,0.3)]";

  const liveCount = tenants.filter(
    (t) => t.event?.status === "published",
  ).length;

  return (
    <div className="relative min-h-dvh bg-[#F7F4EC] text-stone-900">
      <style>{`@keyframes ownerRise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}.o-rise{animation:ownerRise .55s cubic-bezier(.2,.7,.2,1) both}`}</style>
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
            "radial-gradient(820px 420px at 82% -12%, rgba(200,162,74,0.11), transparent 60%)",
        }}
      />

      {/* ── Masthead ── */}
      <header className="sticky top-0 z-30 bg-[#1B1714] text-[#EDE6D8]">
        <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-6 px-6 py-2.5">
          <div className="flex items-center gap-3">
            <div className="grid size-7 place-items-center rounded border border-[#C8A24A]/40 bg-[#C8A24A]/10 font-[Fraunces,serif] text-sm leading-none text-[#E8C879]">
              സ
            </div>
            <p className="font-[Fraunces,serif] text-sm tracking-tight text-[#F4EEE0]">
              Sahityotsav
              <span className="ml-2 text-[11px] font-normal text-[#9b9080]">
                Owner console
              </span>
            </p>
          </div>
          <div className="flex items-center gap-4">
            <span className="hidden text-xs text-[#9b9080] sm:inline">
              {tenants.length} org{tenants.length === 1 ? "" : "s"} ·{" "}
              <span className="text-[#C8A24A]">{liveCount} live</span>
            </span>
            <Form method="post">
              <button
                type="submit"
                name="intent"
                value="logout"
                className="rounded border border-[#3a322b] px-2.5 py-1 text-xs font-medium text-[#cfc5b3] transition hover:border-[#C8A24A]/50 hover:text-[#F4EEE0]"
              >
                Sign out
              </button>
            </Form>
          </div>
        </div>
        <div className="h-px w-full bg-gradient-to-r from-transparent via-[#C8A24A]/55 to-transparent" />
      </header>

      <main className="relative z-10 mx-auto max-w-[1280px] px-6 pb-12 pt-6">
        {/* ── Heading ── */}
        <div className="o-rise mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div className="flex items-baseline gap-3">
            <h1 className="font-[Fraunces,serif] text-2xl font-semibold tracking-tight">
              Tenants
            </h1>
            <span className="text-[11px] font-medium uppercase tracking-[0.2em] text-brand-700">
              Owner desk
            </span>
          </div>
          <p className="text-xs text-stone-400">
            One deployment · per-org subdomains · RLS-isolated
          </p>
        </div>

        {actionData && "error" in actionData && (
          <div className="o-rise mb-4 rounded-lg border border-red-200 bg-red-50/80 px-4 py-2.5 text-sm text-red-800">
            {actionData.error}
          </div>
        )}
        {actionData && "ok" in actionData && (
          <div className="o-rise mb-4 rounded-lg border border-emerald-200 bg-emerald-50/80 px-4 py-2.5 text-sm leading-relaxed text-emerald-800">
            {actionData.message}
          </div>
        )}

        {/* ── Pending access requests — apex form submissions ── */}
        {accessRequests.length > 0 && (
          <section
            className={`${card} o-rise mb-5 overflow-hidden`}
            style={{ animationDelay: ".05s" }}
          >
            <div className="flex items-center justify-between border-b border-stone-100 px-5 py-3">
              <h2 className="font-[Fraunces,serif] text-base tracking-tight">
                Pending access requests
              </h2>
              <span className="rounded-full bg-yellow-50 px-2 py-0.5 text-[11px] font-medium tabular-nums text-yellow-800 ring-1 ring-yellow-200">
                {accessRequests.length}
              </span>
            </div>
            <ul className="divide-y divide-stone-100">
              {accessRequests.map((r) => {
                const ts = new Date(r.created_at);
                return (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-stone-900">
                        {r.organization_name}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-stone-600">
                        {r.name} ·{" "}
                        <a
                          href={`tel:${r.mobile.replace(/\s+/g, "")}`}
                          className="font-mono text-stone-700 hover:text-brand-700"
                        >
                          {r.mobile}
                        </a>{" "}
                        ·{" "}
                        <span className="text-stone-400">
                          {ts.toLocaleString("en-IN", {
                            day: "2-digit",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      {/* Approve = jump to the Create-tenant form with
                          org_name + request_id prefilled. Status only
                          flips to 'approved' once provisioning succeeds,
                          so a half-done attempt is safely resumable. */}
                      <Link
                        to={{
                          search: `?approve=${r.id}`,
                          hash: "#create-tenant",
                        }}
                        className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                      >
                        Approve
                      </Link>
                      <Form method="post" className="contents">
                        <input
                          type="hidden"
                          name="intent"
                          value="process_access_request"
                        />
                        <input
                          type="hidden"
                          name="request_id"
                          value={r.id}
                        />
                        <button
                          type="submit"
                          name="decision"
                          value="reject"
                          disabled={busy}
                          className="rounded-md border border-stone-300 px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                        >
                          Reject
                        </button>
                        <button
                          type="submit"
                          name="decision"
                          value="delete"
                          disabled={busy}
                          onClick={(e) => {
                            if (!confirm("Delete this request?"))
                              e.preventDefault();
                          }}
                          className="rounded-md border border-stone-300 px-2 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                          title="Delete"
                          aria-label="Delete request"
                        >
                          ✕
                        </button>
                      </Form>
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="border-t border-stone-100 bg-stone-50/60 px-5 py-2 text-[11px] text-stone-500">
              Approve fills the Create-tenant form on the right with
              the organisation name. The request is only marked
              approved once provisioning succeeds, so a half-done
              attempt stays in this list and can be retried.
            </p>
          </section>
        )}

        {/* ── Side-by-side: ledger (left) · create + maintain (right) ── */}
        <div className="grid gap-5 lg:grid-cols-12 lg:items-start">
          {/* Tenants ledger */}
          <section
            className={`${card} order-2 overflow-hidden lg:col-span-7`}
            style={{ animationDelay: ".1s" }}
          >
            <div className="flex items-center justify-between border-b border-stone-100 px-5 py-3">
              <h2 className="font-[Fraunces,serif] text-base tracking-tight">
                Active organizations
              </h2>
              <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-medium tabular-nums text-stone-500">
                {tenants.length}
              </span>
            </div>
            {tenants.length === 0 ? (
              <p className="px-5 py-12 text-center text-sm text-stone-400">
                No organizations yet — create the first one →
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-[0.14em] text-stone-400">
                      <th className="w-9 py-2.5 pl-5 pr-2 font-semibold">#</th>
                      <th className="px-3 py-2.5 font-semibold">
                        Organization
                      </th>
                      <th className="px-3 py-2.5 font-semibold">Event</th>
                      <th className="px-3 py-2.5 pr-5 font-semibold">Admin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tenants.map((t, i) => (
                      <tr
                        key={t.subdomain ?? t.name}
                        className="border-t border-stone-100 align-top transition-colors hover:bg-[#FBF8F1]"
                      >
                        <td className="py-3 pl-5 pr-2 font-[Fraunces,serif] text-xs tabular-nums text-stone-300">
                          {String(i + 1).padStart(2, "0")}
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-stone-900">
                              {t.name}
                            </span>
                            {t.level && (
                              <span className="rounded border border-stone-200 bg-stone-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-stone-500">
                                {t.level}
                              </span>
                            )}
                          </div>
                          {t.url ? (
                            <a
                              href={t.url}
                              className="mt-0.5 block font-mono text-[11px] text-brand-700 hover:underline break-all"
                            >
                              {t.url.replace(/^https?:\/\//, "")}
                            </a>
                          ) : (
                            <span className="text-[11px] text-stone-300">
                              — not set —
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          {t.event ? (
                            <div className="space-y-1">
                              <StatusPill status={t.event.status} />
                              <div className="text-[12px] text-stone-600">
                                {t.event.name}
                              </div>
                            </div>
                          ) : (
                            <span className="text-stone-300">—</span>
                          )}
                        </td>
                        <td className="px-3 py-3 pr-5">
                          {t.adminEmail ? (
                            <div className="space-y-1">
                              <div className="font-mono text-[11.5px] text-stone-700 break-all">
                                {t.adminEmail}
                              </div>
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
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
                                {t.subdomain &&
                                  t.subdomain !== TEMPLATE_SUBDOMAIN && (
                                    <Link
                                      to={{
                                        search: `?delete=${t.subdomain}`,
                                        hash: "#delete-tenant",
                                      }}
                                      className="text-[11px] font-medium text-red-500 underline decoration-dotted underline-offset-4 transition hover:text-red-700"
                                    >
                                      Delete tenant
                                    </Link>
                                  )}
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-1">
                              <span className="text-stone-300">—</span>
                              {t.subdomain &&
                                t.subdomain !== TEMPLATE_SUBDOMAIN && (
                                  <Link
                                    to={{
                                      search: `?delete=${t.subdomain}`,
                                      hash: "#delete-tenant",
                                    }}
                                    className="block text-[11px] font-medium text-red-500 underline decoration-dotted underline-offset-4 transition hover:text-red-700"
                                  >
                                    Delete tenant
                                  </Link>
                                )}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Create + maintain */}
          <div className="order-1 space-y-5 lg:col-span-5">
            <section
              id="create-tenant"
              className={`${card} p-5 scroll-mt-6`}
              style={{ animationDelay: ".04s" }}
            >
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="font-[Fraunces,serif] text-lg tracking-tight">
                  Create tenant
                </h2>
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-brand-700">
                  Provision
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-stone-500">
                Clones programs from{" "}
                <code className="rounded bg-stone-100 px-1 py-0.5 font-mono text-[11px] text-stone-700">
                  {TEMPLATE_SUBDOMAIN}
                </code>{" "}
                → admin at{" "}
                <span className="font-mono">
                  &lt;sub&gt;.{rootDomain}/admin
                </span>
              </p>
              {approveRequest && (
                <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2.5 text-xs leading-relaxed text-emerald-900">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold">
                        Approving request from{" "}
                        <span className="font-mono">
                          {approveRequest.organization_name}
                        </span>
                      </p>
                      <p className="mt-0.5 text-emerald-800/80">
                        {approveRequest.name} ·{" "}
                        <a
                          href={`tel:${approveRequest.mobile.replace(/\s+/g, "")}`}
                          className="font-mono underline-offset-2 hover:underline"
                        >
                          {approveRequest.mobile}
                        </a>
                      </p>
                    </div>
                    <Link
                      to={{ search: "", hash: "" }}
                      className="shrink-0 rounded-md border border-emerald-200 bg-white px-2 py-1 text-[11px] font-medium text-emerald-800 hover:bg-emerald-50"
                    >
                      Cancel
                    </Link>
                  </div>
                </div>
              )}
              {/* `key` remounts the form when the approved request
                  changes, so the controlled defaultValue actually
                  re-seeds the input. */}
              <Form
                method="post"
                className="mt-4 grid gap-3 sm:grid-cols-2"
                key={approveRequest?.id ?? "blank"}
              >
                <input type="hidden" name="intent" value="create_tenant" />
                {approveRequest && (
                  <input
                    type="hidden"
                    name="request_id"
                    value={approveRequest.id}
                  />
                )}
                <label className="space-y-1">
                  <span className={lbl}>Organization name</span>
                  <input
                    name="org_name"
                    required
                    defaultValue={approveRequest?.organization_name ?? ""}
                    className={field}
                    placeholder="SSF Pantharangadi Sector"
                  />
                </label>
                <label className="space-y-1">
                  <span className={lbl}>Level</span>
                  <select
                    name="org_level"
                    defaultValue="unit"
                    className={field}
                  >
                    <option value="unit">Unit</option>
                    <option value="sector">Sector</option>
                    <option value="division">Division</option>
                    <option value="district">District</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className={lbl}>Subdomain</span>
                  <input
                    name="subdomain"
                    required
                    className={`${field} font-mono`}
                    placeholder="pantharangadi"
                    pattern="[a-z0-9-]+"
                  />
                </label>
                <label className="space-y-1">
                  <span className={lbl}>Event name</span>
                  <input
                    name="event_name"
                    required
                    className={field}
                    placeholder="Saaheethyolsav 26"
                  />
                </label>
                <label className="space-y-1">
                  <span className={lbl}>Event · Malayalam</span>
                  <input
                    name="event_name_ml"
                    className={field}
                    lang="ml"
                    placeholder="optional"
                  />
                </label>
                <label className="space-y-1">
                  <span className={lbl}>Admin email</span>
                  <input
                    name="admin_email"
                    type="email"
                    required
                    className={`${field} font-mono`}
                    placeholder="admin@example.com"
                  />
                </label>
                <label className="space-y-1">
                  <span className={lbl}>Admin password</span>
                  <input
                    name="admin_password"
                    type="text"
                    required
                    minLength={6}
                    className={`${field} font-mono`}
                    placeholder="≥ 6 chars"
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy}
                  className="mt-1 rounded-md bg-brand-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-800 disabled:opacity-50 sm:col-span-2"
                >
                  {busy ? "Creating…" : "Create tenant"}
                </button>
              </Form>
            </section>

            {/* Delete tenant — surfaces only when ?delete=<sub> is in
                the URL (set by the per-row Delete link). Mirrors the
                Approve panel shape but in a destructive red palette
                with a type-the-subdomain confirmation. */}
            {deleteTenant && (
              <section
                id="delete-tenant"
                className={`${card} border-red-200 p-5 scroll-mt-6`}
                style={{ animationDelay: ".05s" }}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h2 className="font-[Fraunces,serif] text-lg tracking-tight text-red-700">
                    Delete tenant
                  </h2>
                  <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-red-700">
                    Destructive
                  </span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-stone-600">
                  Permanently removes <strong>{deleteTenant.name}</strong>
                  {deleteTenant.subdomain && (
                    <>
                      {" "}
                      (
                      <code className="rounded bg-stone-100 px-1 py-0.5 font-mono text-[11px] text-stone-700">
                        {deleteTenant.subdomain}
                      </code>
                      )
                    </>
                  )}{" "}
                  — every event, every result, every uploaded template,
                  the admin login, and all storage objects under{" "}
                  <code className="rounded bg-stone-100 px-1 py-0.5 font-mono text-[10px] text-stone-700">
                    posters/templates/&lt;event&gt;
                  </code>{" "}
                  and{" "}
                  <code className="rounded bg-stone-100 px-1 py-0.5 font-mono text-[10px] text-stone-700">
                    posters/final/&lt;event&gt;.*
                  </code>
                  . This cannot be undone.
                </p>
                <Form
                  method="post"
                  className="mt-4 space-y-3"
                  key={deleteTenant.subdomain ?? "none"}
                >
                  <input
                    type="hidden"
                    name="intent"
                    value="delete_organization"
                  />
                  <input
                    type="hidden"
                    name="subdomain"
                    value={deleteTenant.subdomain ?? ""}
                  />
                  <label className="block space-y-1">
                    <span className={lbl}>
                      Type{" "}
                      <code className="rounded bg-stone-100 px-1 py-0.5 font-mono text-[11px] text-stone-700">
                        {deleteTenant.subdomain}
                      </code>{" "}
                      to confirm
                    </span>
                    <input
                      name="confirm_subdomain"
                      required
                      autoComplete="off"
                      className={`${field} font-mono`}
                      placeholder={deleteTenant.subdomain ?? ""}
                    />
                  </label>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Link
                      to={{ search: "", hash: "" }}
                      className="rounded-md border border-stone-300 px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50"
                    >
                      Cancel
                    </Link>
                    <button
                      type="submit"
                      disabled={busy}
                      onClick={(e) => {
                        if (
                          !confirm(
                            `Permanently delete “${deleteTenant.name}”? This wipes every event, result and admin login for the tenant.`,
                          )
                        )
                          e.preventDefault();
                      }}
                      className="rounded-md bg-red-600 px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-red-700 disabled:opacity-50"
                    >
                      {busy ? "Deleting…" : "Permanently delete"}
                    </button>
                  </div>
                </Form>
              </section>
            )}

            <section
              className={`${card} p-5`}
              style={{ animationDelay: ".08s" }}
            >
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="font-[Fraunces,serif] text-lg tracking-tight">
                  Re-sync programs
                </h2>
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-brand-700">
                  Maintain
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-stone-500">
                Adds any canonical levels/programs missing from a tenant's
                current event. Existing rows untouched.
              </p>
              <Form
                method="post"
                className="mt-4 flex flex-wrap items-end gap-3"
              >
                <input type="hidden" name="intent" value="resync_programs" />
                <label className="flex-1 space-y-1">
                  <span className={lbl}>Tenant subdomain</span>
                  <input
                    name="subdomain"
                    required
                    className={`${field} font-mono`}
                    placeholder="pantharangadi"
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-md border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-800 transition hover:border-stone-400 hover:bg-stone-50 disabled:opacity-50"
                >
                  {busy ? "Syncing…" : "Re-sync"}
                </button>
              </Form>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
