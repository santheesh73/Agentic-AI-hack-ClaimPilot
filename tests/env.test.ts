import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getEnv, _resetEnvCacheForTests } from "../lib/env";

const BASE = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

describe("getEnv", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    _resetEnvCacheForTests();
  });

  afterEach(() => {
    process.env = originalEnv;
    _resetEnvCacheForTests();
  });

  it("throws a single readable error listing every missing var", () => {
    process.env = { NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv;
    expect(() => getEnv()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(() => getEnv()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("requires GEMINI_API_KEY when LLM_PROVIDER=google (the default)", () => {
    process.env = { ...BASE } as unknown as NodeJS.ProcessEnv;
    expect(() => getEnv()).toThrow(/GEMINI_API_KEY/);
  });

  it("requires ANTHROPIC_API_KEY when LLM_PROVIDER=anthropic", () => {
    process.env = { ...BASE, LLM_PROVIDER: "anthropic" } as unknown as NodeJS.ProcessEnv;
    expect(() => getEnv()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("succeeds with a complete google config and defaults LLM_PROVIDER", () => {
    process.env = { ...BASE, GEMINI_API_KEY: "key" } as unknown as NodeJS.ProcessEnv;
    const env = getEnv();
    expect(env.LLM_PROVIDER).toBe("google");
  });

  it("succeeds with a complete anthropic config", () => {
    process.env = { ...BASE, LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "key" } as unknown as NodeJS.ProcessEnv;
    const env = getEnv();
    expect(env.LLM_PROVIDER).toBe("anthropic");
  });

  it("rejects a non-numeric MAX_TOKENS_PER_CASE", () => {
    process.env = { ...BASE, GEMINI_API_KEY: "key", MAX_TOKENS_PER_CASE: "not-a-number" } as unknown as NodeJS.ProcessEnv;
    expect(() => getEnv()).toThrow();
  });

  it("caches the result across calls", () => {
    process.env = { ...BASE, GEMINI_API_KEY: "key" } as unknown as NodeJS.ProcessEnv;
    const first = getEnv();
    process.env.GEMINI_API_KEY = undefined;
    const second = getEnv();
    expect(second).toBe(first);
  });

  it("passes when every var named in .env.example is filled in (deployment-readiness check)", () => {
    // Mirrors .env.example's variable set exactly, with ANTHROPIC_API_KEY/
    // MODEL_FAST/MODEL_STRONG left blank as .env.example itself leaves them --
    // this is what "copy .env.example to .env.local and fill in the required
    // ones" actually produces.
    process.env = {
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      LLM_PROVIDER: "google",
      GEMINI_API_KEY: "a-real-key",
      ANTHROPIC_API_KEY: "",
      MODEL_FAST: "",
      MODEL_STRONG: "",
    } as unknown as NodeJS.ProcessEnv;
    expect(() => getEnv()).not.toThrow();
  });

  it("fails with a readable error when .env.example is copied but left entirely blank", () => {
    process.env = {
      NEXT_PUBLIC_SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      LLM_PROVIDER: "google",
      GEMINI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      MODEL_FAST: "",
      MODEL_STRONG: "",
    } as unknown as NodeJS.ProcessEnv;
    expect(() => getEnv()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });
});
