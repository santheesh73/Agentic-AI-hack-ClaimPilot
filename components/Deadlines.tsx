import { Badge } from "@/components/ui/badge";

export type DeadlineItem = { label: string; date: string; rule_id: string; source_url: string };

export function Deadlines({ deadlines }: { deadlines: DeadlineItem[] }) {
  if (!deadlines.length) {
    return <p className="text-sm text-muted-foreground">Deadlines appear once the complaint is sent.</p>;
  }
  return (
    <ol className="space-y-3">
      {deadlines.map((d) => (
        <li key={d.rule_id} className="flex items-start gap-3 text-sm">
          <Badge variant="outline" className="mt-0.5 shrink-0">{d.date}</Badge>
          <div>
            <p>{d.label}</p>
            <a href={d.source_url} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground underline">
              {d.rule_id}
            </a>
          </div>
        </li>
      ))}
    </ol>
  );
}
