import { z } from "zod";

const httpMethods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
const monitorStatuses = ["active", "paused"] as const;
const reservedHostSuffixes = new Set([
  "arpa",
  "corp",
  "example",
  "home",
  "home.arpa",
  "internal",
  "intranet",
  "invalid",
  "lan",
  "local",
  "localhost",
  "localdomain",
  "onion",
  "test",
]);

const canonicalIpv4Pattern = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/;

function isCanonicalIpv4(hostname: string): boolean {
  return canonicalIpv4Pattern.test(hostname) && hostname.split(".").every((octet) => Number(octet) <= 255);
}

function isIpv4Like(hostname: string): boolean {
  return hostname.split(".").every((label) => /^(?:\d+|0x[\da-f]*)$/i.test(label));
}

function isIpv6Literal(hostname: string): boolean {
  return hostname.startsWith("[") && hostname.endsWith("]");
}

function isReservedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized.split(".").length < 2 ||
    [...reservedHostSuffixes].some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

/** Parse and normalize an HTTP(S) URL without resolving its hostname or contacting it. */
export function normalizeMonitorUrl(value: string): string {
  if (value.trim() !== value || /%(?![\da-f]{2})/i.test(value)) {
    throw new Error("Invalid monitor URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid monitor URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Invalid monitor URL");
  }
  if (url.username || url.password || value.includes("#")) {
    throw new Error("Invalid monitor URL");
  }

  const rawAuthority = value.match(/^https?:\/\/([^/?#]*)/i)?.[1];
  if (!rawAuthority || rawAuthority.includes("@") || rawAuthority.includes("\\")) {
    throw new Error("Invalid monitor URL");
  }
  const rawHostname = rawAuthority.replace(/:\d*$/, "");
  if (!rawHostname || !url.hostname || url.hostname.endsWith(".")) {
    throw new Error("Invalid monitor URL");
  }

  const hostname = url.hostname.toLowerCase();
  if (isIpv4Like(rawHostname) && !isCanonicalIpv4(rawHostname)) {
    throw new Error("Invalid monitor URL");
  }
  if (isIpv6Literal(hostname)) {
    // The WHATWG parser has already verified IPv6 syntax. Classification is a later admission step.
    return url.toString();
  }

  if (isCanonicalIpv4(hostname)) {
    return url.toString();
  }
  if (isIpv4Like(hostname) || isReservedHostname(hostname)) {
    throw new Error("Invalid monitor URL");
  }

  return url.toString();
}

const monitorUrlSchema = z.string().transform((value, context) => {
  try {
    return normalizeMonitorUrl(value);
  } catch {
    context.addIssue({ code: "custom", message: "Invalid monitor URL" });
    return z.NEVER;
  }
});

const monitorNameSchema = z.string().trim().min(1).max(100);
const monitorMethodSchema = z.enum(httpMethods);
const monitorStatusSchema = z.enum(monitorStatuses);

const monitorConfigurationShape = {
  name: monitorNameSchema,
  url: monitorUrlSchema,
  method: monitorMethodSchema,
  intervalSeconds: z.number().int().min(30).max(86_400),
  timeoutMs: z.number().int().min(1_000).max(60_000),
  expectedStatus: z.number().int().min(100).max(599),
};

export const monitorCreateSchema = z.object({
  ...monitorConfigurationShape,
  status: monitorStatusSchema,
}).strict();

export const monitorUpdateSchema = z.object(monitorConfigurationShape)
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, { message: "At least one field is required" });

export type MonitorCreateInput = z.infer<typeof monitorCreateSchema>;
export type MonitorUpdateInput = z.infer<typeof monitorUpdateSchema>;
export type MonitorHttpMethod = z.infer<typeof monitorMethodSchema>;
export type MonitorStatus = z.infer<typeof monitorStatusSchema>;
