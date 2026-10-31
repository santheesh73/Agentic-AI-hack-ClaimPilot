"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export default function Home() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [insurer, setInsurer] = useState("");
  const [claimAmount, setClaimAmount] = useState("");
  const [policyFile, setPolicyFile] = useState<File | null>(null);
  const [rejectionFile, setRejectionFile] = useState<File | null>(null);
  const [rejectionText, setRejectionText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function createCase() {
    setErr(null);
    if (!policyFile) return setErr("Upload the policy PDF.");
    if (!rejectionFile && !rejectionText.trim()) return setErr("Upload or paste the rejection letter.");

    setSubmitting(true);
    try {
      const caseRes = await fetch("/api/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, insurer, claim_amount_inr: claimAmount ? Number(claimAmount) : null }),
      });
      const caseData = await caseRes.json();
      if (!caseRes.ok) throw new Error(caseData.error ?? "Failed to create case");
      const id = caseData.id as string;

      const policyForm = new FormData();
      policyForm.set("kind", "policy");
      policyForm.set("file", policyFile);
      const policyRes = await fetch(`/api/cases/${id}/documents`, { method: "POST", body: policyForm });
      if (!policyRes.ok) throw new Error((await policyRes.json()).error ?? "Policy upload failed");

      const rejectionForm = new FormData();
      rejectionForm.set("kind", "rejection");
      if (rejectionFile) rejectionForm.set("file", rejectionFile);
      else rejectionForm.set("text", rejectionText);
      const rejectionRes = await fetch(`/api/cases/${id}/documents`, { method: "POST", body: rejectionForm });
      if (!rejectionRes.ok) throw new Error((await rejectionRes.json()).error ?? "Rejection upload failed");

      router.push(`/cases/${id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col flex-1 items-center bg-muted/30">
      <main className="flex flex-1 w-full max-w-2xl flex-col gap-8 px-6 py-16">
        <div className="text-center space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight">ClaimPilot</h1>
          <p className="text-muted-foreground">
            Turn a rejected health insurance claim into a cited, verified appeal — with real deadlines.
          </p>
          <div className="flex justify-center gap-6 text-sm text-muted-foreground pt-2">
            <span>✓ Every claim cited</span>
            <span>✓ Citations verified in code</span>
            <span>✓ Real escalation deadlines</span>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>New case</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="title">Case title</Label>
              <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Hospitalization claim — Oct 2026" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="insurer">Insurer</Label>
                <Input id="insurer" value={insurer} onChange={(e) => setInsurer(e.target.value)} placeholder="e.g. Star Health" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="amount">Claim amount (₹)</Label>
                <Input id="amount" type="number" value={claimAmount} onChange={(e) => setClaimAmount(e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="policy">Policy wording PDF (required)</Label>
              <Input id="policy" type="file" accept="application/pdf" onChange={(e) => setPolicyFile(e.target.files?.[0] ?? null)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rejection-file">Rejection letter PDF</Label>
              <Input id="rejection-file" type="file" accept="application/pdf" onChange={(e) => setRejectionFile(e.target.files?.[0] ?? null)} />
              <p className="text-xs text-muted-foreground">or paste the text instead</p>
              <Textarea
                rows={5}
                placeholder="Paste the rejection letter text"
                value={rejectionText}
                onChange={(e) => setRejectionText(e.target.value)}
                disabled={!!rejectionFile}
              />
            </div>

            {err && <p className="text-sm text-destructive">{err}</p>}

            <Button className="w-full" onClick={createCase} disabled={submitting}>
              {submitting ? "Creating case…" : "Start assessment"}
            </Button>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
