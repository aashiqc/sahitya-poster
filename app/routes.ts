import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  // ---------- Public ----------
  index("routes/home.tsx"),
  route("result/:programCode", "routes/result.$programCode.tsx"),
  // PWA manifest — generated per-tenant from the org name so each
  // sector installs as its own home-screen app. The static file at
  // public/site.webmanifest was removed so requests fall through here.
  route("site.webmanifest", "routes/site-webmanifest.ts"),

  // ---------- Admin ----------
  route("admin", "routes/admin.tsx"),
  route("admin/login", "routes/admin.login.tsx"),
  // Print-friendly winners export — opens in a new tab from the admin
  // sidebar; the admin saves it as PDF via the browser's print dialog.
  route("admin/winners", "routes/admin.winners.tsx"),

  // ---------- Owner console (host-gated to owner.<root>) ----------
  route("owner", "routes/owner.tsx"),
] satisfies RouteConfig;
