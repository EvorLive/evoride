import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to this app; otherwise Turbopack walks up and
  // selects an unrelated parent lockfile as the root.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
