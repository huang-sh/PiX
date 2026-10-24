import { EnvHttpProxyAgent, install } from "undici";

/** Install once per host, before loading providers that use global fetch. */
export function installHttpProxy(
  readProxy: () => string | undefined,
  systemFetch?: typeof fetch,
  env: NodeJS.ProcessEnv = process.env,
) {
  // Keep fetch, Request and FormData on the same implementation, including
  // Electron releases whose bundled Node fetch differs from npm undici.
  install();
  const nodeFetch = globalThis.fetch;
  let dispatcher: EnvHttpProxyAgent | undefined;
  let previousConfig: string | undefined;

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
    // Chromium follows system proxy/PAC changes. Explicit settings and
    // environment proxies use undici so NO_PROXY remains effective.
    if (!dispatcher) return (systemFetch ?? nodeFetch)(input, init);
    const options: RequestInit & { dispatcher: EnvHttpProxyAgent } = { ...init, dispatcher };
    return nodeFetch(input, options);
  };

  return async () => { await dispatcher?.destroy(); };
}
