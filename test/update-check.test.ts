import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchLatestRelease,
  isNewerVersion,
  normalizeVersion,
  shouldNotify,
  UpdateChecker,
  RELEASES_API_URL,
} from "../src/main/update-check.js";
import type { DesktopEvent } from "../src/shared/types.js";

test("normalizeVersion accepts v-prefixed triples and rejects the rest", () => {
  assert.equal(normalizeVersion("v0.0.14"), "0.0.14");
  assert.equal(normalizeVersion("0.1.0"), "0.1.0");
  assert.equal(normalizeVersion("0.0.14-beta"), null);
  assert.equal(normalizeVersion("v1.2"), null);
  assert.equal(normalizeVersion(""), null);
  assert.equal(normalizeVersion(undefined), null);
});

test("isNewerVersion compares part-wise", () => {
  assert.equal(isNewerVersion("v0.0.14", "0.0.13"), true);
  assert.equal(isNewerVersion("0.1.0", "v0.0.99"), true);
  assert.equal(isNewerVersion("1.0.0", "0.99.99"), true);
  assert.equal(isNewerVersion("0.0.14", "0.0.14"), false);
  assert.equal(isNewerVersion("0.0.13", "0.0.14"), false);
  assert.equal(isNewerVersion("not-a-version", "0.0.13"), false);
  assert.equal(isNewerVersion("0.0.14", "broken"), false);
});

test("shouldNotify ignores the skipped release but not newer ones", () => {
  assert.equal(shouldNotify("0.0.14", "0.0.13", undefined), true);
  assert.equal(shouldNotify("0.0.14", "0.0.13", "v0.0.14"), false);
  assert.equal(shouldNotify("0.0.15", "0.0.13", "v0.0.14"), true);
  assert.equal(shouldNotify("0.0.13", "0.0.13", undefined), false);
});

function releaseResponse(tag: string, url = "https://github.com/huang-sh/PiX/releases/tag/v0.0.15") {
  return {
    ok: true,
    json: async () => ({ tag_name: tag, html_url: url }),
  } as unknown as Response;
}

test("fetchLatestRelease reads tag and release URL", async () => {
  const calls: RequestInfo[] = [];
  const release = await fetchLatestRelease((async (input: RequestInfo) => {
    calls.push(input);
    return releaseResponse("v0.0.15");
  }) as unknown as typeof fetch);
  assert.deepEqual(release, {
    version: "0.0.15",
    url: "https://github.com/huang-sh/PiX/releases/tag/v0.0.15",
  });
  assert.equal(calls[0], RELEASES_API_URL);
});

test("fetchLatestRelease fails soft", async () => {
  assert.equal(await fetchLatestRelease((async () => { throw new Error("offline"); }) as unknown as typeof fetch), null);
  assert.equal(
    await fetchLatestRelease((async () => ({ ok: false })) as unknown as typeof fetch),
    null,
  );
  assert.equal(
    await fetchLatestRelease((async () => releaseResponse("v0.0.15-rc1")) as unknown as typeof fetch),
    null,
  );
});

test("UpdateChecker announces a newer release and honors the skip", async () => {
  const events: DesktopEvent[] = [];
  const checker = new UpdateChecker({
    version: () => "0.0.13",
    skipped: () => undefined,
    emit: (event) => events.push(event),
    fetchImpl: (async () => releaseResponse("v0.0.14")) as unknown as typeof fetch,
  });
  assert.equal(await checker.check(), true);
  assert.deepEqual(events, [{
    type: "update.available",
    payload: { version: "0.0.14", url: "https://github.com/huang-sh/PiX/releases/tag/v0.0.15" },
  }]);

  const skipping = new UpdateChecker({
    version: () => "0.0.13",
    skipped: () => "v0.0.14",
    emit: (event) => events.push(event),
    fetchImpl: (async () => releaseResponse("v0.0.14")) as unknown as typeof fetch,
  });
  assert.equal(await skipping.check(), false);
  assert.equal(events.length, 1);
});

test("UpdateChecker stays silent when the check fails", async () => {
  const events: DesktopEvent[] = [];
  const checker = new UpdateChecker({
    version: () => "0.0.13",
    skipped: () => undefined,
    emit: (event) => events.push(event),
    fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch,
  });
  assert.equal(await checker.check(), false);
  assert.deepEqual(events, []);
});
