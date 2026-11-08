import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { DraftView } from "../components/DraftView";

// Avoid pulling in next/navigation etc. via unrelated client-only deps.
vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, onClick }: { children: React.ReactNode; onClick?: (e: unknown) => void }) =>
    createElement("span", { "data-chip": true, onClick }, children),
}));

describe("DraftView", () => {
  it("renders a single [cite:E1] marker as one clickable chip", () => {
    const html = renderToStaticMarkup(createElement(DraftView, { bodyMd: "Claim text [cite:E1].", onCiteClick: () => {} }));
    expect(html).toContain("data-chip");
    expect(html).toContain(">E1<");
    expect(html).not.toContain("[cite:");
  });

  it("renders a multi-id marker as separate adjacent chips, not one merged chip", () => {
    const html = renderToStaticMarkup(
      createElement(DraftView, { bodyMd: "Claim text [cite: E1, E2] more text.", onCiteClick: () => {} })
    );
    const chipCount = (html.match(/data-chip/g) ?? []).length;
    expect(chipCount).toBe(2);
    expect(html).toContain(">E1<");
    expect(html).toContain(">E2<");
    expect(html).not.toContain("[cite:");
  });

  it("leaves a normal markdown link untouched", () => {
    const html = renderToStaticMarkup(
      createElement(DraftView, { bodyMd: "See [IRDAI](https://irdai.gov.in).", onCiteClick: () => {} })
    );
    expect(html).toContain('href="https://irdai.gov.in"');
    expect(html).not.toContain("data-chip");
  });
});
