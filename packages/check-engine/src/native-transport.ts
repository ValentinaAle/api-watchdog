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
        let response: import("node:http").IncomingMessage | undefined;
        let socket: import("node:net").Socket | undefined;
        let settled = false;
        const cleanup = () => {
          request.signal.removeEventListener("abort", onAbort);
          clientRequest?.removeListener("error", onRequestError);
          socket?.removeListener("connect", onConnect);
          response?.removeListener("end", onResponseEnd);
          response?.removeListener("close", onResponseClose);
          response?.removeListener("error", onResponseError);
          response?.removeListener("aborted", onResponseAborted);
        };
        const settle = (callback: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          callback();
        };
        const fail = (error: unknown) => settle(() => reject(connectionFailure(error)));
        const onRequestError = (error: Error) => {
          fail(error);
          clientRequest?.destroy();
        };
        const onAbort = () => {
          response?.destroy();
          clientRequest?.destroy();
          fail(new CheckTransportError("connection_failure"));
        };
        const onResponseError = (error: Error) => {
          fail(error);
          response?.destroy();
          clientRequest?.destroy();
        };
        const onResponseAborted = () => {
          fail(new CheckTransportError("connection_failure"));
          clientRequest?.destroy();
        };
        const onResponseEnd = () => settle(() => resolve({ statusCode: response?.statusCode as number }));
        const onResponseClose = () => {
          if (!response?.complete) fail(new CheckTransportError("connection_failure"));
        };
        const onConnect = () => {
          if (socket?.remoteAddress !== request.address.address) {
            const error = new CheckTransportError("connection_failure");
            clientRequest?.destroy();
            fail(error);
          }
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
          clientRequest = requestFactory(options as RequestOptions, (incomingResponse) => {
            response = incomingResponse;
            const peerAddress = clientRequest?.socket?.remoteAddress;
            if (peerAddress !== request.address.address) {
              response.resume();
              clientRequest?.destroy();
              fail(new CheckTransportError("connection_failure"));
              return;
            }
            const statusCode = response.statusCode;
            if (!Number.isInteger(statusCode)) {
              response.resume();
              fail(new CheckTransportError("tls_or_protocol_failure"));
              return;
            }
            response.once("error", onResponseError);
            response.once("aborted", onResponseAborted);
            response.once("end", onResponseEnd);
            response.once("close", onResponseClose);
            response.resume();
          });
          clientRequest.once("error", onRequestError);
          clientRequest.once("socket", (nextSocket) => {
            socket = nextSocket;
            socket.once("connect", onConnect);
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
