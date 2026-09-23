import type { DesktopEvent } from "../shared/types.js";

/**
 * "Check for a newer PiX release" lives in the main process: the renderer
 * never sees the GitHub API nor builds release URLs. Every entry point fails
 * soft — a network hiccup or a rate limit surfaces as "no update", never as
 * a thrown rejection or a broken banner.
 */

export const RELEASES_API_URL = "https://api.github.com/repos/huang-sh/PiX/releases/latest";

/** `v0.0.14` -> `0.0.14`; anything shorter, longer or non-numeric -> null. */
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function normalizeVersion(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const match = VERSION_PATTERN.exec(raw);
  if (!match) return null;
  return `${match[1]}.${match[2]}.${match[3]}`;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const a = normalizeVersion(candidate),
    b = normalizeVersion(current);
  if (!a || !b) return false;
  const parts = (version: string) => version.split(".").map(Number) as [number, number, number];
  const [[am, ai, ap], [bm, bi, bp]] = [parts(a), parts(b)];
  return am > bm || (am === bm && (ai > bi || (ai === bi && ap > bp)));
}

export function shouldNotify(latest: string, current: string, skipped: string | undefined) {
  return isNewerVersion(latest, current) && normalizeVersion(latest) !== normalizeVersion(skipped);
}

export interface LatestRelease {
  version: string;
  url: string;
}

/** Best-effort latest release fetch; every failure path returns null. */
export async function fetchLatestRelease(
  fetchImpl: typeof fetch = fetch,
): Promise<LatestRelease | null> {
  let response: Response;
  try {
    response = await fetchImpl(RELEASES_API_URL, {
      headers: { "User-Agent": "PiX" },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    const release = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
    const version = normalizeVersion(
      typeof release.tag_name === "string" ? release.tag_name : null,
    );
    if (!version) return null;
    const url = typeof release.html_url === "string" && release.html_url.startsWith("https://")
      ? release.html_url
      : "https://github.com/huang-sh/PiX/releases";
    return { version, url };
  } catch {
    return null;
  }
}

export interface UpdateCheckerDeps {
  version(): string;
  skipped(): string | undefined;
  emit(event: DesktopEvent): void;
  fetchImpl?: typeof fetch;
  /** ms before the boot check fires; tests pass 0. */
  delayMs?: number;
}

export class UpdateChecker {
  constructor(private readonly deps: UpdateCheckerDeps) {}
  start() {
    setTimeout(() => { void this.check(); }, this.deps.delayMs ?? 3000).unref?.();
  }
  /** True when a newer release was announced to the renderer. */
  async check(): Promise<boolean> {
    const release = await fetchLatestRelease(this.deps.fetchImpl);
    if (!release || !shouldNotify(release.version, this.deps.version(), this.deps.skipped()))
      return false;
    this.deps.emit({
      type: "update.available",
      payload: { version: release.version, url: release.url },
    });
    return true;
  }
}
