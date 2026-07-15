import type { NextConfig } from "next";

// Local-dev API path: `next dev` does not run Cloudflare Pages Functions.
// Proxy /api/* → wrangler pages dev (default :8788) only in development.
// Production static export has no rewrites; CF Pages serves functions at same origin.
const API_PROXY = process.env.EMAIL_API_PROXY || "http://127.0.0.1:8788";
const isDev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  output: "export",
  images: {
    unoptimized: true,
  },
  // Rewrites are unsupported with `output: "export"` at build time.
  // Only register them for `next dev` so the UI can reach local Functions.
  ...(isDev
    ? {
        async rewrites() {
          return [
            {
              source: "/api/:path*",
              destination: `${API_PROXY}/api/:path*`,
            },
          ];
        },
      }
    : {}),
};

export default nextConfig;
