import { Badge } from "@/components/ui/badge";

export type RedTeamData = {
  rebuttal: string;
  attacked: string[];
  severity: "low" | "medium" | "high";
} | null;

export function RedTeamCard({ redteam, answeredInNextVersion }: { redteam: RedTeamData; answeredInNextVersion: boolean }) {
  if (!redteam) return null;
  const severityVariant = redteam.severity === "high" ? "destructive" : redteam.severity === "medium" ? "secondary" : "outline";
  return (
    <div className="border rounded-md p-3 text-sm space-y-2 bg-muted/30">
      <div className="flex items-center gap-2">
        <span className="font-medium">Red-team review</span>
        <Badge variant={severityVariant}>{redteam.severity}</Badge>
        {answeredInNextVersion && <Badge variant="outline">answered in next version</Badge>}
      </div>
      <p className="text-muted-foreground">{redteam.rebuttal}</p>
      {redteam.attacked.length > 0 && (
        <p className="text-xs text-muted-foreground">Attacks: {redteam.attacked.join(", ")}</p>
      )}
    </div>
  );
}
