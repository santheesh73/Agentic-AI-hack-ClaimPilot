import { verifyDraft, type EvidenceRow, type PageRow } from "../verify";

export function verifyCitationsTool(
  bodyMd: string,
  evidenceById: Record<string, EvidenceRow>,
  pagesById: Record<string, PageRow>
) {
  return verifyDraft(bodyMd, evidenceById, pagesById);
}
