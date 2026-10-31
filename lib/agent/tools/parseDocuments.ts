import { parsePdf, isLikelyImageOnly, type ParsedPage } from "../../ingest/pdf";

export { isLikelyImageOnly };
export type { ParsedPage };

export async function parseDocuments(buffer: ArrayBuffer): Promise<ParsedPage[]> {
  return parsePdf(buffer);
}
