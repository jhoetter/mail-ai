import type { NextConfig } from "next";

const API_ORIGIN =
  process.env["MAILAI_API_ORIGIN"] ?? "http://127.0.0.1:8200";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Mirror office-ai: transpile workspace packages from source.
  transpilePackages: ["@mailai/ui", "@mailai/design-tokens"],
  // In dev, Next runs on :3200 and the API on :8200; rather than
  // configure CORS for one localhost origin, proxy /api/* through
  // Next so everything is same-origin from the browser. In prod,
  // override MAILAI_API_ORIGIN or replace this with an upstream
  // ingress rule.
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${API_ORIGIN}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
