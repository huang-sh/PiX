import { EnvHttpProxyAgent, ProxyAgent, Socks5ProxyAgent, install, type Dispatcher } from "undici";

/** Install once per host, before loading providers that use global fetch. */
export function installHttpProxy(
  readProxy: () => string | undefined,
  systemFetch?: typeof fetch,
  env: NodeJS.ProcessEnv = process.env,
  resolveProxy?: (url: string) => Promise<string>,
) {
  // Keep fetch, Request and FormData on the same implementation, including
  // Electron releases whose bundled Node fetch differs from npm undici.
  install();
  const nodeFetch = globalThis.fetch;
  let dispatcher: EnvHttpProxyAgent | undefined;
  let previousConfig: string | undefined;
  let systemDispatcher: Dispatcher | undefined;
  let previousRoute: string | undefined;

  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return nodeFetch(input, init);

    const configured = readProxy()?.trim();
    const allProxy = env.all_proxy || env.ALL_PROXY || "";
    const httpProxy = configured || env.http_proxy || env.HTTP_PROXY || allProxy;
    const httpsProxy = configured || env.https_proxy || env.HTTPS_PROXY || httpProxy;
    const noProxy = env.no_proxy ?? env.NO_PROXY ?? "localhost,127.0.0.1,[::1]";
    const config = JSON.stringify([httpProxy, httpsProxy, noProxy]);
    if (config !== previousConfig) {
      for (const proxy of [httpProxy, httpsProxy]) {
        if (proxy && !["http:", "https:"].includes(new URL(proxy).protocol))
          throw new Error("HTTP proxy must use an http:// or https:// URL.");
      }
      const next = httpProxy || httpsProxy
        ? new EnvHttpProxyAgent({
            httpProxy, httpsProxy, noProxy,
            allowH2: false,
            proxyTunnel: true,
            bodyTimeout: 300_000,
            headersTimeout: 300_000,
            connect: { autoSelectFamilyAttemptTimeout: 2_000 },
          })
        : undefined;
      // Gracefully drain in-flight requests when the user changes settings.
      void dispatcher?.close().catch(() => {});
      dispatcher = next;
      previousConfig = config;
    }
    let selected: Dispatcher | undefined = dispatcher;
    if (!selected) {
      if (systemFetch) return systemFetch(input, init);
      if (resolveProxy) {
        // Chromium evaluates system bypass rules and PAC per URL. The host
        // keeps the response stream and cancellation on its own transport.
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        signal?.throwIfAborted();
        const decision = resolveProxy(url.href);
        let abort: (() => void) | undefined;
        const resolved = await (signal ? Promise.race([decision, new Promise<never>((_resolve, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        })]) : decision).finally(() => { if (abort) signal!.removeEventListener("abort", abort); });
        const route = resolved.split(";")[0]!.trim();
        if (route !== previousRoute) {
          let next: Dispatcher | undefined;
          if (route !== "DIRECT") {
            const match = /^(PROXY|HTTPS|SOCKS5|SOCKS)\s+(.+)$/i.exec(route);
            if (!match) throw new Error(`Unsupported system proxy: ${route}`);
            const protocol = match[1]!.toUpperCase();
            next = protocol.startsWith("SOCKS")
              ? new Socks5ProxyAgent(`socks5://${match[2]}`, { allowH2: false, bodyTimeout: 300_000, headersTimeout: 300_000 })
              : new ProxyAgent({ uri: `${protocol === "HTTPS" ? "https" : "http"}://${match[2]}`, allowH2: false,
                  proxyTunnel: true, bodyTimeout: 300_000, headersTimeout: 300_000,
                  connect: { autoSelectFamilyAttemptTimeout: 2_000 } });
          }
          void systemDispatcher?.close().catch(() => {});
          systemDispatcher = next;
          previousRoute = route;
        }
        selected = systemDispatcher;
      }
    }
    if (!selected) return nodeFetch(input, init);
    const options: RequestInit & { dispatcher: Dispatcher } = { ...init, dispatcher: selected };
    return nodeFetch(input, options);
  };

  return async () => { await Promise.all([dispatcher?.destroy(), systemDispatcher?.destroy()]); };
}
