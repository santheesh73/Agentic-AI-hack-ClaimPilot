"use client";

import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import { Badge } from "@/components/ui/badge";
import { replaceCites } from "@/lib/agent/verify";

const CITE_HREF_PREFIX = "#cite:";

/** Rewrites every [cite:E1] / [cite: E1, E2] marker into adjacent markdown
 * links (one per id) so react-markdown produces `a` nodes we can intercept
 * and render as clickable chips, instead of literal "[cite:E1]" text. */
function toCiteLinks(bodyMd: string): string {
  return replaceCites(bodyMd, (ids) => ids.map((id) => `[${id}](${CITE_HREF_PREFIX}${id})`).join(""));
}

function CiteChip({ id, onClick }: { id: string; onClick: (id: string) => void }) {
  return (
    <Badge
      asChild
      variant="outline"
      className="mx-0.5 cursor-pointer align-middle text-[10px] hover:bg-accent"
      onClick={(e) => {
        e.preventDefault();
        onClick(id);
      }}
    >
      {/* a real button: focusable, activated with Enter/Space, announced as a control */}
      <button type="button" aria-label={`Show evidence ${id}`}>
        {id}
      </button>
    </Badge>
  );
}

export function DraftView({ bodyMd, onCiteClick }: { bodyMd: string; onCiteClick: (shortId: string) => void }) {
  const components: Components = {
    a: ({ href, children }) => {
      if (typeof href === "string" && href.startsWith(CITE_HREF_PREFIX)) {
        const id = href.slice(CITE_HREF_PREFIX.length);
        return <CiteChip id={id} onClick={onCiteClick} />;
      }
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
  };

  return <ReactMarkdown components={components}>{toCiteLinks(bodyMd)}</ReactMarkdown>;
}
