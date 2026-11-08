import { describe, it, expect } from "vitest";
import {
  ApiError,
  errorResponse,
  notFoundResponse,
  parseJsonBody,
  CreateCaseBody,
  AnswerBody,
  SimulateBody,
  SampleBody,
} from "../lib/validation";

function fakeRequest(body: unknown): Request {
  return new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function fakeInvalidJsonRequest(): Request {
  return new Request("http://localhost/test", { method: "POST", body: "{not json" });
}

describe("errorResponse", () => {
  it("maps ApiError to {error:{code,message}} with its status", async () => {
    const res = errorResponse(new ApiError(400, "bad_input", "nope"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: { code: "bad_input", message: "nope" } });
  });

  it("maps an unknown error to a 500 internal_error", async () => {
    const res = errorResponse(new Error("boom"));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error.code).toBe("internal_error");
    expect(json.error.message).toBe("boom");
  });

  it("maps a non-Error throw to a 500 with its string form", async () => {
    const res = errorResponse("just a string");
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error.message).toBe("just a string");
  });
});

describe("notFoundResponse", () => {
  it("is a 404 with code not_found", async () => {
    const res = notFoundResponse();
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe("not_found");
  });
});

describe("parseJsonBody", () => {
  it("throws a 400 ApiError on invalid JSON", async () => {
    await expect(parseJsonBody(fakeInvalidJsonRequest() as never, CreateCaseBody)).rejects.toMatchObject({
      status: 400,
      code: "invalid_json",
    });
  });

  it("throws a 400 ApiError with the first Zod issue on schema failure", async () => {
    const req = fakeRequest({ days: -5 }) as never;
    await expect(parseJsonBody(req, SimulateBody)).rejects.toMatchObject({ status: 400, code: "invalid_body" });
  });

  it("returns the parsed, typed body on success", async () => {
    const req = fakeRequest({ sample: "a" }) as never;
    const result = await parseJsonBody(req, SampleBody);
    expect(result).toEqual({ sample: "a" });
  });
});

describe("CreateCaseBody", () => {
  it("accepts a minimal valid body", () => {
    expect(CreateCaseBody.safeParse({}).success).toBe(true);
  });

  it("rejects a non-positive claim amount", () => {
    expect(CreateCaseBody.safeParse({ claim_amount_inr: 0 }).success).toBe(false);
    expect(CreateCaseBody.safeParse({ claim_amount_inr: -100 }).success).toBe(false);
  });

  it("rejects a claim amount over 10 crore", () => {
    expect(CreateCaseBody.safeParse({ claim_amount_inr: 100_000_001 }).success).toBe(false);
  });

  it("accepts exactly 10 crore", () => {
    expect(CreateCaseBody.safeParse({ claim_amount_inr: 100_000_000 }).success).toBe(true);
  });
});

describe("AnswerBody", () => {
  it("accepts a record of string answers", () => {
    expect(AnswerBody.safeParse({ answers: { diagnosis_date: "March 2025" } }).success).toBe(true);
  });

  it("rejects a non-object answers value", () => {
    expect(AnswerBody.safeParse({ answers: "nope" }).success).toBe(false);
  });

  it("rejects an answer value over 2000 characters", () => {
    expect(AnswerBody.safeParse({ answers: { q: "x".repeat(2001) } }).success).toBe(false);
  });
});

describe("SimulateBody", () => {
  it("rejects zero, negative, non-integer and over-10-year values", () => {
    expect(SimulateBody.safeParse({ days: 0 }).success).toBe(false);
    expect(SimulateBody.safeParse({ days: -1 }).success).toBe(false);
    expect(SimulateBody.safeParse({ days: 1.5 }).success).toBe(false);
    expect(SimulateBody.safeParse({ days: 3651 }).success).toBe(false);
  });

  it("accepts a positive integer within range", () => {
    expect(SimulateBody.safeParse({ days: 15 }).success).toBe(true);
  });
});

describe("SampleBody", () => {
  it("accepts a, b, c only", () => {
    expect(SampleBody.safeParse({ sample: "a" }).success).toBe(true);
    expect(SampleBody.safeParse({ sample: "d" }).success).toBe(false);
  });
});
