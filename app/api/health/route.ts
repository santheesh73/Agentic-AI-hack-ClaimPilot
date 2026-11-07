import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { supabaseAdmin, DOCUMENTS_BUCKET } from "@/lib/db";

export const maxDuration = 10;

const VERSION = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev";

export async function GET() {
  let env;
  try {
    env = getEnv();
  } catch {
    // Never echo the validation error: it lists which vars are missing, which
    // is useful in logs but not something to expose over an unauthenticated route.
    return NextResponse.json(
      { ok: false, provider: null, db: "error", storage: "error", version: VERSION },
      { status: 503 }
    );
  }

  let db: "ok" | "error" = "error";
  let storage: "ok" | "error" = "error";
  try {
    const client = supabaseAdmin();
    const { error: dbError } = await client.from("regulations").select("id").limit(1);
    db = dbError ? "error" : "ok";

    const { error: storageError } = await client.storage.from(DOCUMENTS_BUCKET).list("", { limit: 1 });
    storage = storageError ? "error" : "ok";
  } catch {
    // leave db/storage as "error"
  }

  const ok = db === "ok" && storage === "ok";
  return NextResponse.json({ ok, provider: env.LLM_PROVIDER, db, storage, version: VERSION }, { status: ok ? 200 : 503 });
}
