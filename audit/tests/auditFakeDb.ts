// Audit-local in-memory stand-in for the Supabase client surface used by the
// app. Written independently of tests/helpers/fakeSupabase.ts. Enforces the
// unique keys and the step-lock predicate the real schema relies on.
type Row = Record<string, any>;
export type Db = Record<string, Row[]> & { __storage?: Array<{ op: string; path: string }> };

let seq = 0;
const uid = () => {
  seq++;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
};

const UNIQUE: Record<string, string[]> = { evidence: ["case_id", "short_id"], rate_limits: ["owner_id", "bucket", "window_start"] };

class Q implements PromiseLike<any> {
  private f: Array<(r: Row) => boolean> = [];
  private mode = "select";
  private payload: any = null;
  private ord: [string, boolean] | null = null;
  private lim: number | null = null;
  private one: "" | "single" | "maybe" = "";
  private head = false;
  private count = false;
  private returning = false;
  constructor(private db: Db, private t: string) {}
  select(_c?: string, o?: { count?: string; head?: boolean }) {
    if (this.mode !== "select") this.returning = true;
    if (o?.count) this.count = true;
    if (o?.head) this.head = true;
    return this;
  }
  insert(p: any) { this.mode = "insert"; this.payload = p; return this; }
  update(p: any) { this.mode = "update"; this.payload = p; return this; }
  delete() { this.mode = "delete"; return this; }
  eq(c: string, v: any) { this.f.push((r) => r[c] === v); return this; }
  in(c: string, v: any[]) { this.f.push((r) => v.includes(r[c])); return this; }
  is(c: string, v: any) { this.f.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  gt(c: string, v: any) { this.f.push((r) => r[c] > v); return this; }
  lte(c: string, v: any) { this.f.push((r) => String(r[c]) <= String(v)); return this; }
  or(expr: string) {
    // supports "col.is.null,col.lt.<iso>"
    const parts = expr.split(",").map((p) => { const [c, op, ...rest] = p.split("."); return { c, op, v: rest.join(".") }; });
    this.f.push((r) => parts.some(({ c, op, v }) => (op === "is" && v === "null" ? r[c] == null : op === "lt" ? r[c] != null && String(r[c]) < v : false)));
    return this;
  }
  order(c: string, o?: { ascending?: boolean }) { this.ord = [c, o?.ascending ?? true]; return this; }
  limit(n: number) { this.lim = n; return this; }
  single() { this.one = "single"; return this; }
  maybeSingle() { this.one = "maybe"; return this; }
  private table() { return (this.db[this.t] ??= []); }
  private run(): any {
    const tbl = this.table();
    const matched = () => tbl.filter((r) => this.f.every((fn) => fn(r)));
    if (this.mode === "insert") {
      const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((r: Row) => ({
        id: this.t === "agent_events" ? tbl.length + 1 + Math.random() * 0 : uid(),
        created_at: new Date().toISOString(),
        ...r,
      }));
      if (this.t === "agent_events") rows.forEach((r: Row, i: number) => (r.id = (tbl.at(-1)?.id ?? 0) + i + 1));
      const keys = UNIQUE[this.t];
      if (keys) {
        const k = (r: Row) => keys.map((c) => r[c]).join("|");
        const seen = new Set(tbl.map(k));
        for (const r of rows) { if (seen.has(k(r))) return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint on ${this.t}` } }; seen.add(k(r)); }
      }
      tbl.push(...rows);
      return { data: this.one ? rows[0] : rows, error: null };
    }
    if (this.mode === "update") {
      const m = matched(); m.forEach((r) => Object.assign(r, this.payload));
      return { data: this.one ? m[0] ?? null : m, error: null };
    }
    if (this.mode === "delete") {
      const m = new Set(matched()); this.db[this.t] = tbl.filter((r) => !m.has(r));
      return { data: [...m], error: null };
    }
    let rows = matched();
    if (this.count && this.head) return { data: null, count: rows.length, error: null };
    if (this.ord) { const [c, asc] = this.ord; rows = [...rows].sort((a, b) => (a[c] < b[c] ? (asc ? -1 : 1) : a[c] > b[c] ? (asc ? 1 : -1) : 0)); }
    if (this.lim != null) rows = rows.slice(0, this.lim);
    if (this.one === "single") return rows[0] ? { data: rows[0], error: null } : { data: null, error: { code: "PGRST116", message: "no rows" } };
    if (this.one === "maybe") return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }
  then<A, B>(ok?: ((v: any) => A | PromiseLike<A>) | null, bad?: ((e: any) => B | PromiseLike<B>) | null) {
    // Yield to the event loop first, like a real network round-trip, so
    // concurrent callers interleave.
    return new Promise((res) => setTimeout(res, 0)).then(() => this.run()).then(ok, bad);
  }
}

export function makeClient(db: Db) {
  return {
    from: (t: string) => new Q(db, t),
    rpc: async (fn: string, a: any) => {
      if (fn === "search_pages") {
        const policyDocs = new Set((db.documents ?? []).filter((d) => d.case_id === a.p_case && d.kind === "policy").map((d) => d.id));
        const terms = String(a.p_query).toLowerCase().split(/\W+/).filter((w) => w.length > 2);
        return {
          data: (db.pages ?? [])
            .filter((p) => p.case_id === a.p_case && policyDocs.has(p.document_id))
            .map((p) => ({ id: p.id, page_no: p.page_no, document_id: p.document_id, text: p.text, rank: terms.filter((t) => p.text_norm.includes(t)).length }))
            .filter((p) => p.rank > 0)
            .sort((x, y) => y.rank - x.rank)
            .slice(0, a.p_limit ?? 6),
          error: null,
        };
      }
      if (fn === "bump_rate_limit") {
        const rl = (db.rate_limits ??= []);
        let r = rl.find((x) => x.owner_id === a.p_owner && x.bucket === a.p_bucket && x.window_start === a.p_window_start);
        if (!r) rl.push((r = { owner_id: a.p_owner, bucket: a.p_bucket, window_start: a.p_window_start, count: 0 }));
        r.count++;
        return { data: r.count <= a.p_limit, error: null };
      }
      return { data: null, error: { message: `unsupported rpc ${fn}` } };
    },
    storage: {
      from: () => ({
        upload: async (path: string) => { (db.__storage ??= []).push({ op: "upload", path }); return { error: null }; },
        remove: async (paths: string[]) => { paths.forEach((path) => (db.__storage ??= []).push({ op: "remove", path })); return { error: null }; },
        list: async () => ({ data: [], error: null }),
      }),
    },
  };
}
