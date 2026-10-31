import { supabaseAdmin } from "../../db";

export type SearchedPage = {
  id: string;
  page_no: number;
  document_id: string;
  rank: number;
  text: string;
};

export async function searchPolicy(
  caseId: string,
  query: string,
  limit = 6
): Promise<SearchedPage[]> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("search_pages", {
    p_case: caseId,
    p_query: query,
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []) as SearchedPage[];
}
