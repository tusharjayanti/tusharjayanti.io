// OpenTelemetry bootstrap for Langfuse tracing (SDK v5).
//
// The v4+ Langfuse JS SDK is OpenTelemetry-based: observations are OTel
// spans, and a `LangfuseSpanProcessor` exports them to
// POST /api/public/otel/v1/traces. The docs reach for `NodeSDK` from
// `@opentelemetry/sdk-node`, but that pulls in Node-only auto-
// instrumentation and does NOT run on Vercel Edge (which is where
// api/chat.ts lives). We wire the two pieces we actually need by hand
// instead:
//
//   BasicTracerProvider (@opentelemetry/sdk-trace-base) — pure JS
//   LangfuseSpanProcessor (@langfuse/otel) — resolves to the OTLP
//     fetch transport under Edge bundling conditions (no node:http,
//     no XMLHttpRequest, no sendBeacon)
//
// Verified by bundling this dependency graph with esbuild under Vercel's
// Edge resolution conditions (edge-light,browser,module,import): no Node
// built-ins survive and the exporter lands on FetchTransport.
//
// Deliberately NOT registered as the OTel *global* tracer provider — only
// Langfuse's own tracer is pointed at it via setLangfuseTracerProvider, so
// this cannot capture or interfere with unrelated instrumentation.

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  context as otelContext,
  type Context,
  type ContextManager,
} from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { setLangfuseTracerProvider } from '@langfuse/tracing';

// Minimal AsyncLocalStorage-backed context manager.
//
// `@opentelemetry/context-async-hooks` is the stock implementation, but it
// imports the bare specifier `async_hooks`, which does not resolve under
// Edge bundling — Vercel exposes AsyncLocalStorage only via the prefixed
// `node:async_hooks`. Without SOME context manager the OTel context API
// degrades to a no-op, which would silently break `propagateAttributes()`
// (the v5 mechanism that puts userId / traceName on every child
// observation). Parent-child linking itself does not depend on this: every
// observation here is created from an explicit parent handle.
class EdgeContextManager implements ContextManager {
  private readonly _als = new AsyncLocalStorage<Context>();
  private _root: Context | undefined;

  active(): Context {
    return this._als.getStore() ?? this._root!;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    context: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const bound = (() =>
      fn.apply(thisArg as ThisParameterType<F>, args)) as () => ReturnType<F>;
    return this._als.run(context, bound);
  }

  bind<T>(context: Context, target: T): T {
    if (typeof target !== 'function') return target;
    const self = this;
    return function (this: unknown, ...args: unknown[]) {
      return self.with(context, () =>
        (target as (...a: unknown[]) => unknown).apply(this, args),
      );
    } as unknown as T;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this._als.disable();
    return this;
  }

  setRoot(root: Context): void {
    this._root = root;
  }
}

let _processor: LangfuseSpanProcessor | null = null;
let _initialized = false;

// Idempotent. Returns false when LANGFUSE_* env vars are missing, in which
// case no tracer provider is installed and every startObservation() call
// becomes a non-recording no-op.
export function initTracing(): boolean {
  if (_initialized) return _processor !== null;
  _initialized = true;

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL;

  if (!publicKey || !secretKey || !baseUrl) {
    console.warn('[langfuse] env vars missing; tracing disabled');
    return false;
  }

  try {
    const contextManager = new EdgeContextManager();
    // ROOT_CONTEXT is not exported as a value we can construct, so seed the
    // manager's root from whatever the API currently considers active.
    contextManager.setRoot(otelContext.active());
    // Returns false if another manager is already registered (warm reuse of
    // the same isolate) — harmless either way.
    otelContext.setGlobalContextManager(contextManager);

    // exportMode 'immediate' is the v5 equivalent of v3's `flushAt: 1`:
    // Vercel has no persistent process to batch for, so every ended span
    // is handed to the exporter right away. finalizeTrace() still calls
    // flushTracing() to await the in-flight HTTP round-trips.
    _processor = new LangfuseSpanProcessor({
      publicKey,
      secretKey,
      baseUrl,
      exportMode: 'immediate',
    });

    setLangfuseTracerProvider(
      new BasicTracerProvider({ spanProcessors: [_processor] }),
    );
    return true;
  } catch (err) {
    console.error('[langfuse] tracing init failed:', err);
    _processor = null;
    return false;
  }
}

// Await the exporter's in-flight requests. The v3 code called
// `shutdownAsync()` here; on v5 `shutdown()` would tear the processor down
// for the whole isolate, and Vercel reuses warm instances across requests —
// so forceFlush() is the correct per-request drain.
export async function flushTracing(): Promise<void> {
  if (!_processor) return;
  try {
    await _processor.forceFlush();
  } catch (err) {
    console.error('[langfuse] flush failed:', err);
  }
}

// Test-only: drop the cached singleton so the next initTracing() call
// re-runs the env-var check and constructor. Not used in production.
export function __resetTracingForTests(): void {
  _processor = null;
  _initialized = false;
}
