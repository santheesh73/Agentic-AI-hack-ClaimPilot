// Runs once when the server starts. Validates the environment and logs every
// problem at once (F-035), so a misconfigured deploy is obvious in the logs
// at boot instead of surfacing as a 500 on the first request. It logs rather
// than throws: `next build` also loads this and may legitimately lack secrets.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  try {
    const { getEnv } = await import("./lib/env");
    getEnv();
  } catch (err) {
    console.error(`[claimpilot] ${err instanceof Error ? err.message : String(err)}`);
  }
}
