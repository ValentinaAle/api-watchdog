import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@api-watchdog/database", "@api-watchdog/queue", "@api-watchdog/validation"],
};

export default nextConfig;
