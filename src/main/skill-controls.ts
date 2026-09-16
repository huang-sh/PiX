import { basename, dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  SKILL_BODY_MESSAGES,
  SKILL_DESCRIPTION_MESSAGES,
  SKILL_NAME_MESSAGES,
  assertEditableSkillPath,
  isEditableSkillPath,
  isPathInside,
  parseSkillDocument,
  serializeSkillDocument,
  skillRoots,
} from "./skill-files.js";
import { skillBodyError, skillDescriptionError, skillNameError, slugifySkillName } from "../shared/skills.js";
import { isBundledSkillPath, setBuiltinSkillManualOnly } from "./builtin-skills.js";
import { isOutputStyleFile } from "./output-style.js";
import type { AgentControl, RuntimeSkill, RuntimeSkillDocument } from "../shared/types.js";

/**
 * The loader surface the skill list reads. The SDK type itself stays behind
 * pi-runtime (the architecture test pins its import there), so this mirrors
 * only the fields the controls actually use.
 */
interface SkillsLoader {
  reload(): Promise<unknown>;
  getSkills(): {
    skills: Array<{
      name: string;
      description: string;
      filePath: string;
      disableModelInvocation: boolean;
      sourceInfo: { source: string; scope: RuntimeSkill["scope"] };
    }>;
    diagnostics: Array<{
      collision?: { resourceType: string; winnerPath: string; loserPath: string };
    }>;
  };
}

/**
 * The PiRuntime surface the skill controls run against. Every member is a
 * live accessor: the cwd, the session, and the session-less services all
 * change over the runtime's lifetime, so values captured at construction
 * would go stale. The SDK module stays behind pi-runtime (the architecture
 * test pins its import there), reached through the any-typed pi().
 */
export interface SkillControlsHost {
  pi(): Promise<any>;
  /** PiX's agent directory the skill roots hang off. */
  agentDir(): string;
  /** The project in view; null keeps only user-scope skills writable. */
  cwd(): string | null;
  /** The live session, when one is open; its loader backs the skill lists. */
  session(): any | undefined;
  /** The session-less services' current value, if they were ever built. */
  modelServices(): any | undefined;
  /** Builds the session-less services when absent; their loader backs the lists before any session opens. */
  ensureModelServices(): Promise<void>;
}

/** The settings page's skill management: list, read, create, import, update, delete, and toggle. */
export class SkillControls {
  constructor(private readonly host: SkillControlsHost) {}

  async run(input: AgentControl): Promise<unknown> {
    switch (input.action) {
      case "getSkills":
        return this.getSkills(input.reload);
      case "getSkill":
        return this.getSkill(input.path);
      case "createSkill":
        return this.createSkill(input.scope, input.name, input.description, input.body, input.disableModelInvocation);
      case "importSkill":
        return this.importSkill(input.scope, input.name, input.content);
      case "updateSkill":
        return this.updateSkill(input.path, input.name, input.description, input.body, input.disableModelInvocation);
      case "deleteSkill":
        return this.deleteSkill(input.path);
      case "setSkillManualOnly":
        return this.setSkillManualOnly(input.path, input.manualOnly);
    }
    throw new Error(`Unknown skill action: ${String(input.action)}`);
  }

  private async getSkills(reload?: boolean): Promise<RuntimeSkill[]> {
    const s = this.host.session();
    if (!s) await this.host.ensureModelServices();
    const loader = (s?.resourceLoader ?? this.host.modelServices()?.resourceLoader) as SkillsLoader;
    if (reload) await loader.reload();
    const { editable } = await this.skillFileRoots();
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const { skills: loaded, diagnostics } = loader.getSkills();
    // A user copy hiding a bundled skill of the same name leaves the
    // bundled row simply absent; badge the winner so the list explains
    // itself. Pi reports these as collision diagnostics.
    const shadowsBuiltin = new Map<string, string>();
    for (const diagnostic of diagnostics) {
      const collision = diagnostic.collision;
      if (collision?.resourceType !== "skill") continue;
      if (isBundledSkillPath(moduleDir, collision.loserPath))
        shadowsBuiltin.set(collision.winnerPath, collision.loserPath);
    }
    return loaded.map(
      (skill): RuntimeSkill => ({
        name: skill.name,
        description: skill.description,
        path: skill.filePath,
        source: skill.sourceInfo.source,
        // Bundled skills carry no pi scope of their own; show them as a
        // read-only category instead of a misleading "project" badge.
        scope: isBundledSkillPath(moduleDir, skill.filePath)
          ? "builtin"
          : skill.sourceInfo.scope,
        disableModelInvocation: skill.disableModelInvocation,
        outputStyle: isOutputStyleFile(skill.filePath),
        editable: isEditableSkillPath(skill.filePath, editable),
        ...(shadowsBuiltin.has(skill.filePath)
          ? { shadowsBuiltin: shadowsBuiltin.get(skill.filePath) }
          : {}),
      }),
    );
  }

  private async getSkill(path: string): Promise<RuntimeSkillDocument> {
    // Reading follows the loaded list: anything the settings page shows
    // can be opened in the read-only viewer, packaged skills included.
    // Writes (and paths the loader never listed) stay behind the
    // editable-roots assertion in skillTarget. The listed entry also
    // supplies the effective invocation flag, which for a bundled skill
    // is the override table's value rather than the file's frontmatter.
    const s = this.host.session();
    if (!s) await this.host.ensureModelServices();
    const loader = (s?.resourceLoader ?? this.host.modelServices()?.resourceLoader) as SkillsLoader;
    const requested = resolve(path);
    const listed = loader
      .getSkills()
      .skills.find((skill) => resolve(skill.filePath) === requested);
    const file = listed || isBundledSkillPath(dirname(fileURLToPath(import.meta.url)), requested)
      ? requested
      : (await this.skillTarget(path)).file;
    const document = parseSkillDocument(await readFile(file, "utf8"));
    // A skill file may omit the frontmatter name. Pi then falls back to the
    // containing folder for a SKILL.md, or to the file name for a root .md
    // (case-insensitive, matching the editable-path check), so the editor
    // starts from the same name the list shows.
    const fallback = basename(file).toLowerCase() === "skill.md"
      ? basename(dirname(file))
      : basename(file).replace(/\.md$/i, "");
    return {
      path: file,
      name: document.name || fallback,
      description: document.description,
      body: document.body,
      // The loader's value is the effective one (post override table).
      disableModelInvocation: listed
        ? Boolean(listed.disableModelInvocation)
        : document.disableModelInvocation,
    } satisfies RuntimeSkillDocument;
  }

  private async createSkill(scope: "user" | "project", name: string, description: string, body: string, disableModelInvocation: boolean) {
    const root = await this.skillRoot(scope);
    this.assertSkillFields(name, description, body);
    const target = this.skillFile(root, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, serializeSkillDocument({
      name: name.trim(),
      description: description.trim(),
      body,
      disableModelInvocation,
      extra: {},
    }), "utf8");
    await this.reloadSkills();
    return { path: target };
  }

  private async importSkill(scope: "user" | "project", fallbackName: string, content: string) {
    const root = await this.skillRoot(scope);
    const document = parseSkillDocument(content);
    // Pi tolerates a name that breaks the spec, but PiX only manages
    // spec-valid skills, so an import normalizes whatever it finds into a
    // slug instead of refusing a document Pi would happily load.
    const name = slugifySkillName(document.name || fallbackName);
    if (!name) throw new Error("Skill name must contain at least one letter or number");
    this.assertSkillFields(name, document.description, document.body);
    const target = this.skillFile(root, name);
    await mkdir(dirname(target), { recursive: true });
    // Rewriting through the parser normalizes the document so Pi is
    // guaranteed to load it, while unmanaged frontmatter survives.
    await writeFile(target, serializeSkillDocument({
      ...document,
      name,
      description: document.description.trim(),
    }), "utf8");
    await this.reloadSkills();
    return { path: target };
  }

  private async updateSkill(path: string, name: string, description: string, body: string, disableModelInvocation: boolean) {
    const { file } = await this.skillTarget(path);
    this.assertSkillFields(name, description, body);
    const existing = parseSkillDocument(await readFile(file, "utf8"));
    await writeFile(file, serializeSkillDocument({
      ...existing,
      name: name.trim(),
      description: description.trim(),
      body,
      disableModelInvocation,
    }), "utf8");
    await this.reloadSkills();
    return { path: file };
  }

  private async deleteSkill(path: string) {
    const { roots, file } = await this.skillTarget(path);
    const directory = dirname(file);
    const ownsDirectory = basename(file).toLowerCase() === "skill.md" &&
      roots.editable.some((root) => resolve(root) !== directory && isPathInside(root, directory));
    if (ownsDirectory) await rm(directory, { recursive: true, force: true });
    else await rm(file, { force: true });
    await this.reloadSkills();
    return { ok: true };
  }

  private async setSkillManualOnly(path: string, manualOnly: boolean) {
    // A bundled skill's file is read-only (replaced on upgrade, possibly
    // unwritable), so its manual-only preference goes to the override
    // table that skillsOverride applies at load time. Only paths inside
    // the bundled roots take this branch; everything else still has to
    // be an editable skill file.
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const requested = resolve(path);
    if (isBundledSkillPath(moduleDir, requested)) {
      const document = parseSkillDocument(await readFile(requested, "utf8"));
      const fallback = basename(requested).toLowerCase() === "skill.md"
        ? basename(dirname(requested))
        : basename(requested).replace(/\.md$/i, "");
      setBuiltinSkillManualOnly(document.name || fallback, manualOnly);
      await this.reloadSkills();
      return { ok: true };
    }
    const { file } = await this.skillTarget(path);
    const document = parseSkillDocument(await readFile(file, "utf8"));
    await writeFile(file, serializeSkillDocument({
      ...document,
      disableModelInvocation: manualOnly,
    }), "utf8");
    await this.reloadSkills();
    return { ok: true };
  }

  /** Skill roots PiX may create or rewrite for the active project. */
  private async skillFileRoots() {
    const pi = await this.host.pi();
    return skillRoots(this.host.agentDir(), this.host.cwd() ?? homedir(), pi.CONFIG_DIR_NAME, homedir());
  }
  /**
   * Reloads discovery after a skill file changes so the settings list and the
   * /skill:name commands (expanded against the live loader) agree with disk.
   * The active session's system prompt is deliberately left alone: it is the
   * prompt-cache prefix, and rebuilding it would reprocess the entire history.
   * The <available_skills> advertisement only refreshes in a new or reloaded
   * session, the same trade-off Pi's own CLI makes.
   */
  private async reloadSkills() {
    const loader = this.host.session()?.resourceLoader;
    if (loader) {
      await loader.reload();
      return;
    }
    await this.host.ensureModelServices();
    await this.host.modelServices()?.resourceLoader?.reload();
  }
  private async skillTarget(path: string) {
    const roots = await this.skillFileRoots();
    return { roots, file: assertEditableSkillPath(path, roots.editable) };
  }
  private async skillRoot(scope: "user" | "project") {
    if (scope === "project" && !this.host.cwd()) throw new Error("Open a project first");
    const { user, project } = await this.skillFileRoots();
    return resolve(scope === "project" ? project : user);
  }
  /** Validates the editable fields shared by create, import, and update. */
  private assertSkillFields(name: string, description: string, body: string) {
    const nameError = skillNameError(name);
    if (nameError) throw new Error(SKILL_NAME_MESSAGES[nameError]);
    const descriptionError = skillDescriptionError(description);
    if (descriptionError) throw new Error(SKILL_DESCRIPTION_MESSAGES[descriptionError]);
    const bodyError = skillBodyError(body);
    if (bodyError) throw new Error(SKILL_BODY_MESSAGES[bodyError]);
  }
  private skillFile(root: string, name: string) {
    const slug = slugifySkillName(name);
    const file = join(root, slug, "SKILL.md");
    if (existsSync(file) || existsSync(join(root, `${slug}.md`)))
      throw new Error(`A skill named "${name}" already exists`);
    return file;
  }
}
