"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { AskUserDialog } from "@/components/AskUserDialog";
import { Deadlines, type DeadlineItem } from "@/components/Deadlines";
import { RedTeamCard, type RedTeamData } from "@/components/RedTeamCard";

type AgentEvent = { id: number; step: string; tool: string | null; model: string | null; summary: string | null; ms: number | null };
type Check = { id: string; answer: "yes" | "no" | "unknown"; rationale: string; evidence_refs: string[] };
type Evidence = { short_id: string; claim: string; quote: string; verified: boolean; match_score: number | null };
type Draft = {
  id: string;
  version: number;
  body_md: string;
  verification: Array<{ short_id: string; ok: boolean }> | null;
  redteam: RedTeamData;
};
type MissingFact = { key: string; question: string };

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
  const [running, setRunning] = useState(false);
  const [versionIdx, setVersionIdx] = useState<number | null>(null);
  const [revealCount, setRevealCount] = useState(0);
  const runningRef = useRef(false);

  const fetchCase = useCallback(async () => {
    const res = await fetch(`/api/cases/${id}`);
    const json = await res.json();
    setData(json);
    return json as CaseData;
  }, [id]);

  useEffect(() => {
    fetchCase();
  }, [fetchCase]);

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
      await fetch(`/api/cases/${id}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      await runLoop();
    },
    [id, runLoop]
  );

  const approve = useCallback(async () => {
    await fetch(`/api/cases/${id}/approve`, { method: "POST" });
    await fetchCase();
  }, [id, fetchCase]);

  const simulate = useCallback(
    async (days: number) => {
      await fetch(`/api/cases/${id}/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days }),
      });
      await fetchCase();
    },
    [id, fetchCase]
  );

  const deleteCase = useCallback(async () => {
    if (!confirm("Delete this case permanently?")) return;
    await fetch(`/api/cases/${id}`, { method: "DELETE" });
    router.push("/");
  }, [id, router]);

  const latestDraft = data?.drafts[data.drafts.length - 1];
  const shownDraft = useMemo(() => {
    if (!data) return undefined;
    if (versionIdx === null) return latestDraft;
    return data.drafts[versionIdx];
  }, [data, versionIdx, latestDraft]);

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
          <CardContent className="space-y-3 max-h-[70vh] overflow-y-auto">
            {(isReplay ? events.slice(0, revealCount) : events).map((e) => (
              <div key={e.id} className="text-sm border-b pb-2">
                <div className="flex gap-2 items-center">
                  <Badge variant="secondary" className="text-[10px]">{e.step}</Badge>
                  {e.model && <span className="text-xs text-muted-foreground">{e.model}</span>}
                  {e.ms != null && <span className="text-xs text-muted-foreground">{e.ms}ms</span>}
                </div>
                {e.summary && <p className="mt-1">{e.summary}</p>}
              </div>
            ))}
            {events.length === 0 && <p className="text-sm text-muted-foreground">No events yet. Click Run.</p>}
          </CardContent>
        </Card>

        <Card className="md:col-span-1">
          <CardHeader>
            <CardTitle className="text-sm">Assessment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 max-h-[70vh] overflow-y-auto">
            {(c.rubric ?? []).map((check) => (
              <div key={check.id} className="text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant={check.answer === "yes" ? "default" : check.answer === "no" ? "destructive" : "outline"}>
                    {check.answer}
                  </Badge>
                  <span className="font-medium">{check.id}</span>
                </div>
                <p className="text-muted-foreground mt-1">{check.rationale}</p>
              </div>
            ))}
            <Separator />
            <div className="space-y-2">
              <p className="text-sm font-medium">Evidence ledger</p>
              {evidence.map((e) => (
                <div key={e.short_id} className="text-xs border rounded-md p-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{e.short_id}</span>
                    <span>{e.verified ? "✓" : "✗"} {e.match_score?.toFixed(2)}</span>
                  </div>
                  <p className="text-muted-foreground">{e.claim}</p>
                  <p className="italic mt-1">&ldquo;{e.quote}&rdquo;</p>
                </div>
              ))}
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
                <ReactMarkdown>{shownDraft.body_md}</ReactMarkdown>
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
