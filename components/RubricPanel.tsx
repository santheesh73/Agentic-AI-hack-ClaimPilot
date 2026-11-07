import { Badge } from "@/components/ui/badge";

export type Check = {
  id: string;
  answer: "yes" | "no" | "unknown";
  rationale: string;
  evidence_refs: string[];
};

export function RubricPanel({ rubric }: { rubric: Check[] }) {
  if (rubric.length === 0) {
    return <p className="text-sm text-muted-foreground">No assessment yet.</p>;
  }
  return (
    <div className="space-y-4">
      {rubric.map((check) => (
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
    </div>
  );
}
