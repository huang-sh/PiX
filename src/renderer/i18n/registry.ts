// Type-only: the domain modules import this registry for their hot accept, so a
// runtime import back into them would be a cycle.
import type * as app from "./app";
import type * as graph from "./graph";
import type * as history from "./history";
import type * as remote from "./remote";
import type * as settings from "./settings";
import type * as workbench from "./workbench";

type DomainModules = {
  app: typeof app;
  graph: typeof graph;
  workbench: typeof workbench;
  remote: typeof remote;
  settings: typeof settings;
  history: typeof history;
};
type DomainName = keyof DomainModules;
type DomainModule = DomainModules[DomainName];

type UnionToIntersection<U> = (U extends unknown ? (arg: U) => void : never) extends (arg: infer I) => void ? I : never;
// Flattening keeps the composed dictionaries plain object types; passing an
// intersection straight into vue-i18n blows up its schema inference.
type Flatten<T> = { [K in keyof T]: T[K] };
type Composed<T extends "en" | "zhCN"> = Flatten<UnionToIntersection<DomainModule[T]>>;

// Seeded by the i18n index before any hot update can run.
let domains: DomainModules | undefined;
let onChange: (() => void) | undefined;

export function setDomains(next: DomainModules) {
  domains = next;
}

export function onDomainChange(fn: () => void) {
  onChange = fn;
}

function seededModules(): [DomainName, DomainModule][] {
  if (!domains) throw new Error("i18n domain registry used before the i18n index seeded it");
  return Object.entries(domains) as [DomainName, DomainModule][];
}

// Every seeded domain contributes to the dictionary, so adding one never means
// editing a second list here.
const mergeLocale = <T extends "en" | "zhCN">(locale: T) =>
  Object.assign({}, ...seededModules().map(([, module]) => module[locale])) as Composed<T>;

export const composeMessages = () => ({ en: mergeLocale("en"), "zh-CN": mergeLocale("zhCN") });

// Builds the hot-accept callback for one domain module. The slot is found by the
// module's own locale objects, which the registry already holds, so a domain never
// repeats its name and cannot be wired to the wrong slot.
export function acceptDomainUpdate(identity: object) {
  return (mod: unknown) => {
    if (!mod) return;
    const held = seededModules();
    const entry = held.find(([, module]) => module.en === identity || module.zhCN === identity);
    if (!entry) return;
    (domains as Record<DomainName, DomainModule>)[entry[0]] = mod as DomainModule;
    onChange?.();
  };
}
