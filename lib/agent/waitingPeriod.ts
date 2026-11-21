import type { Check } from "./schemas";

export type WaitingPeriodFacts = {
  applies: boolean;
  months: number | null;
  start_date: string | null;
  admission_date: string | null;
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** start + months, clamped to the last day of a shorter month (31 Jan + 1 month = 28/29 Feb). yyyy-mm-dd, UTC. */
export function addMonthsIso(start: string, months: number): string | null {
  if (!ISO.test(start) || !Number.isInteger(months) || months < 0) return null;
  const [y, m, d] = start.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const total = m - 1 + months;
  const year = y + Math.floor(total / 12);
  const month = total % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

/**
 * True/false when the waiting period's end can be computed and compared with
 * the admission date; null when it cannot (not a waiting-period clause, or
 * missing / malformed numbers). A waiting period that ends ON the admission
 * date counts as completed ("completion of 24 months" has been reached).
 */
export function waitingPeriodExpired(wp: WaitingPeriodFacts | null | undefined): boolean | null {
  if (!wp || !wp.applies || wp.months == null || !wp.start_date || !wp.admission_date) return null;
  if (!ISO.test(wp.admission_date)) return null;
  const end = addMonthsIso(wp.start_date, wp.months);
  if (!end) return null;
  return end <= wp.admission_date;
}

/**
 * The model sometimes does the date arithmetic correctly in its rationale and
 * then still answers C2 "yes" (conditions hold) -- eval case A. When the
 * numbers say the waiting period had completed before admission, the clause's
 * own condition (a running waiting period) cannot hold, so C2 is "no".
 * Only ever corrects a "yes" to "no"; never the other direction, because a
 * not-yet-expired period does not by itself prove the rejection correct.
 */
export function reconcileWaitingPeriod(
  checks: Check[],
  wp: WaitingPeriodFacts | null | undefined
): { checks: Check[]; corrected: string | null } {
  const expired = waitingPeriodExpired(wp);
  if (expired !== true || !wp) return { checks, corrected: null };
  const end = addMonthsIso(wp.start_date!, wp.months!);
  const note = `Corrected by code: ${wp.start_date} + ${wp.months} months = ${end}, which is on or before the admission date ${wp.admission_date}, so the waiting period had completed.`;
  let corrected: string | null = null;
  const next = checks.map((c) => {
    if (c.id === "C2_CONDITIONS_HOLD" && c.answer === "yes") {
      corrected = note;
      return { ...c, answer: "no" as const, rationale: `${c.rationale} ${note}` };
    }
    return c;
  });
  return { checks: next, corrected };
}
