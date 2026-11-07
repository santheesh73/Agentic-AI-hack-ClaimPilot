import "server-only";
import { supabaseAdmin } from "./db";
import { getOwnerId } from "./db";

/** Returns the case row if the current browser owns it, otherwise null. */
export async function getOwnedCase(caseId: string) {
  const ownerId = await getOwnerId();
  if (!ownerId) return null;
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("cases")
    .select("*")
    .eq("id", caseId)
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (error) {
    // Postgres' "invalid input syntax for type uuid" -- a malformed id in the
    // URL is just a 404, not a server error.
    if (error.code === "22P02") return null;
    throw error;
  }
  return data;
}
