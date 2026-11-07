"use client";

import { cn } from "@/lib/utils";

export type Evidence = {
  short_id: string;
  claim: string;
  quote: string;
  verified: boolean;
  match_score: number | null;
};

export function Ledger({ evidence, highlightId }: { evidence: Evidence[]; highlightId: string | null }) {
  if (evidence.length === 0) {
    return <p className="text-sm text-muted-foreground">No evidence yet.</p>;
  }
  return (
    <div className="space-y-2">
      {evidence.map((e) => (
        <div
          key={e.short_id}
          id={`evidence-${e.short_id}`}
          className={cn(
            "text-xs border rounded-md p-2 scroll-mt-4 transition-colors",
            highlightId === e.short_id && "border-primary bg-accent"
          )}
        >
          <div className="flex items-center justify-between">
            <span className="font-medium">{e.short_id}</span>
            <span>
              {e.verified ? "✓" : "✗"} {e.match_score?.toFixed(2)}
            </span>
          </div>
          <p className="text-muted-foreground">{e.claim}</p>
          <p className="italic mt-1">&ldquo;{e.quote}&rdquo;</p>
        </div>
      ))}
    </div>
  );
}
