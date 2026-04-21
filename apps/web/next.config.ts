import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Mirror office-ai: transpile workspace packages from source.
  transpilePackages: ["@mailai/ui", "@mailai/design-tokens"],
};

export default nextConfig;
