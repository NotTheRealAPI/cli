import http from "node:http";
import https from "node:https";
import type { Outcome } from "./protocol.js";

export interface WireResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
export class TransportError extends Error {}

// Native requests do not use proxy environment variables, follow redirects, decompress, or serialize bodies.
export function wireRequest(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer,
  timeoutMs: number,
  limit: number,
  signal: AbortSignal,
): Promise<WireResponse> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).request(url, {
      method,
      headers: { ...headers, "content-length": String(body.length) },
      agent: false,
      signal,
      maxHeaderSize: 16_384,
      rejectUnauthorized: true,
    });
    const timer = setTimeout(
      () => req.destroy(new TransportError("timeout")),
      timeoutMs,
    );
    const done = () => clearTimeout(timer);
    req.on("error", () => {
      done();
      reject(new TransportError("network"));
    });
    req.on("response", (res) => {
      let bytes = 0;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > limit) {
          res.destroy();
          req.destroy();
          done();
          reject(new TransportError("response_limit"));
        } else chunks.push(chunk);
      });
      res.on("error", () => {
        done();
        reject(new TransportError("network"));
      });
      res.on("end", () => {
        done();
        if (!res.complete) reject(new TransportError("network"));
        else
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
      });
    });
    req.end(body);
  });
}

export function forward(
  target: URL,
  payload: { body: Buffer; headers: Record<string, string> },
  timeoutMs: number,
  signal: AbortSignal,
  requestFactory?: typeof http.request,
): Promise<Outcome> {
  return new Promise((resolve) => {
    const started = performance.now();
    let finished = false,
      sent = false,
      connected = false,
      status: number | null = null,
      bytes = 0;
    let reason: Outcome["error"] = "socket";
    const req = (
      requestFactory ?? (target.protocol === "https:" ? https : http).request
    )(target, {
      method: "POST",
      headers: {
        ...payload.headers,
        "content-length": String(payload.body.length),
      },
      signal,
      agent: false,
      maxHeaderSize: 16_384,
      rejectUnauthorized: true,
    });
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (complete: boolean, truncated = false) => {
      if (finished) return;
      sent ||= connected && (req.socket?.bytesWritten ?? 0) > 0;
      finished = true;
      timers.forEach(clearTimeout);
      signal.removeEventListener("abort", onAbort);
      resolve({
        classification: complete
          ? status! >= 200 && status! < 300
            ? "success"
            : "http_error"
          : sent
            ? "uncertain"
            : "connection_error",
        status,
        durationMs: Math.min(120_000, Math.round(performance.now() - started)),
        requestBytes: sent ? payload.body.length : 0,
        responseBytes: Math.min(bytes, 65_536),
        responseComplete: complete,
        truncated,
        error: complete ? "none" : reason,
        responseHeaders: [],
        responseBody: "",
      });
    };
    const expire = () => {
      reason = "timeout";
      req.destroy();
      finish(false);
    };
    const onAbort = () => {
      reason = "aborted";
      req.destroy();
      finish(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timers.push(setTimeout(expire, timeoutMs));
    // Separate connection and response-header deadlines, both under the total deadline.
    const connectTimer = setTimeout(expire, Math.min(2000, timeoutMs));
    timers.push(connectTimer);
    req.on("socket", (socket) => {
      socket.once(
        target.protocol === "https:" ? "secureConnect" : "connect",
        () => {
          connected = true;
          clearTimeout(connectTimer);
        },
      );
    });
    req.on("finish", () => {
      sent = true;
    });
    req.on("error", () => {
      sent ||= connected && (req.socket?.bytesWritten ?? 0) > 0;
      finish(false);
    });
    const headerTimer = setTimeout(expire, Math.min(5000, timeoutMs));
    timers.push(headerTimer);
    req.on("response", (res) => {
      clearTimeout(headerTimer);
      status = res.statusCode!;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 65_536) {
          reason = "response_limit";
          res.destroy();
          req.destroy();
          finish(false, true);
        }
      });
      res.on("error", () => finish(false));
      res.on("end", () => finish(res.complete));
    });
    if (signal.aborted) onAbort();
    else req.end(payload.body);
  });
}
