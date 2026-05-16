import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Dual-target: include the Cloudflare plugin for the Workers build, but
// drop it on Vercel (it pins the SSR env to workerd, which the Vercel
// preset can't use). tsconfig path aliases (~/*) resolve natively via
// Vite 8's resolve.tsconfigPaths in both targets.
const onVercel = !!process.env.VERCEL;

export default defineConfig({
  plugins: [
    ...(onVercel ? [] : [cloudflare({ viteEnvironment: { name: "ssr" } })]),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
