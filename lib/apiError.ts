/** Client-safe helper: extracts a human-readable message from an API error
 * response, which is {error:{code,message}} per lib/validation.ts. */
export function extractErrorMessage(json: unknown, fallback: string): string {
  if (json && typeof json === "object" && "error" in json) {
    const err = (json as { error: unknown }).error;
    if (err && typeof err === "object" && "message" in err) {
      const message = (err as { message: unknown }).message;
      if (typeof message === "string") return message;
    }
    if (typeof err === "string") return err;
  }
  return fallback;
}
