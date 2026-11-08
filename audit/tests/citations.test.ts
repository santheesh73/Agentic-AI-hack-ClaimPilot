// Independent checks of citation-marker parsing and sentence stripping.
import { describe, it } from "vitest";
import fs from "node:fs";
import { extractCites, stripSentencesCiting, verifyDraft } from "@/lib/agent/verify";

const formats: Array<[string, string, string[]]> = [
  ["canonical", "Claim is covered. [cite:E1]", ["E1"]],
  ["no space before", "Claim is covered.[cite:E1]", ["E1"]],
  ["space after colon", "Covered [cite: E1].", ["E1"]],
  ["comma list", "Covered [cite: E1, E2].", ["E1", "E2"]],
  ["adjacent markers", "Covered [cite:E1][cite:E2].", ["E1", "E2"]],
  ["uppercase CITE", "Covered [CITE:E1].", ["E1"]],
  ["lowercase id", "Covered [cite:e1].", ["E1"]],
  ["nested brackets", "Covered [[cite:E1]].", ["E1"]],
  ["semicolon list", "Covered [cite:E1; E2].", ["E1", "E2"]],
  ["space-separated list", "Covered [cite:E1 E2].", ["E1", "E2"]],
  ["range", "Covered [cite:E1-E3].", ["E1", "E2", "E3"]],
  ["parenthesised", "Covered (cite:E1).", ["E1"]],
  ["markdown link style", "Covered [E1](cite).", ["E1"]],
  ["unknown id", "Covered [cite:E99].", ["E99"]],
];

describe("citation parsing", () => {
  it("records what each plausible model format parses to", () => {
    const rows = formats.map(([name, text, intended]) => {
      const got = extractCites(text);
      // Whether a raw, unparsed marker-like token would survive into the letter
      const leftover = /\b(cite|CITE)\b/.test(text.replace(/\[cite:\s*([A-Za-z0-9_]+(?:\s*,\s*[A-Za-z0-9_]+)*)\]/g, ""));
      return { name, text, intended, parsed: got, matches_intent: JSON.stringify(got) === JSON.stringify(intended), unparsed_marker_left_in_letter: leftover };
    });
    // verifyDraft on a draft whose only cite is in an unparsed format: it reports nothing to verify.
    const unparsedOnly = verifyDraft("The policy covers this in full. [cite:E1; E2]", {}, {});
    // Stripping: the model often puts the marker AFTER the full stop.
    const afterStop = "The waiting period has expired. [cite:E9] Please reconsider the claim. We attach the discharge summary.";
    const beforeStop = "The waiting period has expired [cite:E9]. Please reconsider the claim. We attach the discharge summary.";
    const paragraphs = "Para one sentence. [cite:E1]\n\nPara two has a bad cite [cite:E9].\n\n- bullet item one\n- bullet item two";
    const report = {
      formats: rows,
      verifyDraft_on_unparsed_marker: unparsedOnly,
      strip_marker_after_full_stop: { input: afterStop, output: stripSentencesCiting(afterStop, ["E9"]) },
      strip_marker_before_full_stop: { input: beforeStop, output: stripSentencesCiting(beforeStop, ["E9"]) },
      strip_preserves_markdown: { input: paragraphs, output: stripSentencesCiting(paragraphs, ["E9"]) },
      strip_abbreviation: { input: "Per Sec. 6.3 of the policy the claim is valid [cite:E9]. Thank you.", output: stripSentencesCiting("Per Sec. 6.3 of the policy the claim is valid [cite:E9]. Thank you.", ["E9"]) },
    };
    fs.writeFileSync("audit/logs/22-citations.json", JSON.stringify(report, null, 2));
  });
});
