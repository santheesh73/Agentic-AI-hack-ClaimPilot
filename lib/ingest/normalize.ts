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
/** Removes C0 control characters (a NUL is rejected by Postgres text columns) except tab and newline. */
export function stripControlChars(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function normalize(s: string): string {
  let out = stripControlChars(s).normalize("NFKC");

  out = out.replace(/[ﬀ-ﬄ]/g, (m) => LIGATURES[m] ?? m);
  out = out.replace(/­/g, "");
  out = out.replace(/-\s*\n\s*/g, "");
  out = out.replace(/[‘’“”–—]/g, (m) => CURLY_QUOTES[m] ?? m);
  out = out.toLowerCase();
  out = out.replace(/\s+/g, " ").trim();

  return out;
}
