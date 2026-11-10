"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { AskUserDialog } from "@/components/AskUserDialog";
import { Deadlines, type DeadlineItem } from "@/components/Deadlines";
import { RedTeamCard, type RedTeamData } from "@/components/RedTeamCard";
import { Trace, type AgentEvent } from "@/components/Trace";
import { RubricPanel, type Check } from "@/components/RubricPanel";
import { Ledger, type Evidence } from "@/components/Ledger";
import { DraftView } from "@/components/DraftView";
import { toast } from "sonner";
import { extractErrorMessage } from "@/lib/apiError";

type Draft = {
  id: string;
  version: number;
  body_md: string;
  verification: Array<{ short_id: string; ok: boolean }> | null;
  redteam: RedTeamData;
};
type MissingFact = { key: string; question: string; options?: string[] };

type CaseData = {
  case: {
    id: string;
    state: string;
    verdict: string | null;
    dont_appeal_reason: string | null;
    rubric: Check[] | null;
    missing_facts: MissingFact[] | null;
    answers: Record<string, string> | null;
    error: string | null;
    sim_offset_days: number;
  };
  events: AgentEvent[];
  evidence: Evidence[];
  drafts: Draft[];
  deadlines: DeadlineItem[];
};

const PAUSE_OR_TERMINAL = new Set(["AWAITING_USER", "AWAITING_APPROVAL", "DONT_APPEAL", "APPROVED", "ERROR"]);

export default function CasePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isReplay = searchParams.get("replay") === "1";
  const [data, setData] = useState<CaseData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [running, setRunning] = useState(false);
  const [versionIdx, setVersionIdx] = useState<number | null>(null);
  const [revealCount, setRevealCount] = useState(0);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const runningRef = useRef(false);

  const scrollToEvidence = useCallback((shortId: string) => {
    setHighlightId(shortId);
    document.getElementById(`evidence-${shortId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => setHighlightId((current) => (current === shortId ? null : current)), 2000);
  }, []);

  const fetchCase = useCallback(async () => {
    const res = await fetch(`/api/cases/${id}`);
    const json = await res.json();
    if (res.ok) setData(json);
    else setNotFound(true);
    return json as CaseData;
  }, [id]);

  useEffect(() => {
    let ignore = false;
    (async () => {
      const res = await fetch(`/api/cases/${id}`);
      const json = await res.json();
      if (ignore) return;
      if (res.ok) setData(json);
      else setNotFound(true);
    })();
    return () => {
      ignore = true;
    };
  }, [id]);

  useEffect(() => {
    if (!isReplay || !data) return;
    if (revealCount >= data.events.length) return;
    const t = setTimeout(() => setRevealCount((n) => n + 1), 600);
    return () => clearTimeout(t);
  }, [isReplay, data, revealCount]);

  const runLoop = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    try {
      for (;;) {
        const res = await fetch(`/api/cases/${id}/step`, { method: "POST" });
        const fresh = await fetchCase();
        if (!res.ok || PAUSE_OR_TERMINAL.has(fresh.case.state)) break;
      }
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }, [id, fetchCase]);

  const answerQuestions = useCallback(
    async (answers: Record<string, string>) => {
      const res = await fetch(`/api/cases/${id}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      if (!res.ok) {
        toast.error(extractErrorMessage(await res.json().catch(() => null), "Failed to submit answers."));
        return;
      }
      await runLoop();
    },
    [id, runLoop]
  );

  const approve = useCallback(async () => {
    const res = await fetch(`/api/cases/${id}/approve`, { method: "POST" });
    if (!res.ok) {
      toast.error(extractErrorMessage(await res.json().catch(() => null), "Failed to approve the case."));
      return;
    }
    toast.success("Complaint approved and sent.");
    await fetchCase();
  }, [id, fetchCase]);

  const simulate = useCallback(
    async (days: number) => {
      const res = await fetch(`/api/cases/${id}/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days }),
      });
      if (!res.ok) {
        toast.error(extractErrorMessage(await res.json().catch(() => null), "Simulation failed."));
        return;
      }
      const { fired } = await res.json();
      toast.success(fired > 0 ? `Simulated +${days} days: ${fired} follow-up(s) fired.` : `Simulated +${days} days: no follow-ups due yet.`);
      await fetchCase();
    },
    [id, fetchCase]
  );

  const deleteCase = useCallback(async () => {
    if (!confirm("Delete this case permanently?")) return;
    const res = await fetch(`/api/cases/${id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error(extractErrorMessage(await res.json().catch(() => null), "Failed to delete the case."));
      return;
    }
    router.push("/");
  }, [id, router]);

  const latestDraft = data?.drafts[data.drafts.length - 1];
  const shownDraft = useMemo(() => {
    if (!data) return undefined;
    if (versionIdx === null) return latestDraft;
    return data.drafts[versionIdx];
  }, [data, versionIdx, latestDraft]);

  if (notFound) {
    return (
      <div className="flex flex-col flex-1 items-center justify-center gap-4 p-8 text-center">
        <p className="text-lg font-medium">Case not found</p>
        <p className="text-muted-foreground text-sm">
          It may have been deleted, or belongs to a different browser session.
        </p>
        <Button asChild>
          <Link href="/">Start a new case</Link>
        </Button>
      </div>
    );
  }

  if (!data) return <div className="p-8 text-muted-foreground">Loading…</div>;

  const { case: c, events, evidence, drafts, deadlines } = data;

  return (
    <div className="flex flex-col flex-1">
      <div className="bg-accent text-accent-foreground text-center text-sm py-2">
        Draft for your review, not legal advice.
      </div>

      <div className="flex items-center justify-between px-6 py-4 border-b">
        <div className="flex items-center gap-3">
          <h1 className="font-semibold">Case</h1>
          <Badge variant="outline">{c.state}</Badge>
          {c.verdict && <VerdictBadge verdict={c.verdict} />}
        </div>
        <div className="flex gap-2">
          {!isReplay && (
            <Button onClick={runLoop} disabled={running || PAUSE_OR_TERMINAL.has(c.state)}>
              {running ? "Running…" : "Run"}
            </Button>
          )}
          {latestDraft && (
            <Button variant="outline" asChild>
              <Link href={`/cases/${id}/letter`}>Open printable letter</Link>
            </Button>
          )}
          {c.state === "AWAITING_APPROVAL" && <Button onClick={approve}>Approve</Button>}
          {c.state === "APPROVED" && (
            <Button variant="outline" onClick={() => simulate(15)}>
              Simulate +15 days
            </Button>
          )}
          <Button variant="ghost" onClick={deleteCase}>
            Delete
          </Button>
        </div>
      </div>

      {c.state === "ERROR" && (
        <div className="m-6 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {c.error}
        </div>
      )}

      {c.state === "DONT_APPEAL" && c.dont_appeal_reason && (
        <div className="m-6 rounded-md border bg-muted/50 p-4 text-sm">
          <p className="font-medium mb-1">Our honest assessment: don&apos;t appeal this one.</p>
          <p>{c.dont_appeal_reason}</p>
        </div>
      )}

      {c.state === "APPROVED" && (
        <div className="mx-6 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Escalation deadlines (sim day {c.sim_offset_days})</CardTitle>
            </CardHeader>
            <CardContent>
              <Deadlines deadlines={deadlines} />
            </CardContent>
          </Card>
        </div>
      )}

      <AskUserDialog
        open={c.state === "AWAITING_USER"}
        missingFacts={c.missing_facts ?? []}
        onSubmit={answerQuestions}
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-6 flex-1">
        <Card className="md:col-span-1">
          <CardHeader>
            <CardTitle className="text-sm">Trace</CardTitle>
          </CardHeader>
          <CardContent className="max-h-[70vh] overflow-y-auto">
            <Trace events={isReplay ? events.slice(0, revealCount) : events} />
          </CardContent>
        </Card>

        <Card className="md:col-span-1">
          <CardHeader>
            <CardTitle className="text-sm">Assessment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 max-h-[70vh] overflow-y-auto">
            <RubricPanel rubric={c.rubric ?? []} />
            <Separator />
            <div className="space-y-2">
              <p className="text-sm font-medium">Evidence ledger</p>
              <Ledger evidence={evidence} highlightId={highlightId} />
            </div>
          </CardContent>
        </Card>

        <Card className="md:col-span-1">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm">Draft {shownDraft ? `v${shownDraft.version}` : ""}</CardTitle>
            {drafts.length > 1 && (
              <div className="flex gap-1">
                {drafts.map((d, i) => (
                  <Button
                    key={d.id}
                    size="sm"
                    variant={shownDraft?.id === d.id ? "default" : "outline"}
                    onClick={() => setVersionIdx(i)}
                  >
                    v{d.version}
                  </Button>
                ))}
              </div>
            )}
          </CardHeader>
          <CardContent className="max-h-[70vh] overflow-y-auto prose prose-sm space-y-4">
            {shownDraft ? (
              <>
                <DraftView bodyMd={shownDraft.body_md} onCiteClick={scrollToEvidence} />
                {shownDraft.redteam && (
                  <RedTeamCard
                    redteam={shownDraft.redteam}
                    answeredInNextVersion={drafts.some((d) => d.version === shownDraft.version + 1)}
                  />
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No draft yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function VerdictBadge({ verdict }: { verdict: string }) {
  const variant = verdict === "STRONG" ? "default" : verdict === "WEAK" ? "destructive" : "secondary";
  return <Badge variant={variant}>{verdict}</Badge>;
}
