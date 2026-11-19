import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import type { LookupFunction } from "node:net";
import { CheckTransportError, type ConstrainedTransport, type TransportRequest } from "./types.ts";

type HttpRequestFactory = typeof httpRequest;
type HttpsRequestFactory = typeof httpsRequest;

type NativeTransportTestOptions = Readonly<{
  httpRequestFactory?: HttpRequestFactory;
  httpsRequestFactory?: HttpsRequestFactory;
  /** Test-only CA material. Production always uses Node's normal trust store. */
  certificateAuthority?: string;
}>;

function connectionFailure(error: unknown, protocol: TransportRequest["target"]["protocol"]): CheckTransportError {
  return error instanceof CheckTransportError
    ? error
    : protocol === "https:" && isTlsError(error)
      ? new CheckTransportError("tls_or_protocol_failure")
    : new CheckTransportError("connection_failure");
}

function isTlsError(error: unknown): boolean {
  const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
  return code === "EPROTO"
    || code?.startsWith("ERR_TLS_") === true
    || code?.includes("CERT") === true
    || code?.includes("VERIFY") === true;
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

function createPinnedNativeTransport(
  httpRequestFactory: HttpRequestFactory,
  httpsRequestFactory: HttpsRequestFactory,
  certificateAuthority?: string,
): ConstrainedTransport {
  return Object.freeze({
    execute(request: TransportRequest): Promise<{ statusCode: number }> {
      if (request.target.protocol !== "http:" && request.target.protocol !== "https:") {
        return Promise.reject(new CheckTransportError("tls_or_protocol_failure"));
      }
      if (request.signal.aborted) return Promise.reject(new CheckTransportError("connection_failure"));
      const isHttps = request.target.protocol === "https:";

      return new Promise((resolve, reject) => {
        let clientRequest: ClientRequest | undefined;
        let response: IncomingMessage | undefined;
        let socket: import("node:net").Socket | undefined;
        let settled = false;
        let responseEnded = false;
        let socketClosed = false;
        let receivedBytes = 0;
        let onResponseData: (chunk: Buffer | string) => void;
        const cleanup = () => {
          request.signal.removeEventListener("abort", onAbort);
          clientRequest?.removeListener("error", onRequestError);
          socket?.removeListener(isHttps ? "secureConnect" : "connect", onConnectedPeer);
          socket?.removeListener("close", onSocketClose);
          response?.removeListener("end", onResponseEnd);
          response?.removeListener("close", onResponseClose);
          response?.removeListener("error", onResponseError);
          response?.removeListener("aborted", onResponseAborted);
          response?.removeListener("data", onResponseData);
        };
        const settle = (callback: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          callback();
        };
        const fail = (error: unknown) => settle(() => reject(connectionFailure(error, request.target.protocol)));
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
        onResponseData = (chunk) => {
          const chunkBytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
          if (receivedBytes + chunkBytes <= request.maxResponseBytes) {
            receivedBytes += chunkBytes;
            return;
          }
          fail(new CheckTransportError("response_limit"));
          response?.destroy();
          clientRequest?.destroy();
        };
        const succeedAfterDrain = () => {
          if (responseEnded && socketClosed) {
            settle(() => resolve({ statusCode: response?.statusCode as number }));
          }
        };
        const onResponseEnd = () => {
          responseEnded = true;
          succeedAfterDrain();
        };
        const onResponseClose = () => {
          if (!response?.complete) fail(new CheckTransportError("connection_failure"));
        };
        const onSocketClose = () => {
          socketClosed = true;
          succeedAfterDrain();
        };
        const onConnectedPeer = () => {
          if (socket?.remoteAddress !== request.address.address) {
            const error = new CheckTransportError("connection_failure");
            clientRequest?.destroy();
            fail(error);
          }
        };

        request.signal.addEventListener("abort", onAbort, { once: true });
        try {
          const url = new URL(request.target.normalizedUrl);
          const options: RequestOptions & HttpsRequestOptions & { autoSelectFamily: boolean } = {
            protocol: request.target.protocol,
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
          if (isHttps) {
            options.servername = request.target.originalHostname;
            if (certificateAuthority) options.ca = certificateAuthority;
          }
          const onResponse = (incomingResponse: IncomingMessage) => {
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
            response.on("data", onResponseData);
            response.resume();
          };
          clientRequest = isHttps
            ? httpsRequestFactory(options as HttpsRequestOptions, onResponse)
            : httpRequestFactory(options as RequestOptions, onResponse);
          clientRequest.once("error", onRequestError);
          clientRequest.once("socket", (nextSocket) => {
            socket = nextSocket;
            socket.once(isHttps ? "secureConnect" : "connect", onConnectedPeer);
            socket.once("close", onSocketClose);
          });
          clientRequest.end();
        } catch (error) {
          fail(error);
        }
      });
    },
  });
}

/** Creates the production HTTP(S) pinned transport. */
export function createNativeHttpTransport(): ConstrainedTransport {
  return createPinnedNativeTransport(httpRequest, httpsRequest);
}

/** Test-only seam for peer checks and an ephemeral fixture CA. */
export function createNativeHttpTransportForTest(
  requestFactoryOrOptions: HttpRequestFactory | NativeTransportTestOptions,
): ConstrainedTransport {
  const options = typeof requestFactoryOrOptions === "function"
    ? { httpRequestFactory: requestFactoryOrOptions }
    : requestFactoryOrOptions;
  return createPinnedNativeTransport(
    options.httpRequestFactory ?? httpRequest,
    options.httpsRequestFactory ?? httpsRequest,
    options.certificateAuthority,
  );
}
