import { supabaseAdmin } from "../../db";

export type Regulation = {
  id: string;
  step: string;
  condition: string;
  clock_days: number | null;
  source_url: string;
  as_of: string;
};

export async function lookupRegulation(ruleIds: string[]): Promise<Regulation[]> {
  const db = supabaseAdmin();
  const { data, error } = await db.from("regulations").select("*").in("id", ruleIds);
  if (error) throw error;
  return (data ?? []) as Regulation[];
}
