import { beforeEach, describe, expect, it, vi } from "vitest";
import * as app from "../../src/renderer/i18n/app";
import * as graph from "../../src/renderer/i18n/graph";
import * as history from "../../src/renderer/i18n/history";
import * as remote from "../../src/renderer/i18n/remote";
import * as settings from "../../src/renderer/i18n/settings";
import * as workbench from "../../src/renderer/i18n/workbench";
import { acceptDomainUpdate, composeMessages, onDomainChange, setDomains } from "../../src/renderer/i18n/registry";

const domains = { app, graph, workbench, remote, settings, history };
const names = Object.keys(domains) as (keyof typeof domains)[];
const notDomain = { en: { probe: "nope" }, zhCN: { probe: "nope" } };

let applies = 0;

beforeEach(() => {
  setDomains({ app, graph, workbench, remote, settings, history });
  applies = 0;
  onDomainChange(() => { applies += 1; });
});

/** Names of the domains whose messages disappeared from the composed dictionary. */
function vanishedDomains(before: string[]) {
  const after = new Set(Object.keys(composeMessages().en));
  return names.filter((name) => Object.keys(domains[name].en).every((key) => before.includes(key) && !after.has(key)));
}

describe("i18n hot updates", () => {
  it("composes every seeded domain into both locales", () => {
    const messages = composeMessages();
    const composedEn = new Set(Object.keys(messages.en));
    const composedZh = new Set(Object.keys(messages["zh-CN"]));
    for (const name of names) {
      for (const key of Object.keys(domains[name].en)) expect(composedEn.has(key), `${name}.en.${key}`).toBe(true);
      for (const key of Object.keys(domains[name].zhCN)) expect(composedZh.has(key), `${name}.zhCN.${key}`).toBe(true);
    }
    expect(Object.keys(messages.en).sort()).toEqual(names.flatMap((name) => Object.keys(domains[name].en)).sort());
    expect(Object.keys(messages["zh-CN"]).sort()).toEqual(names.flatMap((name) => Object.keys(domains[name].zhCN)).sort());
    expect(messages.en.fileChanges.oldLine).toBe(app.en.fileChanges.oldLine);
  });

  it("routes a domain's own update to its own slot and applies once", () => {
    for (const name of names) {
      const before = Object.keys(composeMessages().en);
      acceptDomainUpdate(domains[name].en)({ en: { probe: name }, zhCN: { probe: name } });
      expect(vanishedDomains(before), name).toEqual([name]);
      expect(composeMessages().en).toHaveProperty("probe", name);
      expect(composeMessages()["zh-CN"]).toHaveProperty("probe", name);
      expect(applies, name).toBe(1);
      setDomains({ app, graph, workbench, remote, settings, history });
      applies = 0;
    }
  });

  it("identifies a module by either locale object", () => {
    for (const name of names) {
      const before = Object.keys(composeMessages().en);
      acceptDomainUpdate(domains[name].zhCN)({ en: { probe: name }, zhCN: { probe: name } });
      expect(vanishedDomains(before), name).toEqual([name]);
      setDomains({ app, graph, workbench, remote, settings, history });
      applies = 0;
    }
  });

  it("keeps a replaced module's callback quiet", () => {
    const update = acceptDomainUpdate(app.en);
    update({ en: { stale: 1 }, zhCN: { stale: 1 } });
    expect(applies).toBe(1);
    update({ en: { stale: 2 }, zhCN: { stale: 2 } });
    expect(applies).toBe(1);
    expect(composeMessages().en).toHaveProperty("stale", 1);
  });

  it("ignores an unknown identity instead of overwriting a slot", () => {
    const before = composeMessages();
    acceptDomainUpdate({})(notDomain);
    expect(applies).toBe(0);
    expect(composeMessages()).toStrictEqual(before);
  });

  it("ignores a missing module from a failed update", () => {
    acceptDomainUpdate(app.en)(undefined);
    expect(applies).toBe(0);
  });

  it("refuses to compose before the index seeded it", async () => {
    vi.resetModules();
    const fresh = await import("../../src/renderer/i18n/registry");
    expect(() => fresh.composeMessages()).toThrow(/before the i18n index seeded it/);
  });
});
