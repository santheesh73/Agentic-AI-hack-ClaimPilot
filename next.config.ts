import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
