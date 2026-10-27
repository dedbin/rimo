import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["yjs"],
  outputFileTracingIncludes: {
    "/api/boards/**": [
      "./node_modules/@fontsource/{noto-sans,noto-serif,noto-sans-mono}/files/*-{latin,cyrillic}-{400,700}-{normal,italic}.woff2",
      "./node_modules/katex/dist/katex.min.css",
      "./node_modules/katex/dist/fonts/*.woff2",
    ],
  },
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "SAMEORIGIN" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    }];
  },
  /* config options here */
  devIndicators: false
};

export default nextConfig;
