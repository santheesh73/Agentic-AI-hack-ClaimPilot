import { Badge } from "@/components/ui/badge";

export type AgentEvent = {
  id: number;
  step: string;
  tool: string | null;
  model: string | null;
  summary: string | null;
  ms: number | null;
};

export function Trace({ events }: { events: AgentEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">No events yet. Click Run.</p>;
  }
  return (
    <div className="space-y-3">
      {events.map((e) => (
        <div key={e.id} className="text-sm border-b pb-2 animate-in fade-in slide-in-from-top-1">
          <div className="flex gap-2 items-center">
            <Badge variant="secondary" className="text-[10px]">
              {e.step}
            </Badge>
            {e.model && <span className="text-xs text-muted-foreground">{e.model}</span>}
            {e.ms != null && <span className="text-xs text-muted-foreground">{e.ms}ms</span>}
          </div>
          {e.summary && <p className="mt-1">{e.summary}</p>}
        </div>
      ))}
    </div>
  );
}
