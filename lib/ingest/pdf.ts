import { extractText } from "unpdf";
import { normalize } from "./normalize";

export type ParsedPage = { page_no: number; text: string; text_norm: string };

/** True when a text-based PDF has no extractable text at all (likely scanned/image-only). */
export function isLikelyImageOnly(pages: ParsedPage[]): boolean {
  const totalChars = pages.reduce((n, p) => n + p.text.trim().length, 0);
  return totalChars < 20 * Math.max(pages.length, 1);
}

export async function parsePdf(buffer: ArrayBuffer | Uint8Array): Promise<ParsedPage[]> {
  // A Node Buffer is `instanceof Uint8Array` (Buffer extends it), but unpdf
  // explicitly rejects a real Buffer ("Please provide binary data as
  // Uint8Array, rather than Buffer"). Always materialize a plain Uint8Array
  // view so callers that read a file via node:fs (readFile/readFileSync
  // return Buffer) don't crash -- this bit both app/api/cases/sample/route.ts
  // and evals/run.ts before being caught by a route-handler test.
  const bytes =
    buffer instanceof Uint8Array
      ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : new Uint8Array(buffer);
  const { text } = await extractText(bytes, { mergePages: false });
  const texts = Array.isArray(text) ? text : [text];
  return texts.map((t, i) => ({
    page_no: i + 1,
    text: t,
    text_norm: normalize(t),
  }));
}
