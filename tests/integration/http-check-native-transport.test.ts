import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { EventEmitter, once } from "node:events";
import { createNativeHttpTransport, createNativeHttpTransportForTest } from "../../packages/check-engine/src/native-transport.ts";
import type { TransportRequest } from "../../packages/check-engine/src/types.ts";

const monitoredHost = "pinned-target.invalid";
const selectedAddress = { address: "127.0.0.1", family: 4 as const };
let server: Server | undefined;

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

afterEach(async () => {
  if (server) {
    server.close();
    await once(server, "close");
    server = undefined;
  }
});

describe("native pinned HTTP transport", () => {
  it("connects only through the selected address and preserves the original Host", async () => {
    const fixture = await startFixture();
    const transport = createNativeHttpTransport();

    await expect(transport.execute(request(fixture.port))).resolves.toEqual({ statusCode: 200 });

    expect(fixture.requests).toEqual([{ host: `${monitoredHost}:${fixture.port}`, url: "/health?private=value" }]);
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
      destroy(error?: Error) { queueMicrotask(() => fakeRequest.emit("error", error)); },
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
});
