import { request as httpRequest, type ClientRequest, type RequestOptions } from "node:http";
import type { LookupFunction } from "node:net";
import { CheckTransportError, type ConstrainedTransport, type TransportRequest } from "./types.ts";

function connectionFailure(error: unknown): CheckTransportError {
  return error instanceof CheckTransportError
    ? error
    : new CheckTransportError("connection_failure");
}

function pinnedLookup(address: TransportRequest["address"]): LookupFunction {
  return (_hostname, options, callback) => {
    const family = typeof options === "number" ? options : options.family;
    if (family !== 0 && family !== address.family) {
      callback(new Error("address family mismatch"), "", 0);
      return;
    }
    callback(null, address.address, address.family);
  };
}

/** Creates an HTTP-only transport that can connect only through a pre-validated address. */
type HttpRequestFactory = typeof httpRequest;

function createPinnedHttpTransport(requestFactory: HttpRequestFactory): ConstrainedTransport {
  return Object.freeze({
    execute(request: TransportRequest): Promise<{ statusCode: number }> {
      if (request.target.protocol !== "http:") {
        return Promise.reject(new CheckTransportError("tls_or_protocol_failure"));
      }
      if (request.signal.aborted) return Promise.reject(new CheckTransportError("connection_failure"));

      return new Promise((resolve, reject) => {
        let clientRequest: ClientRequest | undefined;
        let settled = false;
        const settle = (callback: () => void) => {
          if (settled) return;
          settled = true;
          request.signal.removeEventListener("abort", onAbort);
          callback();
        };
        const fail = (error: unknown) => settle(() => reject(connectionFailure(error)));
        const onAbort = () => {
          clientRequest?.destroy(new CheckTransportError("connection_failure"));
          fail(new CheckTransportError("connection_failure"));
        };

        request.signal.addEventListener("abort", onAbort, { once: true });
        try {
          const url = new URL(request.target.normalizedUrl);
          const options: RequestOptions & { autoSelectFamily: boolean } = {
            protocol: "http:",
            hostname: request.target.originalHostname,
            port: request.target.port,
            path: `${url.pathname}${url.search}`,
            method: request.method,
            agent: false,
            family: request.address.family,
            autoSelectFamily: false,
            lookup: pinnedLookup(request.address),
            signal: request.signal,
          };
          clientRequest = requestFactory(options as RequestOptions, (response) => {
            const peerAddress = clientRequest?.socket?.remoteAddress;
            if (peerAddress !== request.address.address) {
              response.resume();
              clientRequest?.destroy(new CheckTransportError("connection_failure"));
              fail(new CheckTransportError("connection_failure"));
              return;
            }
            const statusCode = response.statusCode;
            if (!Number.isInteger(statusCode)) {
              response.resume();
              fail(new CheckTransportError("tls_or_protocol_failure"));
              return;
            }
            response.resume();
            settle(() => resolve({ statusCode: statusCode as number }));
          });
          clientRequest.once("error", fail);
          clientRequest.once("socket", (socket) => {
            socket.once("connect", () => {
              if (socket.remoteAddress !== request.address.address) {
                const error = new CheckTransportError("connection_failure");
                clientRequest?.destroy(error);
                fail(error);
              }
            });
          });
          clientRequest.end();
        } catch (error) {
          fail(error);
        }
      });
    },
  });
}

/** Creates the production HTTP-only pinned transport. */
export function createNativeHttpTransport(): ConstrainedTransport {
  return createPinnedHttpTransport(httpRequest);
}

/** Test-only seam for deterministic peer-address mismatch verification. */
export function createNativeHttpTransportForTest(requestFactory: HttpRequestFactory): ConstrainedTransport {
  return createPinnedHttpTransport(requestFactory);
}
