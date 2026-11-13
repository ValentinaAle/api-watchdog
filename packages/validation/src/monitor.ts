import { z } from "zod";
import { isIP } from "node:net";

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

type AddressClassification = "public" | "prohibited";

const prohibitedIpv4Ranges: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // This network
  [0x0a000000, 8], // Private use
  [0x64400000, 10], // Shared address space / CGNAT
  [0x7f000000, 8], // Loopback
  [0xa9fe0000, 16], // Link-local, including cloud metadata
  [0xac100000, 12], // Private use
  [0xc0000000, 24], // IETF protocol assignments
  [0xc0000200, 24], // Documentation
  [0xc01fc400, 24], // AS112 special-use
  [0xc034c100, 24], // AMT special-use
  [0xc0586300, 24], // Deprecated 6to4 relay anycast
  [0xc0a80000, 16], // Private use
  [0xc0af3000, 24], // AS112 special-use
  [0xc6120000, 15], // Benchmarking
  [0xc6336400, 24], // Documentation
  [0xcb007100, 24], // AS112 special-use
  [0xe0000000, 4], // Multicast
  [0xf0000000, 4], // Reserved / broadcast
];

function ipv4ToNumber(address: string): number | undefined {
  if (!isCanonicalIpv4(address)) return undefined;
  return address.split(".").reduce((value, octet) => (value * 256) + Number(octet), 0);
}

function ipv4InRange(address: number, network: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (network & mask);
}

function ipv6ToBigInt(address: string): bigint | undefined {
  if (isIP(address) !== 6) return undefined;
  let source = address.toLowerCase();
  if (source.includes(".")) {
    const lastColon = source.lastIndexOf(":");
    const ipv4 = ipv4ToNumber(source.slice(lastColon + 1));
    if (ipv4 === undefined) return undefined;
    const high = ((ipv4 >>> 16) & 0xffff).toString(16);
    const low = (ipv4 & 0xffff).toString(16);
    source = `${source.slice(0, lastColon)}:${high}:${low}`;
  }

  const halves = source.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[\da-f]{1,4}$/.test(group))) return undefined;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function ipv6InRange(address: bigint, network: bigint, prefix: number): boolean {
  const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
  return (address & mask) === (network & mask);
}

function ipv6Network(groups: string): bigint {
  return ipv6ToBigInt(groups) ?? 0n;
}

/** Classifies an IP without resolving or making any network request. */
export function classifyMonitorAddress(address: string): AddressClassification {
  const version = isIP(address);
  if (version === 4) {
    const numeric = ipv4ToNumber(address);
    if (numeric === undefined) return "prohibited";
    return prohibitedIpv4Ranges.some(([network, prefix]) => ipv4InRange(numeric, network, prefix))
      ? "prohibited"
      : "public";
  }
  if (version !== 6) return "prohibited";

  const numeric = ipv6ToBigInt(address);
  if (numeric === undefined) return "prohibited";
  const globalUnicast = ipv6InRange(numeric, ipv6Network("2000::"), 3);
  const specialUse =
    ipv6InRange(numeric, ipv6Network("2001::"), 23) ||
    ipv6InRange(numeric, ipv6Network("2001:db8::"), 32) ||
    ipv6InRange(numeric, ipv6Network("2002::"), 16) ||
    ipv6InRange(numeric, ipv6Network("3fff::"), 20);
  return globalUnicast && !specialUse ? "public" : "prohibited";
}

export type MonitorDnsResolver = {
  resolve4(hostname: string): Promise<readonly string[]>;
  resolve6(hostname: string): Promise<readonly string[]>;
};

export type MonitorExecutionAddress = Readonly<{
  address: string;
  family: 4 | 6;
}>;

export type MonitorExecutionTarget = Readonly<{
  normalizedUrl: string;
  originalHostname: string;
  protocol: "http:" | "https:";
  port: number;
  addresses: readonly MonitorExecutionAddress[];
}>;

export type MonitorAdmissionErrorCode = "UNSAFE_TARGET" | "TARGET_UNVERIFIABLE";

export class MonitorTargetAdmissionError extends Error {
  constructor(readonly code: MonitorAdmissionErrorCode) {
    super(code === "UNSAFE_TARGET" ? "Monitor target is not permitted" : "Monitor target could not be verified");
    this.name = "MonitorTargetAdmissionError";
  }
}

export type MonitorAdmissionOptions = {
  resolver: MonitorDnsResolver;
  timeoutMs?: number;
};

function isAdmissibleDnsHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  const specialUseSuffixes = [
    ".localhost", ".local", ".internal", ".test", ".example", ".invalid", ".onion",
    ".arpa", ".corp", ".home", ".lan", ".intranet", ".private", ".svc", ".cluster.local",
  ];
  return normalized !== "localhost" && normalized !== "metadata.google" &&
    !normalized.endsWith(".metadata.google") &&
    !specialUseSuffixes.some((suffix) => normalized.endsWith(suffix)) &&
    !isReservedHostname(normalized);
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

/** Admission only: this does not fetch a target or authorize a future connection. */
export async function admitMonitorTarget(
  value: string,
  options: MonitorAdmissionOptions,
): Promise<string> {
  let normalizedUrl: string;
  try {
    normalizedUrl = normalizeMonitorUrl(value);
  } catch {
    throw new MonitorTargetAdmissionError("UNSAFE_TARGET");
  }
  const parsed = new URL(normalizedUrl);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) !== 0) {
    if (classifyMonitorAddress(hostname) !== "public") {
      throw new MonitorTargetAdmissionError("UNSAFE_TARGET");
    }
    return normalizedUrl;
  }
  if (!isAdmissibleDnsHostname(hostname)) throw new MonitorTargetAdmissionError("UNSAFE_TARGET");

  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new MonitorTargetAdmissionError("TARGET_UNVERIFIABLE");
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const lookups = Promise.all([
      Promise.resolve().then(() => options.resolver.resolve4(hostname)),
      Promise.resolve().then(() => options.resolver.resolve6(hostname)),
    ]);
    const answers = await Promise.race([
      lookups,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("DNS admission timeout")), timeoutMs);
      }),
    ]);
    const [ipv4Answers, ipv6Answers] = answers;
    if (!Array.isArray(ipv4Answers) || !Array.isArray(ipv6Answers)) throw new Error("Malformed DNS answer");
    const allAnswers: unknown[] = [...ipv4Answers, ...ipv6Answers];
    if (allAnswers.length === 0) throw new Error("No DNS answers");
    if (allAnswers.some((answer) =>
      typeof answer !== "string" || classifyMonitorAddress(answer) !== "public",
    )) {
      throw new MonitorTargetAdmissionError("UNSAFE_TARGET");
    }
    return normalizedUrl;
  } catch (error) {
    if (error instanceof MonitorTargetAdmissionError) throw error;
    throw new MonitorTargetAdmissionError("TARGET_UNVERIFIABLE");
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * Resolves a monitor target immediately before a future connection.
 * This only returns immutable, validated address metadata; it never opens a socket.
 */
export async function resolveMonitorExecutionTarget(
  value: string,
  resolver: MonitorDnsResolver,
): Promise<MonitorExecutionTarget> {
  let normalizedUrl: string;
  try {
    normalizedUrl = normalizeMonitorUrl(value);
  } catch {
    throw new MonitorTargetAdmissionError("UNSAFE_TARGET");
  }

  const parsed = new URL(normalizedUrl);
  const originalHostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const protocol = parsed.protocol as "http:" | "https:";
  const port = parsed.port === "" ? (protocol === "https:" ? 443 : 80) : Number(parsed.port);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new MonitorTargetAdmissionError("TARGET_UNVERIFIABLE");
  }

  const literalFamily = isIP(originalHostname);
  if (literalFamily !== 0) {
    if (classifyMonitorAddress(originalHostname) !== "public") {
      throw new MonitorTargetAdmissionError("UNSAFE_TARGET");
    }
    return Object.freeze({
      normalizedUrl,
      originalHostname,
      protocol,
      port,
      addresses: Object.freeze([Object.freeze({ address: originalHostname, family: literalFamily as 4 | 6 })]),
    });
  }

  if (!isAdmissibleDnsHostname(originalHostname)) {
    throw new MonitorTargetAdmissionError("UNSAFE_TARGET");
  }

  try {
    const [ipv4Answers, ipv6Answers] = await Promise.all([
      Promise.resolve().then(() => resolver.resolve4(originalHostname)),
      Promise.resolve().then(() => resolver.resolve6(originalHostname)),
    ]);
    if (!Array.isArray(ipv4Answers) || !Array.isArray(ipv6Answers)) {
      throw new Error("Malformed DNS answer");
    }

    const addresses: MonitorExecutionAddress[] = [
      ...ipv4Answers.map((address) => ({ address, family: 4 as const })),
      ...ipv6Answers.map((address) => ({ address, family: 6 as const })),
    ];
    if (addresses.length === 0 || addresses.some(({ address, family }) =>
      typeof address !== "string" || isIP(address) !== family || classifyMonitorAddress(address) !== "public",
    )) {
      throw new Error("Unsafe DNS answer");
    }

    return Object.freeze({
      normalizedUrl,
      originalHostname,
      protocol,
      port,
      addresses: Object.freeze(addresses.map((address) => Object.freeze(address))),
    });
  } catch (error) {
    if (error instanceof MonitorTargetAdmissionError) throw error;
    throw new MonitorTargetAdmissionError("TARGET_UNVERIFIABLE");
  }
}

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
