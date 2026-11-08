import { describe, it, expect } from "vitest";
import { errorMessage } from "../lib/agent/machine";

describe("errorMessage", () => {
  it("uses Error.message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });
  it("reads message (and details) from a plain PostgrestError-shaped object", () => {
    expect(errorMessage({ code: "23505", message: "duplicate key", details: "Key (case_id, short_id) exists." })).toBe(
      "duplicate key (Key (case_id, short_id) exists.)"
    );
    expect(errorMessage({ message: "no details", details: null })).toBe("no details");
  });
  it("never returns [object Object]", () => {
    expect(errorMessage({ code: 1 })).toBe('{"code":1}');
    expect(errorMessage("plain string")).toBe("plain string");
  });
});
