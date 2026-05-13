// Adapters that let the same handler code run under both production Vercel
// Edge (Web Request / Web Response) and `vercel dev` (Node IncomingMessage /
// http.ServerResponse). Shared by every handler under api/.

export type CompatRequest =
  | Request
  | {
      method?: string;
      headers: unknown;
      on?: unknown;
      setEncoding?: unknown;
    };

export type CompatNodeRes = {
  setHeader: (k: string, v: string) => void;
  write: (chunk: string | Uint8Array) => void;
  end: () => void;
  statusCode: number;
  flushHeaders?: () => void;
};

// Web `Request.headers` has `.get(name)`; Node IncomingMessage exposes
// `.headers` as a plain object with lowercase keys. Handles both.
export function getHeader(req: unknown, name: string): string | undefined {
  const headers = (req as { headers?: unknown }).headers;
  if (headers && typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined;
  }
  const nodeHeaders = headers as
    | Record<string, string | string[] | undefined>
    | undefined;
  const value = nodeHeaders?.[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

export async function parseBody(req: CompatRequest): Promise<unknown> {
  // Path 1: Web Request (prod Edge runtime).
  if (typeof (req as Request).json === 'function') {
    return (req as Request).json().catch(() => null);
  }

  const nodeReq = req as {
    body?: unknown;
    setEncoding?: (e: string) => void;
    on: (
      ev: 'data' | 'end' | 'error',
      cb: (chunk?: string) => void,
    ) => void;
  };

  // Path 2: vercel dev's @vercel/node wrapper pre-buffers the body onto
  // `req.body` before invoking the handler. Attaching 'data'/'end' listeners
  // after the stream has already ended would wait forever.
  if (nodeReq.body !== undefined && nodeReq.body !== null) {
    if (typeof nodeReq.body === 'string') {
      try {
        return JSON.parse(nodeReq.body);
      } catch {
        return null;
      }
    }
    return nodeReq.body;
  }

  // Path 3: true Node IncomingMessage stream — rare fallback.
  return new Promise((resolve) => {
    let body = '';
    nodeReq.setEncoding?.('utf-8');
    nodeReq.on('data', (chunk) => {
      body += chunk;
    });
    nodeReq.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(null);
      }
    });
    nodeReq.on('error', () => resolve(null));
  });
}

// `vercel dev` invokes handlers with a Node http.ServerResponse as the second
// arg and expects bytes written to it; production Edge passes a context with
// `waitUntil` and consumes the returned `Response`. writeResponse picks the
// right path per environment.
export async function writeResponse(
  resOrCtx: unknown,
  response: Response,
): Promise<Response | void> {
  const maybe = resOrCtx as Partial<CompatNodeRes> | undefined;
  const isNodeRes =
    typeof maybe?.setHeader === 'function' &&
    typeof maybe?.end === 'function';

  if (!isNodeRes) {
    // Production Edge runtime — return the Response unchanged.
    return response;
  }

  const nodeRes = maybe as CompatNodeRes;
  nodeRes.statusCode = response.status;
  response.headers.forEach((value, key) => {
    nodeRes.setHeader(key, value);
  });
  nodeRes.flushHeaders?.();

  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) nodeRes.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  nodeRes.end();
  // void — bytes already written to the Node response
}
