import type { Config } from "@react-router/dev/config";
import { vercelPreset } from "@vercel/react-router/vite";

// Dual-target: Cloudflare Workers by default; Vercel when building on
// Vercel (it sets process.env.VERCEL). The Vercel preset + the
// Cloudflare vite-environment API are mutually exclusive, so gate both.
const onVercel = !!process.env.VERCEL;

export default {
  ssr: true,
  ...(onVercel
    ? { presets: [vercelPreset()] }
    : { future: { v8_viteEnvironmentApi: true } }),
} satisfies Config;
