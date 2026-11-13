import { describe, expect, it, vi } from "vitest";
import {
  admitMonitorTarget,
  classifyMonitorAddress,
  monitorCreateSchema,
  monitorUpdateSchema,
  normalizeMonitorUrl,
  resolveMonitorExecutionTarget,
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

describe("monitor destination address policy", () => {
  it.each([
    "0.1.2.3", "10.0.0.1", "100.64.0.1", "100.127.255.254",
    "127.0.0.1", "169.254.1.1", "169.254.169.254", "172.16.0.1",
    "172.31.255.254", "192.0.0.1", "192.0.2.1", "192.88.99.1",
    "192.168.1.1", "192.175.48.1", "198.18.0.1", "198.19.255.254", "198.51.100.1",
    "203.0.113.1", "224.0.0.1", "240.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:8.8.8.8", "fc00::1", "fd12:3456::1",
    "fe80::1", "ff02::1", "2001:db8::1", "2001:2::1", "2001::1",
    "2002:c000:0201::1", "3fff::1", "64:ff9b::808:808",
    "not-an-address", "8.8.8", "127.1",
  ])("prohibits non-public or ambiguous address %s", (address) => {
    expect(classifyMonitorAddress(address)).toBe("prohibited");
  });

  it.each(["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"])(
    "permits public unicast address %s",
    (address) => expect(classifyMonitorAddress(address)).toBe("public"),
  );
});

describe("monitor target admission", () => {
  const resolver = { resolve4: vi.fn(), resolve6: vi.fn() };

  it.each([
    "https://127.0.0.1/health", "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/health", "https://[::ffff:8.8.8.8]/health",
    "https://[2001:db8::1]/health", "https://8.8.8/health",
    "https://metadata.google/computeMetadata/v1/", "https://service.internal/health",
  ])("rejects prohibited literal or special-use hostname without DNS: %s", async (url) => {
    await expect(admitMonitorTarget(url, { resolver })).rejects.toMatchObject({ code: "UNSAFE_TARGET" });
    expect(resolver.resolve4).not.toHaveBeenCalled();
    expect(resolver.resolve6).not.toHaveBeenCalled();
  });

  it.each(["https://1.1.1.1/health", "https://[2606:4700:4700::1111]/health"])(
    "admits an explicitly public literal without DNS: %s",
    async (url) => {
      await expect(admitMonitorTarget(url, { resolver })).resolves.toBe(url);
      expect(resolver.resolve4).not.toHaveBeenCalled();
      expect(resolver.resolve6).not.toHaveBeenCalled();
    },
  );
});

describe("injected DNS monitor target admission", () => {
  const publicA = ["8.8.8.8"];
  const publicAaaa = ["2606:4700:4700::1111"];
  const url = "https://monitor.example.com/health?token=not-logged";

  function createResolver(resolve4 = publicA, resolve6 = publicAaaa) {
    return {
      resolve4: vi.fn(async (_hostname: string) => resolve4),
      resolve6: vi.fn(async (_hostname: string) => resolve6),
    };
  }

  it("resolves both families by hostname and never fetches the target", async () => {
    const resolver = createResolver();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(admitMonitorTarget(url, { resolver })).resolves.toBe(url);
      expect(resolver.resolve4).toHaveBeenCalledExactlyOnceWith("monitor.example.com");
      expect(resolver.resolve6).toHaveBeenCalledExactlyOnceWith("monitor.example.com");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([[publicA, []], [[], publicAaaa]])("accepts one non-empty family with public answers", async (a, aaaa) => {
    const resolver = createResolver(a as string[], aaaa as string[]);
    await expect(admitMonitorTarget(url, { resolver })).resolves.toBe(url);
  });

  it.each([
    [["8.8.8.8", "10.0.0.1"], publicAaaa],
    [publicA, ["2606:4700:4700::1111", "fe80::1"]],
    [["not-an-address"], publicAaaa],
  ])("rejects the entire set if any DNS answer is unsafe or malformed", async (a, aaaa) => {
    const resolver = createResolver(a as string[], aaaa as string[]);
    await expect(admitMonitorTarget(url, { resolver })).rejects.toMatchObject({ code: "UNSAFE_TARGET" });
  });

  it("rejects empty resolver results", async () => {
    await expect(admitMonitorTarget(url, { resolver: createResolver([], []) }))
      .rejects.toMatchObject({ code: "TARGET_UNVERIFIABLE" });
  });

  it.each(["A", "AAAA"])("fails closed when %s resolution fails", async (family) => {
    const resolver = createResolver();
    if (family === "A") resolver.resolve4.mockRejectedValue(new Error("private resolver detail"));
    else resolver.resolve6.mockRejectedValue(new Error("private resolver detail"));
    await expect(admitMonitorTarget(url, { resolver })).rejects.toMatchObject({ code: "TARGET_UNVERIFIABLE" });
  });

  it("fails closed when DNS exceeds the configured timeout", async () => {
    const resolver = createResolver();
    resolver.resolve6.mockImplementation(() => new Promise(() => undefined));
    await expect(admitMonitorTarget(url, { resolver, timeoutMs: 5 }))
      .rejects.toMatchObject({ code: "TARGET_UNVERIFIABLE" });
  });
});

describe("execution-time monitor target resolution", () => {
  const targetUrl = "https://monitor.example.com:8443/health?token=not-logged";

  function createResolver(resolve4: unknown = ["8.8.8.8"], resolve6: unknown = ["2606:4700:4700::1111"]) {
    return {
      resolve4: vi.fn(async (_hostname: string) => resolve4 as string[]),
      resolve6: vi.fn(async (_hostname: string) => resolve6 as string[]),
    };
  }

  it("returns immutable normalized metadata only after all A and AAAA answers are public", async () => {
    const resolver = createResolver();

    const target = await resolveMonitorExecutionTarget(targetUrl, resolver);

    expect(target).toEqual({
      normalizedUrl: targetUrl,
      originalHostname: "monitor.example.com",
      protocol: "https:",
      port: 8443,
      addresses: [
        { address: "8.8.8.8", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ],
    });
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.isFrozen(target.addresses)).toBe(true);
    expect(resolver.resolve4).toHaveBeenCalledExactlyOnceWith("monitor.example.com");
    expect(resolver.resolve6).toHaveBeenCalledExactlyOnceWith("monitor.example.com");
  });

  it.each([
    [["8.8.8.8", "10.0.0.1"], ["2606:4700:4700::1111"]],
    [["8.8.8.8"], ["2606:4700:4700::1111", "fe80::1"]],
    [["not-an-address"], ["2606:4700:4700::1111"]],
    ["not-an-array", []],
    [[], []],
  ])("fails closed for mixed, malformed, or empty A/AAAA answers", async (a, aaaa) => {
    await expect(resolveMonitorExecutionTarget(targetUrl, createResolver(a, aaaa)))
      .rejects.toMatchObject({ code: "TARGET_UNVERIFIABLE" });
  });

  it("fails closed when either family resolver rejects without exposing target details", async () => {
    const resolver = createResolver();
    resolver.resolve6.mockRejectedValue(new Error("https://secret.example/path?token=private 10.0.0.1"));

    const failure = await resolveMonitorExecutionTarget(targetUrl, resolver).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "TARGET_UNVERIFIABLE", message: "Monitor target could not be verified" });
    expect(String(failure)).not.toContain("secret.example");
    expect(String(failure)).not.toContain("10.0.0.1");
  });

  it("uses a public literal IP directly without calling DNS", async () => {
    const resolver = createResolver();

    await expect(resolveMonitorExecutionTarget("https://1.1.1.1/health", resolver)).resolves.toEqual({
      normalizedUrl: "https://1.1.1.1/health",
      originalHostname: "1.1.1.1",
      protocol: "https:",
      port: 443,
      addresses: [{ address: "1.1.1.1", family: 4 }],
    });
    expect(resolver.resolve4).not.toHaveBeenCalled();
    expect(resolver.resolve6).not.toHaveBeenCalled();
  });

  it("returns a validated public IPv6 literal without DNS", async () => {
    const resolver = createResolver();

    await expect(resolveMonitorExecutionTarget("https://[2606:4700:4700::1111]/", resolver)).resolves.toMatchObject({
      originalHostname: "2606:4700:4700::1111",
      addresses: [{ address: "2606:4700:4700::1111", family: 6 }],
    });
    expect(resolver.resolve4).not.toHaveBeenCalled();
    expect(resolver.resolve6).not.toHaveBeenCalled();
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
