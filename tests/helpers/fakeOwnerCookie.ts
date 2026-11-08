// Route handlers resolve the current browser via lib/db.ts's
// getOwnerId()/getOrCreateOwnerId(), which read next/headers' cookies() --
// unusable outside a real request context. Tests mock lib/db.ts wholesale
// (see fakeSupabase usage) and substitute these simple in-memory stand-ins.
let currentOwnerId: string | null = null;

export function setFakeOwner(id: string | null) {
  currentOwnerId = id;
}

export async function fakeGetOwnerId(): Promise<string | null> {
  return currentOwnerId;
}

export async function fakeGetOrCreateOwnerId(): Promise<string> {
  if (!currentOwnerId) currentOwnerId = "owner-1";
  return currentOwnerId;
}
