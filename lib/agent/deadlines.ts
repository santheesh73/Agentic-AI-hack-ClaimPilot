export type Deadline = { label: string; date: string; rule_id: string; source_url: string };

export type Route = { step: "insurer_gro"; addressee: string };

const SOURCES: Record<string, string> = {
  GRO_14D: "https://telanganatoday.com/policyholders-can-approach-irdai-for-unresolved-insurance-complaints",
  BIMA_BHAROSA: "https://telanganatoday.com/policyholders-can-approach-irdai-for-unresolved-insurance-complaints",
  OMB_ELIGIBLE: "https://cioins.co.in/Faqs",
  OMB_1YEAR: "https://cioins.co.in/Faqs",
  OMB_CAP: "https://blog.ipleaders.in/insurance-ombudsman-complaint-procedure-and-awards/",
};

const OMBUDSMAN_CAP_INR = 5_000_000;

function toISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseISO(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/**
 * Calendar-month addition that clamps to the last day of the target month
 * (e.g. Jan 31 + 1 month -> Feb 28/29, never Mar 3).
 */
function addCalendarMonths(d: Date, months: number): Date {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();

  const targetMonthIndex = month + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;

  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfTargetMonth);

  return new Date(Date.UTC(targetYear, targetMonth, clampedDay));
}

/** now = today + sim_offset_days, as an ISO date string. */
export function simNow(simOffsetDays: number, today: Date = new Date()): string {
  return toISO(addDays(today, simOffsetDays));
}

/** Before a complaint is sent, the only route is the insurer's GRO. */
export function chooseRoute(insurer: string | null): Route {
  return { step: "insurer_gro", addressee: `Grievance Redressal Officer, ${insurer ?? "the insurer"}` };
}

/**
 * The last date to file with the Insurance Ombudsman (rule OMB_1YEAR): one
 * year from the insurer's reply/rejection of the complaint, or one year from
 * the end of the one-month no-reply period -- whichever applies first. When
 * the reply date is unknown, only the no-reply date can be computed, and it
 * must be presented as conditional (it is the LATEST possible date).
 */
export function ombudsmanLastDate(sentOn: string, repliedOn?: string | null): string {
  const noReplyDeadline = addCalendarMonths(parseISO(sentOn), 1 + 12);
  if (!repliedOn) return toISO(noReplyDeadline);
  const replyDeadline = addCalendarMonths(parseISO(repliedOn), 12);
  return toISO(replyDeadline < noReplyDeadline ? replyDeadline : noReplyDeadline);
}

/**
 * Builds the follow-up schedule once a GRO complaint is sent on `sentOn`
 * (ISO date). Pure function; `claimAmountInr` gates Ombudsman eligibility:
 * above the Rs 50 lakh cap no Ombudsman eligibility/deadline rows are
 * produced at all, only the "not available" row.
 */
export function scheduleFollowups(
  sentOn: string,
  claimAmountInr: number | null,
  repliedOn?: string | null
): Array<{ due_on: string; action: string; rule_id: string }> {
  const sent = parseISO(sentOn);

  const escalateBimaBharosa = toISO(addDays(sent, 14));
  const ombudsmanEligible = toISO(addCalendarMonths(sent, 1));

  const followups = [{ due_on: escalateBimaBharosa, action: "ESCALATE_BIMA_BHAROSA", rule_id: "GRO_14D" }];

  if (!isOmbudsmanEligibleByAmount(claimAmountInr)) {
    followups.push({ due_on: ombudsmanEligible, action: "OMBUDSMAN_INELIGIBLE_CAP", rule_id: "OMB_CAP" });
    return followups;
  }

  followups.push(
    { due_on: ombudsmanEligible, action: "OMBUDSMAN_ELIGIBLE", rule_id: "OMB_ELIGIBLE" },
    { due_on: ombudsmanLastDate(sentOn, repliedOn), action: repliedOn ? "OMBUDSMAN_LAST_DATE_AFTER_REPLY" : "OMBUDSMAN_LAST_DATE", rule_id: "OMB_1YEAR" }
  );
  return followups;
}

/** UI-facing deadline list with human labels and source links. */
export function deadlinesForUi(
  sentOn: string | null,
  claimAmountInr: number | null,
  repliedOn?: string | null
): Deadline[] {
  if (!sentOn) return [];
  const followups = scheduleFollowups(sentOn, claimAmountInr, repliedOn);
  const labels: Record<string, string> = {
    ESCALATE_BIMA_BHAROSA: "Escalate to IRDAI Bima Bharosa if unresolved",
    OMBUDSMAN_ELIGIBLE: "Eligible to file with the Insurance Ombudsman (if the insurer rejects, replies unsatisfactorily, or does not reply)",
    OMBUDSMAN_LAST_DATE:
      "Last date to file with the Insurance Ombudsman IF THE INSURER DOES NOT REPLY. If they reply or reject, the deadline is 1 year from their reply, which is earlier.",
    OMBUDSMAN_LAST_DATE_AFTER_REPLY: "Last date to file with the Insurance Ombudsman (1 year from the insurer's reply)",
    OMBUDSMAN_INELIGIBLE_CAP: "Ombudsman route not available (claim exceeds ₹50 lakh cap)",
  };
  return followups.map((f) => ({
    label: labels[f.action] ?? f.action,
    date: f.due_on,
    rule_id: f.rule_id,
    source_url: SOURCES[f.rule_id] ?? "",
  }));
}

export function isOmbudsmanEligibleByAmount(claimAmountInr: number | null): boolean {
  return claimAmountInr == null || claimAmountInr <= OMBUDSMAN_CAP_INR;
}
