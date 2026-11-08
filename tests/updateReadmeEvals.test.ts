import { describe, it, expect } from "vitest";
import { summarize, replaceBlock, START, END, type EvalRun } from "../scripts/update-readme-evals";

const run = (ranAt: string, results: EvalRun["results"]): EvalRun => ({
  ranAt,
  provider: "google",
  model_strong: "gemini-3.5-flash-lite",
  results,
});

const r = (name: string, expected: string, got: string, verifiedPct = 0, ms = 1000, tokens = 100) => ({
  case: name,
  expected,
  got,
  verifiedPct,
  steps: 10,
  ms,
  tokens,
});

describe("summarize", () => {
  const runs = [
    run("2026-11-01T10:00:00Z", [r("A", "STRONG", "STRONG", 100, 1000, 200), r("C", "WEAK", "WEAK")]),
    run("2026-11-02T10:00:00Z", [r("A", "STRONG", "ARGUABLE", 50, 3000, 400), r("C", "WEAK", "ERROR: boom")]),
  ];
  const md = summarize(runs, ["evals/results/x.json"]);

  it("computes accuracy over every case-run", () => {
    expect(md).toContain("**Verdict accuracy: 2/4 (50%)** across 2 case(s); 1 case-run(s) ended in an error.");
  });

  it("averages citations only over drafted runs", () => {
    expect(md).toContain("over the 2 case-run(s) that produced a draft: 75%");
  });

  it("writes one row per case with per-run results, median ms and mean tokens", () => {
    expect(md).toContain("| A | STRONG | STRONG, ARGUABLE | ?, ? | 1/2 | 75% (2 drafted) | 2000 | 300 |");
    expect(md).toContain("| C | WEAK | WEAK, ERROR: boom | ?, ? | 1/2 | n/a | 1000 | 100 |");
  });

  it("names the date range, model and source files", () => {
    expect(md).toContain("2 run(s)");
    expect(md).toContain("google / gemini-3.5-flash-lite");
    expect(md).toContain("2026-11-01 to 2026-11-02");
    expect(md).toContain("`evals/results/x.json`");
  });

  it("does not count a correct verdict that ended in ERROR as an end-to-end success", () => {
    const withState = summarize([
      run("2026-11-01T10:00:00Z", [
        { ...r("A", "STRONG", "STRONG", 100), finalState: "AWAITING_APPROVAL" },
        { ...r("B", "STRONG", "STRONG", 0), finalState: "ERROR" },
      ]),
    ]);
    expect(withState).toContain("**Verdict accuracy: 2/2 (100%)** across 2 case(s); 1 case-run(s) ended in an error.");
    expect(withState).toContain("**Correct verdict and no error: 1/2 (50%).**");
    expect(withState).toContain("| B | STRONG | STRONG | ERROR | 1/1 |");
  });

  it("refuses to summarize nothing", () => {
    expect(() => summarize([])).toThrow();
  });
});

describe("replaceBlock", () => {
  it("replaces only the content between the markers", () => {
    const readme = `# T\n${START}\nold\n${END}\n## After`;
    expect(replaceBlock(readme, "new")).toBe(`# T\n${START}\nnew\n${END}\n## After`);
  });

  it("throws when the markers are missing", () => {
    expect(() => replaceBlock("# no markers", "x")).toThrow(/markers/);
  });
});
