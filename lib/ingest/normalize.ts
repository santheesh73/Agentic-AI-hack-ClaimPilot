const LIGATURES: Record<string, string> = {
  "ﬁ": "fi",
  "ﬂ": "fl",
  "ﬀ": "ff",
  "ﬃ": "ffi",
  "ﬄ": "ffl",
};

const CURLY_QUOTES: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
};

/**
 * Normalizes PDF-extracted text for robust quote matching:
 * NFKC, ligature expansion, soft-hyphen removal, hyphenated line-break
 * joining, curly-quote/dash ASCII-fication, lowercasing, whitespace collapse.
 */
export function normalize(s: string): string {
  let out = s.normalize("NFKC");

  out = out.replace(/[ﬀ-ﬄ]/g, (m) => LIGATURES[m] ?? m);
  out = out.replace(/­/g, "");
  out = out.replace(/-\s*\n\s*/g, "");
  out = out.replace(/[‘’“”–—]/g, (m) => CURLY_QUOTES[m] ?? m);
  out = out.toLowerCase();
  out = out.replace(/\s+/g, " ").trim();

  return out;
}
