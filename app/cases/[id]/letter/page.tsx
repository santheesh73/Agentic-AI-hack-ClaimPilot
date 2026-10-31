"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { Button } from "@/components/ui/button";

type Evidence = { short_id: string; page_no: number | null };
type Draft = { version: number; body_md: string };

export default function LetterPage() {
  const { id } = useParams<{ id: string }>();
  const [bodyMd, setBodyMd] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/cases/${id}`);
      const data = await res.json();
      const drafts: Draft[] = data.drafts ?? [];
      const evidence: Evidence[] = data.evidence ?? [];
      const latest = drafts[drafts.length - 1];
      if (!latest) return;

      const rendered = latest.body_md.replace(/\[cite:([A-Za-z0-9_]+)\]/g, (_m, shortId) => {
        const e = evidence.find((ev) => ev.short_id === shortId);
        return e?.page_no ? `(Policy p. ${e.page_no})` : "";
      });
      setBodyMd(rendered);
    })();
  }, [id]);

  return (
    <div className="flex flex-col flex-1 bg-muted/30">
      <div className="print:hidden flex justify-end gap-2 p-4">
        <Button onClick={() => window.print()}>Print / Save as PDF</Button>
      </div>
      <div className="mx-auto bg-white shadow-sm my-4 p-[2cm] w-[21cm] min-h-[29.7cm] print:shadow-none print:m-0 print:w-auto print:min-h-0 prose">
        {bodyMd ? <ReactMarkdown>{bodyMd}</ReactMarkdown> : <p>Loading…</p>}
      </div>
      <style>{`
        @media print {
          @page { size: A4; margin: 2cm; }
        }
      `}</style>
    </div>
  );
}
