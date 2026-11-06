import { describe, expect, it } from "vitest";
import { validateEnvironment } from "../../packages/validation/src/index.ts";

describe("validateEnvironment", () => {
  it("parses a complete environment", () => {
    expect(validateEnvironment({
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      MAILPIT_SMTP_HOST: "localhost",
      MAILPIT_SMTP_PORT: "1025",
    }).PORT).toBe(3000);
  });
});
