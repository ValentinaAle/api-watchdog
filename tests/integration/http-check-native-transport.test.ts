import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer, request as nativeHttpsRequest, type Server as HttpsServer } from "node:https";
import { EventEmitter, once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeHttpTransport, createNativeHttpTransportForTest } from "../../packages/check-engine/src/native-transport.ts";
import type { TransportRequest } from "../../packages/check-engine/src/types.ts";

const monitoredHost = "pinned-target.invalid";
const secureMonitoredHost = "monitor.test";
const selectedAddress = { address: "127.0.0.1", family: 4 as const };
let server: Server | undefined;
let httpsServer: HttpsServer | undefined;
let certificateDirectory: string | undefined;
let certificateAuthority: string;
let certificate: string;
let privateKey: string;

async function createCertificateFixture() {
  certificateDirectory = await mkdtemp(join(tmpdir(), "api-watchdog-https-"));
  const configPath = join(certificateDirectory, "san.cnf");
  await writeFile(configPath, "subjectAltName=DNS:monitor.test\n");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(certificateDirectory, "ca.key"),
    "-out", join(certificateDirectory, "ca.crt"), "-subj", "/CN=API Watchdog Test CA", "-days", "1",
  ], { stdio: "ignore" });
  execFileSync("openssl", [
    "req", "-newkey", "rsa:2048", "-nodes", "-keyout", join(certificateDirectory, "server.key"),
    "-out", join(certificateDirectory, "server.csr"), "-subj", "/CN=monitor.test",
  ], { stdio: "ignore" });
  execFileSync("openssl", [
    "x509", "-req", "-in", join(certificateDirectory, "server.csr"), "-CA", join(certificateDirectory, "ca.crt"),
    "-CAkey", join(certificateDirectory, "ca.key"), "-CAcreateserial", "-out", join(certificateDirectory, "server.crt"),
    "-days", "1", "-extfile", configPath,
  ], { stdio: "ignore" });
  [certificateAuthority, certificate, privateKey] = await Promise.all([
    readFile(join(certificateDirectory, "ca.crt"), "utf8"),
    readFile(join(certificateDirectory, "server.crt"), "utf8"),
    readFile(join(certificateDirectory, "server.key"), "utf8"),
  ]);
}

async function startHttpsFixture(statusCode = 200, location?: string) {
  const requests: Array<{ host?: string; url?: string; servername?: string }> = [];
  httpsServer = createHttpsServer({ cert: certificate, key: privateKey }, (request, response) => {
    requests.push({ host: request.headers.host, url: request.url, servername: request.socket.servername });
    response.writeHead(statusCode, location ? { location } : undefined);
    response.end("fixture");
  });
  httpsServer.listen(0, "127.0.0.1");
  await once(httpsServer, "listening");
  const address = httpsServer.address();
  if (!address || typeof address === "string") throw new Error("HTTPS fixture did not bind to TCP");
  return { port: address.port, requests };
}

async function startPendingHttpsFixture() {
  let markRequestStarted: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    markRequestStarted = resolve;
  });
  let socketClosed: Promise<unknown> | undefined;
  httpsServer = createHttpsServer({ cert: certificate, key: privateKey }, (request) => {
    socketClosed = new Promise((resolve) => {
      (request.socket as Socket).once("close", resolve);
    });
    markRequestStarted();
  });
  httpsServer.listen(0, "127.0.0.1");
  await once(httpsServer, "listening");
  const address = httpsServer.address();
  if (!address || typeof address === "string") throw new Error("HTTPS fixture did not bind to TCP");
  return {
    port: address.port,
    requestStarted,
    async waitForSocketClose() {
      await requestStarted;
      if (!socketClosed) throw new Error("HTTPS fixture did not receive a socket");
      await socketClosed;
    },
  };
}

async function startFixture(statusCode = 200, location?: string) {
  const requests: Array<{ host?: string; url?: string }> = [];
  server = createServer((request, response) => {
    requests.push({ host: request.headers.host, url: request.url });
    response.writeHead(statusCode, location ? { location } : undefined);
    response.end("fixture");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind to TCP");
  return { port: address.port, requests };
}

function request(port: number, signal = new AbortController().signal): TransportRequest {
  return {
    target: {
      normalizedUrl: `http://${monitoredHost}:${port}/health?private=value`,
      originalHostname: monitoredHost,
      protocol: "http:",
      port,
      addresses: [selectedAddress],
    },
    address: selectedAddress,
    method: "GET",
    timeoutMs: 1_000,
    maxResponseBytes: 1_048_576,
    signal,
  };
}

function httpsRequest(port: number, hostname = secureMonitoredHost): TransportRequest {
  return {
    ...request(port),
    target: {
      normalizedUrl: `https://${hostname}:${port}/health?private=value`,
      originalHostname: hostname,
      protocol: "https:",
      port,
      addresses: [selectedAddress],
    },
  };
}

function controlledTransportFixture(statusCode = 200) {
  const response = Object.assign(new EventEmitter(), {
    statusCode,
    complete: false,
    resumeCalls: 0,
    resume() {
      response.resumeCalls += 1;
    },
    destroyCalls: 0,
    destroy() {
      response.destroyCalls += 1;
      response.emit("close");
    },
  });
  const socket = Object.assign(new EventEmitter(), {
    remoteAddress: selectedAddress.address,
    destroyed: false,
    destroyCalls: 0,
    destroy() {
      if (socket.destroyed) return;
      socket.destroyed = true;
      socket.destroyCalls += 1;
      socket.emit("close");
    },
  });
  const requestListeners: { callback?: (value: typeof response) => void } = {};
  const clientRequest = Object.assign(new EventEmitter(), {
    socket,
    destroyCalls: 0,
    destroy() {
      clientRequest.destroyCalls += 1;
      socket.destroy();
    },
    end() {
      queueMicrotask(() => {
        clientRequest.emit("socket", socket);
        socket.emit("connect");
        requestListeners.callback?.(response);
      });
    },
  });
  const requestFactory = ((_options: unknown, callback: (value: typeof response) => void) => {
    requestListeners.callback = callback;
    return clientRequest;
  }) as typeof import("node:http").request;

  return { clientRequest, requestFactory, response, socket };
}

afterEach(async () => {
  if (server) {
    server.close();
    await once(server, "close");
    server = undefined;
  }
  if (httpsServer) {
    httpsServer.close();
    await once(httpsServer, "close");
    httpsServer = undefined;
  }
});

beforeAll(createCertificateFixture);

afterAll(async () => {
  if (certificateDirectory) await rm(certificateDirectory, { recursive: true, force: true });
});

describe("native pinned HTTP transport", () => {
  it("connects only through the selected address and preserves the original Host", async () => {
    const fixture = await startFixture();
    const transport = createNativeHttpTransport();

    await expect(transport.execute(request(fixture.port))).resolves.toEqual({ statusCode: 200 });

    expect(fixture.requests).toEqual([{ host: `${monitoredHost}:${fixture.port}`, url: "/health?private=value" }]);
  });

  it("waits for response end and socket close before resolving success", async () => {
    const controlled = controlledTransportFixture();
    const transport = createNativeHttpTransportForTest(controlled.requestFactory);
    const result = transport.execute(request(8080));
    let settled = false;
    void result.then(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(controlled.response.resumeCalls).toBe(1);
    expect(settled).toBe(false);

    controlled.response.complete = true;
    controlled.response.emit("end");
    await Promise.resolve();
    expect(settled).toBe(false);

    const socketClosed = once(controlled.socket, "close");
    controlled.socket.destroy();
    await socketClosed;
    await expect(result).resolves.toEqual({ statusCode: 200 });

    expect(controlled.socket.destroyed).toBe(true);
    expect(controlled.clientRequest.listenerCount("error")).toBe(0);
    expect(controlled.socket.listenerCount("connect")).toBe(0);
    expect(controlled.response.listenerCount("end")).toBe(0);
    expect(controlled.response.listenerCount("close")).toBe(0);
  });

  it("cleans response and request listeners after a response error", async () => {
    const controlled = controlledTransportFixture();
    const transport = createNativeHttpTransportForTest(controlled.requestFactory);
    const result = transport.execute(request(8080));

    await Promise.resolve();
    await Promise.resolve();
    const socketClosed = once(controlled.socket, "close");
    controlled.response.emit("error", new Error("fixture response failure"));

    await expect(result).rejects.toMatchObject({ outcome: "connection_failure" });
    await socketClosed;
    expect(controlled.clientRequest.destroyCalls).toBe(1);
    expect(controlled.response.destroyCalls).toBe(1);
    expect(controlled.socket.destroyed).toBe(true);
    expect(controlled.clientRequest.listenerCount("error")).toBe(0);
    expect(controlled.socket.listenerCount("connect")).toBe(0);
    expect(controlled.response.listenerCount("error")).toBe(0);
    expect(controlled.response.listenerCount("end")).toBe(0);
  });

  it("cleans request and socket listeners after a request error", async () => {
    const controlled = controlledTransportFixture();
    const transport = createNativeHttpTransportForTest(controlled.requestFactory);
    const result = transport.execute(request(8080));

    await Promise.resolve();
    await Promise.resolve();
    const socketClosed = once(controlled.socket, "close");
    controlled.clientRequest.emit("error", new Error("fixture request failure"));

    await expect(result).rejects.toMatchObject({ outcome: "connection_failure" });
    await socketClosed;
    expect(controlled.clientRequest.destroyCalls).toBe(1);
    expect(controlled.socket.destroyed).toBe(true);
    expect(controlled.clientRequest.listenerCount("error")).toBe(0);
    expect(controlled.socket.listenerCount("connect")).toBe(0);
    expect(controlled.response.listenerCount("end")).toBe(0);
  });

  it("destroys a pending request and releases listeners when aborted", async () => {
    const controlled = controlledTransportFixture();
    const controller = new AbortController();
    const transport = createNativeHttpTransportForTest(controlled.requestFactory);
    const result = transport.execute(request(8080, controller.signal));

    await Promise.resolve();
    await Promise.resolve();
    const socketClosed = once(controlled.socket, "close");
    controller.abort();

    await expect(result).rejects.toMatchObject({ outcome: "connection_failure" });
    await socketClosed;
    expect(controlled.clientRequest.destroyCalls).toBe(1);
    expect(controlled.response.destroyCalls).toBe(1);
    expect(controlled.socket.destroyed).toBe(true);
    expect(controlled.clientRequest.listenerCount("error")).toBe(0);
    expect(controlled.socket.listenerCount("connect")).toBe(0);
    expect(controlled.response.listenerCount("end")).toBe(0);
    expect(controlled.response.listenerCount("close")).toBe(0);
  });

  it.each([301, 302, 307, 308])("treats %i redirects as a terminal response", async (statusCode) => {
    const fixture = await startFixture(statusCode, "/next");

    await expect(createNativeHttpTransport().execute(request(fixture.port))).resolves.toEqual({ statusCode });

    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.url).toBe("/health?private=value");
  });

  it("rejects an observable peer address mismatch without exposing the peer", async () => {
    const fixture = await startFixture();
    const fakeRequest = Object.assign(new EventEmitter(), {
      socket: Object.assign(new EventEmitter(), { remoteAddress: "127.0.0.2" }),
      destroy(error?: Error) {
        if (error) queueMicrotask(() => fakeRequest.emit("error", error));
      },
      end() {
        queueMicrotask(() => {
          fakeRequest.emit("socket", fakeRequest.socket);
          fakeRequest.socket.emit("connect");
        });
      },
    });
    const requestFactory = ((_options: unknown, _callback: unknown) => fakeRequest) as typeof import("node:http").request;

    await expect(createNativeHttpTransportForTest(requestFactory).execute(request(fixture.port))).rejects.toMatchObject({
      outcome: "connection_failure",
    });
  });

  it("rejects a target whose protocol is not native HTTP in this slice", async () => {
    const fixture = await startFixture();
    const httpsRequest = {
      ...request(fixture.port),
      target: {
        ...request(fixture.port).target,
        protocol: "https:" as const,
      },
    };

    await expect(createNativeHttpTransport().execute(httpsRequest)).rejects.toMatchObject({
      outcome: "tls_or_protocol_failure",
    });
  });

  it("pins HTTPS to the selected IP while preserving Host, SNI, and TLS hostname validation", async () => {
    const fixture = await startHttpsFixture();
    const observed: {
      lookupCalls: number;
      hostname?: string;
      servername?: string;
      agent?: unknown;
      family?: number;
      autoSelectFamily?: boolean;
      certificateAuthority?: unknown;
      rejectUnauthorized?: unknown;
    } = {
      lookupCalls: 0,
    };
    const httpsFactory = ((options: Parameters<typeof nativeHttpsRequest>[0], callback: Parameters<typeof nativeHttpsRequest>[1]) => {
      observed.hostname = options.hostname;
      observed.servername = options.servername;
      observed.agent = options.agent;
      observed.family = options.family;
      observed.autoSelectFamily = (options as { autoSelectFamily?: boolean }).autoSelectFamily;
      observed.certificateAuthority = (options as { ca?: unknown }).ca;
      observed.rejectUnauthorized = (options as { rejectUnauthorized?: unknown }).rejectUnauthorized;
      const lookup = options.lookup;
      return nativeHttpsRequest({
        ...options,
        lookup(hostname, lookupOptions, done) {
          observed.lookupCalls += 1;
          return lookup?.(hostname, lookupOptions, done);
        },
      }, callback);
    }) as typeof nativeHttpsRequest;
    const transport = createNativeHttpTransportForTest({ httpsRequestFactory: httpsFactory, certificateAuthority });

    await expect(transport.execute(httpsRequest(fixture.port))).resolves.toEqual({ statusCode: 200 });

    expect(observed).toMatchObject({
      lookupCalls: 1,
      hostname: secureMonitoredHost,
      servername: secureMonitoredHost,
      agent: false,
      family: 4,
      autoSelectFamily: false,
      certificateAuthority,
    });
    expect(observed.rejectUnauthorized).toBeUndefined();
    expect(fixture.requests).toEqual([{
      host: `${secureMonitoredHost}:${fixture.port}`,
      url: "/health?private=value",
      servername: secureMonitoredHost,
    }]);
  });

  it("uses normal TLS hostname validation and classifies a certificate mismatch safely", async () => {
    const fixture = await startHttpsFixture();
    const transport = createNativeHttpTransportForTest({ certificateAuthority });

    await expect(transport.execute(httpsRequest(fixture.port, "other.test"))).rejects.toMatchObject({
      outcome: "tls_or_protocol_failure",
    });
    expect(fixture.requests).toHaveLength(0);
  });

  it("uses Node's normal CA store in production", async () => {
    const fixture = await startHttpsFixture();

    await expect(createNativeHttpTransport().execute(httpsRequest(fixture.port))).rejects.toMatchObject({
      outcome: "tls_or_protocol_failure",
    });
  });

  it("rejects an HTTPS peer mismatch after secureConnect without exposing the peer", async () => {
    const socket = Object.assign(new EventEmitter(), { remoteAddress: "127.0.0.2" });
    const clientRequest = Object.assign(new EventEmitter(), {
      socket,
      destroy() {},
      end() {
        queueMicrotask(() => {
          clientRequest.emit("socket", socket);
          socket.emit("secureConnect");
        });
      },
    });
    const httpsFactory = ((_options: unknown, _callback: unknown) => clientRequest) as typeof nativeHttpsRequest;
    const transport = createNativeHttpTransportForTest({ httpsRequestFactory: httpsFactory, certificateAuthority });

    await expect(transport.execute(httpsRequest(8443))).rejects.toMatchObject({
      outcome: "connection_failure",
    });
    expect(clientRequest.listenerCount("error")).toBe(0);
    expect(socket.listenerCount("secureConnect")).toBe(0);
  });

  it("releases the HTTPS connection before resolving a drained response", async () => {
    const fixture = await startHttpsFixture();
    const transport = createNativeHttpTransportForTest({ certificateAuthority });

    await expect(transport.execute(httpsRequest(fixture.port))).resolves.toEqual({ statusCode: 200 });

    const connections = await new Promise<number>((resolve, reject) => {
      httpsServer?.getConnections((error, count) => error ? reject(error) : resolve(count));
    });
    expect(connections).toBe(0);
  });

  it("destroys an in-flight HTTPS request when its shared signal aborts", async () => {
    const fixture = await startPendingHttpsFixture();
    const controller = new AbortController();
    const result = createNativeHttpTransportForTest({ certificateAuthority })
      .execute({ ...httpsRequest(fixture.port), signal: controller.signal });

    await fixture.requestStarted;
    controller.abort();

    await expect(result).rejects.toMatchObject({ outcome: "connection_failure" });
    await fixture.waitForSocketClose();
  });

  it("treats HTTPS redirects as terminal responses", async () => {
    const fixture = await startHttpsFixture(302, "/next");
    const transport = createNativeHttpTransportForTest({ certificateAuthority });

    await expect(transport.execute(httpsRequest(fixture.port))).resolves.toEqual({ statusCode: 302 });
    expect(fixture.requests).toHaveLength(1);
  });
});
