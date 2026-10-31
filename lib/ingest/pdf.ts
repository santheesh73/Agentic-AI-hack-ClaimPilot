import { extractText } from "unpdf";
import { normalize } from "./normalize";

export type ParsedPage = { page_no: number; text: string; text_norm: string };

/** True when a text-based PDF has no extractable text at all (likely scanned/image-only). */
export function isLikelyImageOnly(pages: ParsedPage[]): boolean {
  const totalChars = pages.reduce((n, p) => n + p.text.trim().length, 0);
  return totalChars < 20 * Math.max(pages.length, 1);
}

export async function parsePdf(buffer: ArrayBuffer | Uint8Array): Promise<ParsedPage[]> {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const { text } = await extractText(bytes, { mergePages: false });
  const texts = Array.isArray(text) ? text : [text];
  return texts.map((t, i) => ({
    page_no: i + 1,
    text: t,
    text_norm: normalize(t),
  }));
}
