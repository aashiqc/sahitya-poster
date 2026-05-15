import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  // ---------- Public ----------
  index("routes/home.tsx"),
  route("result/:programCode", "routes/result.$programCode.tsx"),

  // ---------- Admin ----------
  route("admin", "routes/admin.tsx"),
  route("admin/login", "routes/admin.login.tsx"),
] satisfies RouteConfig;
