import { describe, expect, it } from "vitest";
import {
  monitorCreateSchema,
  monitorUpdateSchema,
  normalizeMonitorUrl,
} from "../../packages/validation/src/index.ts";

const validMonitor = {
  name: " API monitor ",
  url: "https://example.com/api/products?category=books",
  method: "GET",
  intervalSeconds: 30,
  timeoutMs: 1000,
  expectedStatus: 100,
  status: "active",
};

describe("monitor create schema", () => {
  it("trims a name and accepts inclusive numeric bounds and supported enum values", () => {
    expect(monitorCreateSchema.parse(validMonitor)).toEqual({
      ...validMonitor,
      name: "API monitor",
      url: "https://example.com/api/products?category=books",
    });
    expect(monitorCreateSchema.parse({
      ...validMonitor,
      name: "x".repeat(100),
      url: "http://example.com",
      method: "OPTIONS",
      intervalSeconds: 86400,
      timeoutMs: 60000,
      expectedStatus: 599,
      status: "paused",
    })).toBeDefined();
  });

  it.each(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "accepts HTTP method %s",
    (method) => {
      expect(monitorCreateSchema.safeParse({ ...validMonitor, method }).success).toBe(true);
    },
  );

  it.each(["active", "paused"])("accepts status %s", (status) => {
    expect(monitorCreateSchema.safeParse({ ...validMonitor, status }).success).toBe(true);
  });

  it.each([
    ["empty name", { name: "   " }],
    ["long name", { name: "x".repeat(101) }],
    ["interval below minimum", { intervalSeconds: 29 }],
    ["interval above maximum", { intervalSeconds: 86401 }],
    ["timeout below minimum", { timeoutMs: 999 }],
    ["timeout above maximum", { timeoutMs: 60001 }],
    ["status below minimum", { expectedStatus: 99 }],
    ["status above maximum", { expectedStatus: 600 }],
    ["fractional interval", { intervalSeconds: 30.5 }],
    ["unknown method", { method: "TRACE" }],
    ["unknown status", { status: "deleted" }],
    ["numeric-string interval", { intervalSeconds: "30" }],
    ["numeric-string timeout", { timeoutMs: "1000" }],
    ["numeric-string expected status", { expectedStatus: "200" }],
  ])("rejects %s", (_label, override) => {
    expect(monitorCreateSchema.safeParse({ ...validMonitor, ...override }).success).toBe(false);
  });

  it.each(["name", "url", "method", "intervalSeconds", "timeoutMs", "expectedStatus", "status"])(
    "requires %s",
    (field) => {
      const input = { ...validMonitor };
      delete input[field as keyof typeof input];
      expect(monitorCreateSchema.safeParse(input).success).toBe(false);
    },
  );

  it.each(["projectId", "secret", "headers", "body"])("rejects unknown field %s", (field) => {
    expect(monitorCreateSchema.safeParse({ ...validMonitor, [field]: "not allowed" }).success).toBe(false);
  });
});

describe("monitor update schema", () => {
  it("accepts a nonempty partial configuration update", () => {
    expect(monitorUpdateSchema.parse({ name: "renamed" })).toEqual({ name: "renamed" });
    expect(monitorUpdateSchema.parse({ url: "https://example.com/new?x=1" })).toEqual({
      url: "https://example.com/new?x=1",
    });
  });

  it("rejects empty updates, status changes, and unknown fields", () => {
    for (const input of [{}, { status: "paused" }, { projectId: "project-id" }, { headers: {} }]) {
      expect(monitorUpdateSchema.safeParse(input).success).toBe(false);
    }
  });
});

describe("monitor URL syntax normalization", () => {
  it("allows query strings and applies WHATWG normalization", () => {
    expect(normalizeMonitorUrl("HTTPS://Example.COM:443/a/../api?q=hello%20world")).toBe(
      "https://example.com/api?q=hello%20world",
    );
  });

  it.each([
    "ftp://example.com/path",
    "https://user:pass@example.com/path",
    "https://example.com/path#fragment",
    "https://example.com/#",
    "https://localhost/",
    "https://api.localhost/",
    "https://service.internal/",
    "https://printer/",
    "https://example.test/",
    "https://127.1/",
    "https://0177.0.0.1/",
    "https://0x7f000001/",
    "https://2130706433/",
  ])("rejects unsafe or ambiguous URL syntax: %s", (value) => {
    expect(() => normalizeMonitorUrl(value)).toThrow();
  });

  it.each([
    "https://example.com:bad/",
    "https://example.com/%zz",
    "https:///missing-host",
    "https://example.com\\@evil.example/",
    "not a URL",
  ])("rejects malformed URL: %s", (value) => {
    expect(() => normalizeMonitorUrl(value)).toThrow();
  });

  it("accepts canonical dotted-decimal IPv4 and syntactically valid IPv6 for later admission", () => {
    expect(normalizeMonitorUrl("http://192.0.2.1/health")).toBe("http://192.0.2.1/health");
    expect(normalizeMonitorUrl("https://[2001:db8::1]/health")).toBe("https://[2001:db8::1]/health");
  });
});
