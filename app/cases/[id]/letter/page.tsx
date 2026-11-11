"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { Button } from "@/components/ui/button";
import { replaceCites } from "@/lib/agent/verify";

type Evidence = { short_id: string; page_no: number | null };
type Draft = { version: number; body_md: string };

export default function LetterPage() {
  const { id } = useParams<{ id: string }>();
  const [bodyMd, setBodyMd] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "nodraft" | "error">("loading");

  useEffect(() => {
    (async () => {
      let data;
      try {
        const res = await fetch(`/api/cases/${id}`);
        if (res.status === 404) return setStatus("missing");
        if (!res.ok) return setStatus("error");
        data = await res.json();
      } catch {
        return setStatus("error");
      }
      const drafts: Draft[] = data.drafts ?? [];
      const evidence: Evidence[] = data.evidence ?? [];
      const latest = drafts[drafts.length - 1];
      if (!latest) return setStatus("nodraft");

      const rendered = replaceCites(latest.body_md, (ids) => {
        const pageNos = [...new Set(
          ids
            .map((shortId) => evidence.find((ev) => ev.short_id === shortId)?.page_no)
            .filter((n): n is number => n != null)
        )].sort((a, b) => a - b);
        return pageNos.length ? `(Policy p. ${pageNos.join(", ")})` : "";
      });
      setBodyMd(rendered);
      setStatus("ready");
    })();
  }, [id]);

  return (
    <div className="flex flex-col flex-1 bg-muted/30">
      <div className="print:hidden flex justify-end gap-2 p-4">
        <Button onClick={() => window.print()}>Print / Save as PDF</Button>
      </div>
      <div className="mx-auto bg-white shadow-sm my-4 p-[2cm] w-[21cm] min-h-[29.7cm] print:shadow-none print:m-0 print:w-auto print:min-h-0 prose">
        {bodyMd ? (
          <ReactMarkdown>{bodyMd}</ReactMarkdown>
        ) : (
          <p role={status === "loading" ? undefined : "alert"}>
            {status === "loading" && "Loading…"}
            {status === "missing" && "This case was not found. It may have been deleted, or it belongs to another browser."}
            {status === "nodraft" && "There is no letter yet. Run the case until it reaches approval."}
            {status === "error" && "The letter could not be loaded. Please try again."}
          </p>
        )}
      </div>
      <style>{`
        @media print {
          @page { size: A4; margin: 2cm; }
        }
      `}</style>
    </div>
  );
}
