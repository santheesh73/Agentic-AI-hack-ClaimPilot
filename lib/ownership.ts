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
  if (error) throw error;
  return data;
}
