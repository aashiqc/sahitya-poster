# Sahitya Poster — Implementation Plan (Simplified, Free-Tier)

> **Project:** Sahityotsav (SSF Saaheethyolsav) event-result display & automatic poster generation app.
> **Source docs:** `compass_artifact_…_text_markdown.md` (architecture research) and `DEVELOPER_GUIDE.md` (phased build guide).
> **Decision (2026-05-11):** Free-tier-only architecture. Browser-side poster rendering. No render worker, no edge API, no queues. **Target cost: $0/month.**
> **Stack:** React Router v7 + Vite + Konva + Tailwind + Supabase + Cloudflare Pages.
> **Owner:** muhammed@appmaker.xyz

---

## 1. The Core Simplification

The research docs design a 4-service architecture (web app + edge worker + render container + queue). That's correct for scale, but overkill for this project. We're collapsing to **one service**:

```
Admin enters result data
        ↓
Browser loads template (bg image + slot JSON) from Supabase
        ↓
Browser renders the poster with Konva → exports PNG/JPG blob
        ↓
Browser uploads PNG to Supabase Storage (for shareable URL + OG preview)
        ↓
Public result page links to that PNG. Done.
```

**No backend code runs to make a poster.** The user's phone does the work. For a sector admin generating tens of posters per event, that's plenty.

### What we keep from the source docs
- Template format: flat background image + JSON slot manifest.
- Konva.js as the rendering engine (now browser-only).
- Results-first data model (Result is source of truth; poster is derived).
- Public results website with per-result share pages.
- Malayalam fidelity via self-hosted Noto Sans Malayalam.

### What we drop
- ❌ Cloudflare Workers (no API gateway — Supabase JS talks to DB directly).
- ❌ Cloudflare Queues / Postgres job table.
- ❌ Render worker / Fly.io / Node container / `@napi-rs/canvas` / `konva-node`.
- ❌ Server-side hashing / cache-key dedup.
- ❌ Realtime status updates (browser rendering is synchronous).
- ❌ Service-worker offline editor (Phase 7 in source — deferred indefinitely).
- ❌ Edge auth gate (RLS does the auth check at the DB level).

---

## 2. Goals & Non-Goals

### Goals (MVP)
1. Admin signs in, creates an event, enters results (program × level × winners 1–3).
2. On save, the browser renders a Malayalam poster using a template (random pick, with "🎲 Try another" to re-roll).
3. Admin downloads the poster (PNG/JPG) or shares it via the native share sheet.
4. Browser uploads the final PNG to Supabase Storage; the public result page embeds it with OG meta for WhatsApp link previews.
5. Public results website (SSR) lets anyone browse results by event / program / level.

### Non-goals (deferred or dropped)
- Drag-to-adjust template editor (Phase 5 of source).
- Image slots (winner photos), QR codes, conditional slot visibility.
- Bulk CSV/Excel import.
- Multi-template visual designer for admins.
- Offline editing.
- Direct WhatsApp Business API send.
- CMYK / print-shop output.
- Multi-language admin UI.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                BROWSER (Public + Admin)                      │
│  React Router v7 (Vite, SSR mode)                            │
│  Tailwind • Zustand • Konva.js (admin-only chunk)            │
│  Supabase JS client                                          │
└─────────────┬────────────────────────────────────────────────┘
              │ HTTPS (anon read for public, JWT for admin)
              ▼
              ┌──────────────────────────────────────────┐
              │              Supabase                    │
              │  Postgres  (events, results, templates)  │
              │  Auth      (admin magic-link)            │
              │  Storage   (bg images, fonts, posters)   │
              │  RLS       (public read + admin write)   │
              └──────────────────────────────────────────┘

Deploy target: Cloudflare Pages (free) for React Router app.
Domain: TBD. SSL: automatic via CF.
```

**One service. One vendor (Supabase) for everything except hosting. Hosting is free on Cloudflare Pages.**

### Why React Router v7 (over Next.js or plain Vite)

| Need | Why React Router v7 wins |
|---|---|
| SSR for public result pages (so WhatsApp/Google see proper OG meta) | RR v7 has full SSR in framework mode |
| Cloudflare Pages deployment | First-class Cloudflare adapter (`@react-router/cloudflare`) — Workers/Pages native |
| Vite DX | Built on Vite — fast dev server, no Next.js compilation tax |
| Small bundle | No RSC machinery; ships less JS than Next for our needs |
| Free tier | Cloudflare Pages free tier is generous (500 builds/month, unlimited requests) |

Next.js is the runner-up, but adds RSC complexity we won't use, and its Cloudflare Pages story is more awkward (need `@cloudflare/next-on-pages` adapter; cold-start gotchas).

Plain Vite SPA is the cheapest, but we'd lose dynamic OG meta on result pages — link previews would all look identical. Hard no for a share-driven app.

---

## 4. Tech Stack (Final)

| Layer | Choice | Notes |
|---|---|---|
| Framework | **React Router v7** (framework mode, SSR) | Vite-based, file-route conventions |
| Build | Vite 5+ | Bundled with RR v7 |
| Styling | Tailwind CSS + a handful of shadcn/ui primitives (Button, Dialog) | Mobile-first |
| Canvas | Konva.js + react-konva | Browser-only. Even though no drag editor in v1, keep Konva so adding it later is no rewrite |
| State (admin) | Zustand | Lightweight; no zundo until drag editor exists |
| Auth + DB + Storage | Supabase | One vendor for everything backend |
| Schema validation | Zod | Shared between admin form, public reads, and template manifests |
| Hosting | Cloudflare Pages | Free; deploys from GitHub |
| Fonts | Self-hosted Noto Sans Malayalam (Bold + Regular) in Supabase Storage | OFL; loaded via `FontFace` API |
| Observability | Sentry (browser SDK only) | Free tier (5k events/month) |
| CI | GitHub Actions (typecheck + lint on PR) | Free for public repos |

**Total monthly cost at MVP volume: $0.**

Free-tier ceilings to watch:
- Supabase: 500 MB DB, 1 GB storage, 50k MAU. We won't hit these.
- Cloudflare Pages: 500 builds/month, unlimited bandwidth.
- Sentry: 5k events/month. Plenty.

---

## 5. Repository Layout

Single Vite + React Router app — no monorepo needed.

```
sahitya-poster/
├── app/                          # React Router v7 conventions
│   ├── root.tsx
│   ├── entry.client.tsx
│   ├── entry.server.tsx
│   ├── routes/
│   │   ├── _public._index.tsx           # GET /  (event list)
│   │   ├── _public.e.$eventSlug.tsx     # GET /e/:eventSlug (results browse)
│   │   ├── _public.e.$eventSlug.$programSlug.$levelSlug.tsx  # single result + poster
│   │   ├── _public.r.$hash.tsx          # share landing /r/:hash
│   │   ├── admin._index.tsx             # admin home (event list)
│   │   ├── admin.login.tsx
│   │   ├── admin.events.$id.tsx         # event detail + results entry
│   │   └── admin.events.$id.results.$rid.tsx  # poster generation page
│   ├── lib/
│   │   ├── supabase.client.ts
│   │   ├── supabase.server.ts           # for loaders/actions
│   │   ├── hash.ts                      # canonical JSON + SHA-256
│   │   ├── slugify.ts
│   │   └── fonts.ts                     # FontFace loader hook
│   ├── components/
│   │   ├── ui/                          # Button, Dialog, Sheet (shadcn-style)
│   │   ├── ResultRow.tsx
│   │   ├── ResultsEntryForm.tsx
│   │   ├── PosterCanvas.tsx             # Konva stage + scene builder
│   │   └── ShareButtons.tsx
│   ├── layout/                          # shared layout/text-fit logic
│   │   ├── shrinkToFit.ts
│   │   ├── expandRepeats.ts
│   │   └── interpolate.ts
│   └── schema/                          # Zod
│       ├── template.ts
│       ├── result.ts
│       └── event.ts
├── public/                              # static assets only
├── infra/
│   └── supabase/migrations/             # SQL files
├── seed/
│   ├── template.json                    # Saaheethyolsav podium manifest
│   ├── bg-2160.png                      # background art (you'll provide)
│   └── upload.ts                        # one-shot script to push seed → Supabase
├── vite.config.ts
├── react-router.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── package.json
└── README.md
```

---

## 6. Data Model

Supabase Postgres migrations. Simpler than the previous draft — **no `render_jobs`, no `posters.status` workflow.**

```sql
-- Tenancy
create table organizations (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,                  -- 'ssf-calicut-sector'
  name          text not null,
  created_at    timestamptz not null default now()
);

create table profiles (
  user_id         uuid primary key references auth.users on delete cascade,
  organization_id uuid not null references organizations,
  role            text not null check (role in ('admin','sub_admin')),
  full_name       text
);

-- Events / programs / levels
create table events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations,
  slug            text not null,
  name            text not null,
  name_ml         text,
  starts_on       date,
  ends_on         date,
  status          text not null default 'draft'
                  check (status in ('draft','published','archived')),
  created_at      timestamptz not null default now(),
  unique (organization_id, slug)
);

create table programs (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references events on delete cascade,
  code        text not null,                           -- 'P-030'
  name_ml     text not null,
  name_en     text,
  sort_order  int not null default 0,
  unique (event_id, code)
);

create table levels (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references events on delete cascade,
  code        text not null,                           -- 'primary'
  name_ml     text not null,
  sort_order  int not null default 0,
  unique (event_id, code)
);

-- Results (source of truth)
create table results (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references events on delete cascade,
  program_id   uuid not null references programs,
  level_id     uuid not null references levels,
  result_no    text,                                   -- '030' shown on poster
  is_tie       boolean not null default false,
  status       text not null default 'draft'
               check (status in ('draft','published')),
  published_at timestamptz,
  hash         text,                                   -- canonical(result data); used in share URLs
  created_by   uuid references auth.users,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (event_id, program_id, level_id)
);

create table result_winners (
  id         uuid primary key default gen_random_uuid(),
  result_id  uuid not null references results on delete cascade,
  position   int not null check (position between 1 and 10),
  name_ml    text not null,
  name_en    text,
  unit_ml    text,
  marks      numeric,
  sort_order int not null default 0
);

-- Templates (developer-authored; uploaded once via seed script)
create table templates (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null,
  version         int not null,
  name            text not null,
  size            jsonb not null,                      -- { width, height }
  manifest        jsonb not null,                      -- full slot JSON
  bg_storage_path text not null,                       -- 'templates/ssf-podium/v1/bg-2160.png'
  preview_path    text not null,                       -- 540px preview
  status          text not null default 'published'
                  check (status in ('draft','published','archived')),
  created_at      timestamptz not null default now(),
  unique (slug, version)
);

-- Posters: browser uploads rendered PNG here; one row per generated poster
create table posters (
  id                uuid primary key default gen_random_uuid(),
  result_id         uuid not null references results on delete cascade,
  template_id       uuid not null references templates,
  template_version  int not null,
  png_storage_path  text not null,                     -- 'posters/<hash>.png'
  jpg_storage_path  text,                              -- 1080 JPG for WhatsApp
  rendered_by       uuid references auth.users,
  created_at        timestamptz not null default now()
);
create index on posters (result_id, created_at desc);
```

### Row-Level Security

```sql
-- Public reads on published rows (anon role)
alter table events            enable row level security;
alter table programs          enable row level security;
alter table levels            enable row level security;
alter table results           enable row level security;
alter table result_winners    enable row level security;
alter table templates         enable row level security;
alter table posters           enable row level security;

create policy "public read published events"
  on events for select to anon
  using (status = 'published');

create policy "public read published results"
  on results for select to anon
  using (status = 'published');

-- result_winners visible only via a published result (subquery)
create policy "public read winners of published results"
  on result_winners for select to anon
  using (exists (select 1 from results r where r.id = result_id and r.status = 'published'));

-- Admin writes scoped to their org
create policy "org admin writes own events"
  on events for all to authenticated
  using (organization_id = (select organization_id from profiles where user_id = auth.uid()))
  with check (organization_id = (select organization_id from profiles where user_id = auth.uid()));

-- Similar policies for programs/levels/results/result_winners/posters
-- Templates: read-public-published, write-admin-only (developer task in MVP)
```

### Storage buckets (Supabase Storage)

- **`templates`** (public read): `templates/{slug}/v{n}/bg-2160.png`, `templates/{slug}/v{n}/bg-540.jpg`
- **`fonts`** (public read): `fonts/NotoSansMalayalam-Bold.ttf`, `fonts/NotoSansMalayalam-Regular.ttf`
- **`posters`** (public read; admin write): `posters/{hash}.png`, `posters/{hash}.jpg`

Public read = no signed URLs needed; CDN-friendly; `Cache-Control: public, max-age=31536000, immutable` since paths are content-addressed.

---

## 7. Template Format

Same as the architecture doc, simplified. One example: `seed/template.json` for the Saaheethyolsav podium:

```json
{
  "schemaVersion": "1.0",
  "slug": "ssf-saaheethyolsav-podium",
  "version": 1,
  "name": "SSF Saaheethyolsav — Podium (3 winners)",
  "size": { "width": 2160, "height": 3000 },
  "background": {
    "fullPath": "templates/ssf-saaheethyolsav-podium/v1/bg-2160.png",
    "previewPath": "templates/ssf-saaheethyolsav-podium/v1/bg-540.jpg"
  },
  "fonts": [
    { "family": "Noto Sans Malayalam", "weight": 700, "path": "fonts/NotoSansMalayalam-Bold.ttf" },
    { "family": "Noto Sans Malayalam", "weight": 400, "path": "fonts/NotoSansMalayalam-Regular.ttf" }
  ],
  "theme": {
    "primary": "#0A6E3D",
    "accent":  "#F2C84B",
    "textOnLight": "#1A1A1A"
  },
  "slots": [
    { "id": "result_no", "type": "text", "prefix": "മത്സരഫലം ", "x": 1080, "y": 360, "width": 800, "height": 120, "fontFamily": "Noto Sans Malayalam", "fontWeight": 700, "fontSize": 72, "color": "@theme.primary", "align": "center", "shrinkToFit": { "min": 48, "max": 72 } },
    { "id": "level",     "type": "text", "prefix": "ലവൽ ",       "x": 1080, "y": 520, "width": 1400, "height": 90,  "fontFamily": "Noto Sans Malayalam", "fontWeight": 400, "fontSize": 56, "color": "@theme.textOnLight", "align": "center", "shrinkToFit": { "min": 40, "max": 60 } },
    { "id": "program",   "type": "text",                          "x": 1080, "y": 700, "width": 1800, "height": 200, "fontFamily": "Noto Sans Malayalam", "fontWeight": 700, "fontSize": 96, "color": "@theme.primary", "align": "center", "lineHeight": 1.15, "shrinkToFit": { "min": 60, "max": 96 }, "wrap": true, "maxLines": 2 },
    {
      "id": "winners", "type": "repeat", "min": 1, "max": 3,
      "x": 1080, "y": 1500, "gap": 180, "anchor": "top-center",
      "item": {
        "type": "group", "width": 1600, "height": 140,
        "children": [
          { "id": "position", "type": "text", "default": "{{index1}}", "x": -700, "y": 0, "width": 120, "height": 140, "fontFamily": "Noto Sans Malayalam", "fontWeight": 700, "fontSize": 88, "color": "@theme.accent", "align": "right" },
          { "id": "name_ml",  "type": "text",                          "x":   80, "y": 0, "width": 1400, "height": 140, "fontFamily": "Noto Sans Malayalam", "fontWeight": 600, "fontSize": 80, "color": "@theme.textOnLight", "align": "left", "shrinkToFit": { "min": 48, "max": 80 } }
        ]
      }
    }
  ]
}
```

Validated by Zod at admin-form auto-generation time and again before render. Bad manifests fail loud — no silent fallback.

---

## 8. Build Phases (3-Phase MVP)

Estimates assume 1 FTE.

### Phase A — Setup, Data Layer, Admin Auth (4 days)

**Goal:** A logged-in admin can enter results; public visitor sees them on an SSR'd page. **No poster rendering yet.**

- Create Supabase project. Run migrations from §6. Create Storage buckets.
- Scaffold React Router v7 + Vite + Tailwind project. Cloudflare Pages adapter.
- `lib/supabase.client.ts` + `lib/supabase.server.ts` (for loaders).
- Auth route: `/admin/login` with Supabase magic-link.
- Admin routes (auth-gated): event list, event create, programs/levels CRUD, results entry table.
- Public routes (SSR): home (event list), event page, single result page (without poster yet — just winners list).
- Slug helpers (`slugify.ts`) for SEO-friendly URLs.
- Sentry browser SDK wired up.
- Seed script that inserts 1 org, 1 event, 5 programs, 3 levels, 5 sample results.
- Deploy to Cloudflare Pages preview env.

**Definition of Done:**
- A new admin can sign in via magic link.
- Admin can enter a 3-winner Malayalam result and publish it.
- Public visitor (no auth) sees that result at `/e/saaheethyolsav-2026/[programSlug]/[levelSlug]`.
- 375 px viewport renders cleanly. RLS blocks cross-org writes (test with a second org's token).

### Phase B — Template + Browser Rendering (4 days)

**Goal:** When admin clicks "Generate Poster" on a result, the browser draws it with Konva, lets admin re-roll templates, and uploads the final PNG/JPG to Supabase Storage.

- Author `seed/template.json` for the Saaheethyolsav podium.
- Source the background PNG (you provide art; 2160×3000) + the 540 preview.
- `seed/upload.ts`: pushes background + fonts to Supabase Storage, inserts `templates` row.
- `app/layout/`: shared `shrinkToFit`, `expandRepeats`, `interpolate`, `evalWhen` utilities. Pure functions, fully unit-tested.
- `app/components/PosterCanvas.tsx`:
  - Loads template manifest + background + fonts.
  - `useFonts(template.fonts)` hook using `FontFace` API; triggers `stage.batchDraw()` once loaded.
  - Builds a Konva `<Stage>` from `(template, result)` data.
  - `pixelRatio` set to `2160 / template.size.width` for HD export.
  - `stage.toBlob({ mimeType: 'image/png' })` for HD; `{ mimeType: 'image/jpeg', quality: 0.92, pixelRatio: 1080 / template.size.width }` for WhatsApp.
- Admin result page (`/admin/events/[id]/results/[rid]`):
  - Renders the Konva preview at fit-to-screen scale.
  - "🎲 Try another template" button (random pick — only one template in MVP, but the mechanic is wired).
  - "Save & Generate" button: renders 2 sizes → uploads to `posters/<hash>.png` and `posters/<hash>.jpg` → inserts `posters` row.
- Hash util: SHA-256 of canonical JSON of (template_id, version, result data) — runs in browser via Web Crypto.
- Public result page now shows the poster (1080 JPG inline + "Download HD" link).

**Definition of Done:**
- Saving a result triggers a browser render that completes in <3 s on a mid-range Android.
- The generated PNG renders Malayalam conjuncts correctly (chillu ൻ, reph ർ visible in the right places).
- Long winner name (35+ Malayalam chars) auto-shrinks to fit.
- Re-saving the same result with no changes is a no-op (same hash → existing file in Storage).
- Public page embeds the poster and has `og:image` pointing at the Supabase Storage URL.

### Phase C — Sharing, Polish, Deploy (3 days)

**Goal:** Posters get shared cleanly. App is production-ready.

- Share buttons on admin + public pages:
  - `navigator.share({ url, title, text })` with file fallback (`navigator.canShare({ files })` → share the blob directly to WhatsApp).
  - Copy-link button as fallback.
- Public `/r/[hash]` route — short share URL that redirects to the canonical `/e/[event]/[program]/[level]` URL while keeping rich OG meta.
- OG meta on all public result pages: `og:image` (1080 JPG), `og:title` (program + level), `og:description` (top winner names).
- "Generate for all" button on event page: loops through published results, renders sequentially (1 at a time, ~1-2 s each), shows progress bar. 30 posters in ~45 s on a phone is acceptable.
- Lighthouse mobile pass: perf ≥ 90, a11y ≥ 95, SEO ≥ 95.
- Sentry: confirm errors flow from prod.
- Production deploy on Cloudflare Pages with custom domain.
- Smoke test on real WhatsApp: shared link shows poster preview, shared file mode preserves quality.

**Definition of Done:**
- WhatsApp link preview shows the correct poster image (manually tested on Android + iOS).
- Native share sheet works on Android Chrome and iOS Safari.
- "Generate for all" handles 30 results without crashing the tab.
- Production URL is live with HTTPS and correct OG previews.

---

## 9. Total Timeline

| Phase | Duration | Cumulative |
|---|---|---|
| Phase A — Setup + Data + Admin | 4 days | 4 d |
| Phase B — Template + Rendering | 4 days | 8 d |
| Phase C — Sharing + Deploy | 3 days | 11 d |
| **MVP shippable** | | **~2 weeks (1 FTE)** |

Realistic with buffer: **2.5–3 weeks**.

Down from ~4 weeks in the previous architecture because we deleted ~40% of the surface area (no edge worker, no render container, no queue, no service-worker plumbing).

---

## 10. Trade-offs Accepted vs Source Doc

| Trade-off | Source-doc says | This plan says | When to revisit |
|---|---|---|---|
| Where rendering happens | Server `@napi-rs/canvas` for pixel-perfect parity | Browser Konva; uses HarfBuzz via Chrome/Safari/Firefox natively | If admins ship on Android <8 (rare in 2026 Kerala). Then add server render. |
| Cache strategy | Edge worker hashes request, hits R2, redirects | Browser checks for existing `posters/<hash>.*`; uploads only if missing | If batch volume goes past hundreds/day and bandwidth becomes an issue. |
| Job queue | Cloudflare Queues or Postgres `render_jobs` | None — render is synchronous in browser | If admins ever want "generate 500 posters and email me when done." |
| WhatsApp OG preview | Server-rendered PNG sits ready when WhatsApp crawls | Browser uploads PNG to Storage first; share link points to public result page that includes that storage URL as `og:image` | If admins share before the upload finishes. UX mitigation: don't show share buttons until upload done. |
| Drag-to-adjust editor | Phase 5 of source | Deferred indefinitely; Konva is in place so adding it later is local to one component | If admins consistently complain a slot is misaligned for a particular event. |
| Service-worker offline | Phase 7 of source | Dropped | Probably never. Admins have wifi at event venues. |
| Print quality (3000 px) | One of 4 export presets | Drop in MVP; 2160 HD is enough | If a stakeholder asks for A3 print. |
| Multi-admin concurrent edits | Realtime conflict detection in Phase 5 | Drop; solo admin assumption | If an org onboards 2+ active admins. |

---

## 11. Open Decisions (Before Phase A Starts)

1. **Background art.** Who designs the Saaheethyolsav podium PSD? Without the PNG, Phase B can't start. Confirm by end of Phase A.
2. **Domain.** What URL? E.g. `sahitya.appmaker.xyz` or `results.ssf-something.org`. Needs to be set before deploy in Phase C.
3. **Org list.** For MVP, hardcode one org (`ssf-calicut-sector` or similar). What's the canonical org name + slug?
4. **Admin invite flow.** Magic-link self-service vs. developer creates admin users manually? MVP: magic-link but only emails on an allowlist get accepted.
5. **Tie-break presentation.** When `is_tie=true`, do the two winners share position 1 (both shown at "1" with no gap)? Or "1=" prefix? Confirm before Phase B.
6. **Random template UX.** With one template in MVP, the "🎲 Try another" button is a no-op. Wire it but hide it until template count ≥ 2.

---

## 12. Risks (and how we'll handle them)

| Risk | Likelihood | Mitigation |
|---|---|---|
| Malayalam shaping broken on some Android browser | Low (modern Chrome handles it) | Smoke test on a real Redmi-class device in Phase B. Fall back: add server render in Phase D. |
| Konva text-fit divergence between admin preview and final export | Medium | Use identical pixelRatio export math. Snapshot test 5 fixture results. |
| Browser OOMs rendering large batches on a phone | Medium | "Generate for all" renders one at a time, `stage.destroy()` between each. Cap at 100/batch. |
| Supabase free tier exceeded | Low | Monitor DB size + Storage size; alert at 80%. |
| Cloudflare Pages build minutes exceeded (500/mo) | Very low | Only deploy on `main` pushes; preview deploys only on tagged PRs. |
| RLS misconfig leaks cross-org data | Medium (RLS is easy to get wrong) | Write a test suite that explicitly tries cross-org reads/writes with two tokens and asserts denial. |

---

## 13. Next Concrete Actions

1. Confirm org slug + admin email allowlist (§11.3, §11.4).
2. Confirm domain (§11.2).
3. Create Supabase project. Note URL + anon key.
4. Create Cloudflare account; connect GitHub repo for Pages.
5. I scaffold the React Router v7 project with Tailwind + Supabase client + the migrations from §6. (≈ Phase A start.)
6. Source the Saaheethyolsav background PNG (blocker for Phase B; can be in parallel with Phase A).

---

*Plan version: 2.0 — 2026-05-11. Major rewrite from v1.0 to free-tier, browser-only architecture per project owner direction. Companion docs: `compass_artifact_…_text_markdown.md` (architecture research — most server-side recommendations now deferred), `DEVELOPER_GUIDE.md` (phased guide — Phases 0–4 of that doc collapse to Phases A–C here).*
