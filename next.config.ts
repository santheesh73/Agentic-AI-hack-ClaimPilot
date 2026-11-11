import type { NextConfig } from "next";

// Baseline response headers (F-014). No CSP yet: Next injects inline scripts and
// a nonce-based policy needs middleware, which is a separate piece of work.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  /* config options here */
  // app/api/cases/sample/route.ts reads samples/* via a dynamically-built path
  // (the filename depends on a request body value), which Next's build-time
  // file tracer can't follow statically -- without this, the serverless
  // function bundle on Vercel may not include samples/*, and the "Load sample
  // case" buttons would fail with ENOENT in production despite working in dev.
  outputFileTracingIncludes: {
    "/api/cases/sample": ["./samples/**"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
