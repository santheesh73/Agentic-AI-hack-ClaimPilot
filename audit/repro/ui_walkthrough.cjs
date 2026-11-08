// UI audit against the local production build (pnpm start on :3401) with the
// case API intercepted by fixture JSON, so no database is read or written.
// Run: node audit/repro/ui_walkthrough.cjs
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const AXE = fs.readFileSync(process.env.AXE_PATH, "utf8");
const BASE = "http://localhost:3401";
const SHOTS = path.join(__dirname, "..", "screenshots");
const now = new Date().toISOString();
const ev = (id, step, summary, extra = {}) => ({ id, case_id: "x", step, summary, tool: null, model: null, created_at: now, ...extra });
const base = { id: "x", owner_id: "o", title: "Sample Case A — PED waiting period already expired", insurer: "United General Health Insurance Co. Ltd.", claim_amount_inr: 185000, sim_offset_days: 0, redraft_count: 0, redteam_done: true, answers: {}, error: null, complaint_sent_on: null, dont_appeal_reason: null, missing_facts: [], deadlines: [],
  rubric: [["C1_CLAUSE_EXISTS", "yes"], ["C2_CONDITIONS_HOLD", "no"], ["C3_OVERRIDING_CLAUSE", "yes"], ["C4_EXPLICIT_EXCLUSION", "no"], ["C5_FACTS_KNOWN", "yes"], ["C6_DOCS_PRESENT", "yes"]].map(([id, answer]) => ({ id, answer, rationale: "Policy start 2022-03-01 + 48 months = 2026-03-01 < admission 2026-09-15.", evidence_refs: ["E1"] })) };
const evidence = [{ id: "e1", case_id: "x", short_id: "E1", claim: "PED exclusion ceases after 48 months", quote: "Once the policy has been continuously renewed without a break for 48 months, this exclusion shall cease to apply.", verified: true, match_score: 1, page_id: "p3", page_no: 3, source: "assess" },
  { id: "e2", case_id: "x", short_id: "E2", claim: "Definition of PED", quote: "Pre-Existing Disease means any condition diagnosed within 48 months prior to the effective date", verified: false, match_score: 0.61, page_id: "p1", page_no: 1, source: "assess" }];
const drafts = [{ id: "d1", case_id: "x", version: 1, body_md: "# Appeal\n\nDraft one. [cite:E1]", verification: [{ short_id: "E1", ok: true, score: 1 }], redteam: null },
  { id: "d2", case_id: "x", version: 2, body_md: "# Appeal for reconsideration\n\nThe 48-month waiting period expired on 01 March 2026. [cite:E1]\n\nPlease settle the claim of Rs 1,85,000.", verification: [{ short_id: "E1", ok: true, score: 1 }], redteam: { rebuttal: "The insurer could argue the enhancement clause.", attacked: [], supporting: [], severity: "low" } }];
const events = ["INTAKE", "EXTRACT", "RETRIEVE", "ASSESS", "DECIDE", "ROUTE", "DRAFT", "VERIFY", "REDTEAM"].map((s, i) => ev(i + 1, s, `${s} done`));
const FIX = {
  strong: { case: { ...base, state: "AWAITING_APPROVAL", verdict: "STRONG" }, events, evidence, drafts, followups: [], documents: [], deadlines: [] },
  approved: { case: { ...base, state: "APPROVED", verdict: "STRONG", complaint_sent_on: "2026-11-08" }, events, evidence, drafts, followups: [], documents: [], deadlines: [{ label: "Escalate to IRDAI Bima Bharosa if unresolved", date: "2026-11-22", rule_id: "GRO_14D", source_url: "https://example" }, { label: "Eligible to file with the Insurance Ombudsman", date: "2026-12-08", rule_id: "OMB_ELIGIBLE", source_url: "https://example" }] },
  ask: { case: { ...base, title: "Sample Case B", state: "AWAITING_USER", verdict: null, missing_facts: [{ key: "diagnosis_date", question: "When was the hypertension first diagnosed?" }] }, events: events.slice(0, 4), evidence, drafts: [], followups: [], documents: [], deadlines: [] },
  dont: { case: { ...base, title: "Sample Case C", state: "DONT_APPEAL", verdict: "WEAK", dont_appeal_reason: "The policy explicitly excludes cosmetic surgery for aesthetic purposes in all circumstances." }, events: events.slice(0, 6), evidence, drafts: [], followups: [], documents: [], deadlines: [] },
  error: { case: { ...base, title: "Errored case", state: "ERROR", verdict: null, error: "Failed after 3 attempts. Last error: AI_APICallError: You exceeded your current quota, please check your plan and billing details." }, events: events.slice(0, 2), evidence: [], drafts: [], followups: [], documents: [], deadlines: [] },
};
(async () => {
  const browser = await chromium.launch();
  const out = { pages: {} };
  for (const [name, fixture] of Object.entries({ landing: null, ...FIX })) {
    for (const width of [375, 768, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const consoleErrors = [];
      page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 160)));
      page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message.slice(0, 160)));
      await page.route("**/api/cases/x", (r) => r.fulfill({ json: fixture }));
      await page.goto(name === "landing" ? BASE + "/" : `${BASE}/cases/x`);
      await page.waitForTimeout(1200);
      await page.screenshot({ path: path.join(SHOTS, `${name}-${width}.png`), fullPage: true });
      const m = await page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth, disclaimer: /not legal advice/i.test(document.body.innerText), chips: document.querySelectorAll("button[data-cite], [data-cite], .cite-chip").length, buttons: [...document.querySelectorAll("button")].map((b) => b.innerText.trim()).filter(Boolean).slice(0, 12) }));
      const rec = { horizontalOverflow: m.scrollW > m.clientW, disclaimerVisible: m.disclaimer, buttons: m.buttons, consoleErrors };
      if (width === 1440) {
        await page.addScriptTag({ content: AXE });
        const axe = await page.evaluate(async () => { const r = await window.axe.run(document, { resultTypes: ["violations"] }); return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(" ") })); });
        rec.axe = axe;
        // keyboard: first 12 focus stops
        const stops = [];
        for (let i = 0; i < 12; i++) { await page.keyboard.press("Tab"); stops.push(await page.evaluate(() => { const a = document.activeElement; return a ? `${a.tagName.toLowerCase()}${a.getAttribute("aria-label") ? "[" + a.getAttribute("aria-label") + "]" : ""}:${(a.innerText || "").trim().slice(0, 25)}` : null; })); }
        rec.tabOrder = stops;
        if (name === "strong") {
          const chip = page.locator("text=/\\[?E1\\]?|p\\.\\s?3/").first();
          rec.chipFound = await chip.count();
          const chipButtons = await page.$$eval("button", (bs) => bs.filter((b) => /E1|p\.\s?3/.test(b.innerText)).map((b) => ({ text: b.innerText, aria: b.getAttribute("aria-label") })));
          rec.chipButtons = chipButtons;
          if (chipButtons.length) { await page.locator("button", { hasText: /E1|p\.\s?3/ }).first().click(); await page.waitForTimeout(300); rec.highlightAfterClick = await page.evaluate(() => { const el = document.getElementById("evidence-E1"); return el ? { exists: true, className: el.className.slice(0, 120), inView: el.getBoundingClientRect().top < innerHeight && el.getBoundingClientRect().bottom > 0 } : { exists: false }; }); }
        }
        if (name === "ask") {
          const dlg = await page.$("[role=dialog]"); rec.dialogOpen = !!dlg;
          if (dlg) { const trapped = []; for (let i = 0; i < 8; i++) { await page.keyboard.press("Tab"); trapped.push(await page.evaluate(() => !!document.activeElement?.closest("[role=dialog]"))); } rec.focusTrappedInDialog = trapped.every(Boolean); }
        }
      }
      out.pages[`${name}@${width}`] = rec;
      await page.close();
    }
  }
  // Letter print view
  const lp = await browser.newPage();
  await lp.route("**/api/cases/x", (r) => r.fulfill({ json: FIX.strong }));
  await lp.goto(`${BASE}/cases/x/letter`); await lp.waitForTimeout(1000);
  out.letter = { text: (await lp.evaluate(() => document.body.innerText)).slice(0, 400) };
  await lp.screenshot({ path: path.join(SHOTS, "letter-1440.png"), fullPage: true });
  // Letter page for a missing case
  const lp2 = await browser.newPage();
  await lp2.route("**/api/cases/missing", (r) => r.fulfill({ status: 404, json: { error: { code: "not_found", message: "Not found" } } }));
  await lp2.goto(`${BASE}/cases/missing/letter`); await lp2.waitForTimeout(1000);
  out.letter_not_found = { text: (await lp2.evaluate(() => document.body.innerText)).slice(0, 200) };
  await lp2.screenshot({ path: path.join(SHOTS, "letter-not-found.png") });
  // Replay mode
  const rp = await browser.newPage();
  await rp.route("**/api/cases/x", (r) => r.fulfill({ json: FIX.strong }));
  await rp.goto(`${BASE}/cases/x?replay=1`); await rp.waitForTimeout(800);
  const early = await rp.evaluate(() => document.body.innerText.match(/(INTAKE|EXTRACT|RETRIEVE|ASSESS|DECIDE|ROUTE|DRAFT|VERIFY|REDTEAM) done/g)?.length ?? 0);
  await rp.waitForTimeout(6000);
  const late = await rp.evaluate(() => document.body.innerText.match(/(INTAKE|EXTRACT|RETRIEVE|ASSESS|DECIDE|ROUTE|DRAFT|VERIFY|REDTEAM) done/g)?.length ?? 0);
  out.replay = { events_visible_at_0_8s: early, events_visible_at_6_8s: late };
  fs.writeFileSync(path.join(__dirname, "..", "logs", "80-ui-walkthrough.json"), JSON.stringify(out, null, 2));
  await browser.close();
})();
