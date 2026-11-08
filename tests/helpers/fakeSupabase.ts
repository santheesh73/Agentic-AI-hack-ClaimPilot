// A minimal in-memory stand-in for the subset of the Supabase JS client this
// codebase actually uses (see `rg -o '\.(from|select|insert|...)\(' lib app`
// for the exact surface). Not a faithful Postgres/PostgREST reimplementation
// -- in particular `rpc('search_pages', ...)` here does simple case-
// insensitive keyword matching, not real ts_rank_cd full-text search (that
// behavior is covered separately by the live-DB verification recorded in
// docs/AUDIT.md). This exists so lib/agent/machine.ts and the API routes can
// be exercised offline and deterministically with a mocked LLM.

type Row = Record<string, unknown>;
type Table = Row[];
export type FakeDb = Record<string, Table>;

let idCounters: Record<string, number> = {};

function nextId(table: string): string {
  idCounters[table] = (idCounters[table] ?? 0) + 1;
  // agent_events uses a numeric bigserial id that callers compare with gt();
  // every other table uses a uuid-shaped string primary key.
  if (table === "agent_events") return String(idCounters[table]);
  return `${table}-${idCounters[table]}`;
}

export function resetFakeIds() {
  idCounters = {};
}

type Filter =
  | { kind: "eq"; col: string; val: unknown }
  | { kind: "in"; col: string; val: unknown[] }
  | { kind: "is"; col: string; val: unknown }
  | { kind: "gt"; col: string; val: unknown }
  | { kind: "lte"; col: string; val: unknown }
  | { kind: "or"; subs: Array<{ col: string; op: string; val: string }> };

function parseOrExpr(expr: string): Array<{ col: string; op: string; val: string }> {
  return expr.split(",").map((segment) => {
    const firstDot = segment.indexOf(".");
    const col = segment.slice(0, firstDot);
    const rest = segment.slice(firstDot + 1);
    const secondDot = rest.indexOf(".");
    const op = rest.slice(0, secondDot);
    const val = rest.slice(secondDot + 1);
    return { col, op, val };
  });
}

function matchesFilter(row: Row, f: Filter): boolean {
  switch (f.kind) {
    case "eq":
      return row[f.col] === f.val;
    case "in":
      return f.val.includes(row[f.col]);
    case "is":
      return row[f.col] == null === (f.val === null);
    case "gt":
      return (row[f.col] as number) > (f.val as number);
    case "lte":
      return String(row[f.col]) <= String(f.val);
    case "or":
      return f.subs.some((sub) => {
        if (sub.op === "is" && sub.val === "null") return row[sub.col] == null;
        if (sub.op === "lt") return row[sub.col] != null && String(row[sub.col]) < sub.val;
        return false;
      });
  }
}

class FakeQueryBuilder implements PromiseLike<{ data: unknown; error: null; count?: number }> {
  private filters: Filter[] = [];
  private mode: "select" | "insert" | "update" | "delete" = "select";
  private payload: Row | Row[] | null = null;
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private wantSingle: "none" | "single" | "maybeSingle" = "none";
  private wantCount = false;

  constructor(private db: FakeDb, private table: string) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.count) this.wantCount = true;
    return this;
  }
  insert(payload: Row | Row[]) {
    this.mode = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: Row) {
    this.mode = "update";
    this.payload = payload;
    return this;
  }
  delete() {
    this.mode = "delete";
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ kind: "eq", col, val });
    return this;
  }
  in(col: string, val: unknown[]) {
    this.filters.push({ kind: "in", col, val });
    return this;
  }
  is(col: string, val: unknown) {
    this.filters.push({ kind: "is", col, val });
    return this;
  }
  gt(col: string, val: unknown) {
    this.filters.push({ kind: "gt", col, val });
    return this;
  }
  lte(col: string, val: unknown) {
    this.filters.push({ kind: "lte", col, val });
    return this;
  }
  or(expr: string) {
    this.filters.push({ kind: "or", subs: parseOrExpr(expr) });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderCol = col;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  single() {
    this.wantSingle = "single";
    return this;
  }
  maybeSingle() {
    this.wantSingle = "maybeSingle";
    return this;
  }

  private ensureTable(): Table {
    if (!this.db[this.table]) this.db[this.table] = [];
    return this.db[this.table];
  }

  private matched(): Row[] {
    const table = this.ensureTable();
    return table.filter((row) => this.filters.every((f) => matchesFilter(row, f)));
  }

  private execute(): { data: unknown; error: null; count?: number } {
    const table = this.ensureTable();

    if (this.mode === "insert") {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload!];
      const inserted = rows.map((r) => ({ id: nextId(this.table), created_at: new Date().toISOString(), ...r }));
      table.push(...inserted);
      const data = this.wantSingle !== "none" ? inserted[0] : inserted;
      return { data, error: null };
    }

    if (this.mode === "update") {
      const matched = this.matched();
      for (const row of matched) Object.assign(row, this.payload);
      const data = this.wantSingle !== "none" ? matched[0] ?? null : matched;
      return { data, error: null };
    }

    if (this.mode === "delete") {
      const matched = this.matched();
      const matchedSet = new Set(matched);
      this.db[this.table] = table.filter((row) => !matchedSet.has(row));
      return { data: matched, error: null };
    }

    // select
    let rows = this.matched();
    if (this.wantCount) return { data: null, error: null, count: rows.length };
    if (this.orderCol) {
      const col = this.orderCol;
      rows = [...rows].sort((a, b) => {
        const av = a[col] as string | number;
        const bv = b[col] as string | number;
        if (av < bv) return this.orderAsc ? -1 : 1;
        if (av > bv) return this.orderAsc ? 1 : -1;
        return 0;
      });
    }
    if (this.limitN != null) rows = rows.slice(0, this.limitN);
    if (this.wantSingle === "single") return { data: rows[0] ?? null, error: null };
    if (this.wantSingle === "maybeSingle") return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }

  then<TResult1 = { data: unknown; error: null; count?: number }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null; count?: number }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }
}

/** Very small keyword-overlap "full text search" stand-in for the `search_pages`
 * RPC -- not real Postgres ts_rank_cd. Good enough to drive deterministic
 * mocked-LLM integration tests of the RETRIEVE step. */
function fakeSearchPages(db: FakeDb, p_case: string, p_query: string, p_limit: number) {
  const pages = (db.pages ?? []).filter((p) => p.case_id === p_case);
  const documents = db.documents ?? [];
  const policyDocIds = new Set(documents.filter((d) => d.case_id === p_case && d.kind === "policy").map((d) => d.id));
  const terms = p_query.toLowerCase().split(/\s+/).filter(Boolean);

  const scored = pages
    .filter((p) => policyDocIds.has(p.document_id as string))
    .map((p) => {
      const text = String(p.text_norm ?? "").toLowerCase();
      const rank = terms.reduce((n, term) => n + (text.includes(term) ? 1 : 0), 0) / Math.max(terms.length, 1);
      return { id: p.id, page_no: p.page_no, document_id: p.document_id, rank, text: p.text };
    })
    .filter((p) => p.rank > 0)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, p_limit);

  return scored;
}

export function createFakeSupabase(db: FakeDb) {
  return {
    from(table: string) {
      return new FakeQueryBuilder(db, table);
    },
    rpc(fn: string, args: Record<string, unknown>) {
      if (fn === "search_pages") {
        const data = fakeSearchPages(db, args.p_case as string, args.p_query as string, args.p_limit as number);
        return Promise.resolve({ data, error: null });
      }
      if (fn === "bump_rate_limit") {
        // Mirrors supabase/migrations/0004's upsert-and-compare semantics.
        db.rate_limits ??= [];
        const key = (r: Row) =>
          r.owner_id === args.p_owner && r.bucket === args.p_bucket && r.window_start === args.p_window_start;
        let row = db.rate_limits.find(key);
        if (!row) {
          row = { owner_id: args.p_owner, bucket: args.p_bucket, window_start: args.p_window_start, count: 0 };
          db.rate_limits.push(row);
        }
        row.count = (row.count as number) + 1;
        return Promise.resolve({ data: (row.count as number) <= (args.p_limit as number), error: null });
      }
      return Promise.resolve({ data: null, error: new Error(`fakeSupabase: unsupported rpc ${fn}`) });
    },
    storage: {
      from() {
        return {
          upload: async () => ({ error: null }),
          remove: async () => ({ error: null }),
          list: async () => ({ data: [], error: null }),
        };
      },
    },
  };
}
