import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { slugifySkillName } from "../../../shared/skills";
import type { RuntimeSkill, RuntimeSkillDocument } from "../../../shared/types";
import { useLayoutStore } from "../../stores/layout";
import { useSessionStore } from "../../stores/session";
import { useWorkspaceStore } from "../../stores/workspace";

export function useSkills() {
  const layout = useLayoutStore();
  const session = useSessionStore();
  const workspace = useWorkspaceStore();
  const { t } = useI18n();

  const skills = ref<RuntimeSkill[]>([]);
  const skillQuery = ref("");
  const skillScope = ref<"all" | RuntimeSkill["scope"]>("all");
  const skillBusy = ref(false);
  const skillError = ref("");
  const skillActionPath = ref("");
  const skillImport = ref<HTMLInputElement>();
  const confirmingSkillPath = ref("");
  const skillEditor = ref<{ document?: RuntimeSkillDocument; scope: "user" | "project"; readonly?: boolean }>();
  const canUseProjectSkills = computed(() => !!workspace.project);

  const queriedSkills = computed(() => {
    const query = skillQuery.value.trim().toLowerCase();
    return skills.value.filter((skill) => !query || `${skill.name} ${skill.description} ${skill.path} ${skill.source}`.toLowerCase().includes(query));
  });
  const filteredSkills = computed(() => queriedSkills.value
    .filter((skill) => skillScope.value === "all" || skill.scope === skillScope.value)
    .sort((a, b) => a.name.localeCompare(b.name)));
  const skillSections = computed(() => {
    // Filters and search narrow the rows; they never hide a folder that exists,
    // because the folder header is where a new skill or an import lands. While
    // searching there is nothing to land in, so a folder with no match is noise
    // — and its "no skills here yet" line would be a lie.
    const searching = !!skillQuery.value.trim();
    const scopes = skillScope.value === "all"
      ? (["project", "user", "builtin", "temporary"] as const)
      : ([skillScope.value] as const);
    return scopes
      .map((scope) => ({
        scope,
        label: t(`settings.skillScopes.${scope}`),
        skills: filteredSkills.value.filter((skill) => skill.scope === scope),
      }))
      // Only the writable folders stay visible while empty: their headers are
      // where a new skill or an import lands. Built-in and additional-path
      // folders cannot receive one, so an empty one is noise.
      .filter((section) => searching || section.scope === "project" || section.scope === "user" || section.skills.length > 0);
  });
  const skillFilters = computed(() => (["all", "project", "user", "builtin", "temporary"] as const)
    .map((scope) => ({ scope, count: queriedSkills.value.filter((skill) => scope === "all" || skill.scope === scope).length })));

  async function loadSkills(reload = false) {
    // The skills list feeds two categories: its own page and the agent
    // page's output-style select, which lists skills by name.
    const category = layout.settingsCategory;
    if ((category !== "skills" && category !== "agent") || skillBusy.value) return;
    skillBusy.value = true;
    skillError.value = "";
    try {
      skills.value = await session.control<RuntimeSkill[]>({ action: "getSkills", reload });
    } catch (error) {
      skillError.value = error instanceof Error ? error.message : String(error);
    } finally {
      skillBusy.value = false;
    }
  }

  // A new skill or import lands in the project only when the project filter is
  // active and a project is open; otherwise it belongs to the user.
  function skillWriteScope(): "user" | "project" {
    return skillScope.value === "project" && canUseProjectSkills.value ? "project" : "user";
  }

  function openCreateSkill() {
    skillError.value = "";
    skillEditor.value = { scope: skillWriteScope() };
  }

  async function openEditSkill(skill: RuntimeSkill) {
    if (skillActionPath.value) return;
    skillActionPath.value = skill.path;
    skillError.value = "";
    try {
      const document = await session.control<RuntimeSkillDocument>({ action: "getSkill", path: skill.path });
      // Read-only skills (bundled, packaged) open the same sheet as a viewer.
      skillEditor.value = { document, scope: skill.scope === "project" ? "project" : "user", readonly: !skill.editable };
    } catch (error) {
      // Reload so a stale row (the file moved or the loader changed since the
      // list loaded) disappears instead of failing on every click.
      const message = error instanceof Error ? error.message : String(error);
      await loadSkills();
      skillError.value = message;
    } finally {
      skillActionPath.value = "";
    }
  }

  async function skillSaved() {
    const created = !skillEditor.value?.document;
    const scope = skillEditor.value?.scope;
    skillEditor.value = undefined;
    // Reveal what was just written instead of leaving it behind a filter.
    if (created && scope && skillScope.value !== "all" && skillScope.value !== scope) skillScope.value = scope;
    await loadSkills();
    layout.showNotice(t(created ? "settings.skillCreated" : "settings.skillSaved"));
  }

  // The frontmatter toggle is Pi's own "manual only" flag: the model stops
  // auto-loading the skill while /skill:name keeps working.
  async function toggleManualOnly(skill: RuntimeSkill) {
    if (skillActionPath.value) return;
    skillActionPath.value = skill.path;
    skillError.value = "";
    try {
      await session.control({ action: "setSkillManualOnly", path: skill.path, manualOnly: !skill.disableModelInvocation });
      await loadSkills();
      layout.showNotice(t(skill.disableModelInvocation ? "settings.skillAutoEnabled" : "settings.skillManualEnabled", { name: skill.name }));
    } catch (error) {
      // Reload first so the switch snaps back to what the disk actually says.
      const message = error instanceof Error ? error.message : String(error);
      await loadSkills();
      skillError.value = message;
    } finally {
      skillActionPath.value = "";
    }
  }

  // First press arms the row, second press deletes; the arm lapses so a stray
  // click cannot remove a skill later.
  async function removeSkill(skill: RuntimeSkill) {
    if (confirmingSkillPath.value !== skill.path) {
      confirmingSkillPath.value = skill.path;
      window.setTimeout(() => {
        if (confirmingSkillPath.value === skill.path) confirmingSkillPath.value = "";
      }, 4000);
      return;
    }
    confirmingSkillPath.value = "";
    if (skillActionPath.value) return;
    skillActionPath.value = skill.path;
    skillError.value = "";
    try {
      await session.control({ action: "deleteSkill", path: skill.path });
      await loadSkills();
      layout.showNotice(t("settings.skillDeleted", { name: skill.name }));
    } catch (error) {
      skillError.value = error instanceof Error ? error.message : String(error);
    } finally {
      skillActionPath.value = "";
    }
  }

  async function importSkillFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || skillActionPath.value) return;
    skillActionPath.value = "import";
    skillError.value = "";
    try {
      const name = slugifySkillName(file.name.replace(/\.md$/i, "")) || "imported-skill";
      const scope = skillWriteScope();
      await session.control({ action: "importSkill", scope, name, content: await file.text() });
      if (skillScope.value !== "all" && skillScope.value !== scope) skillScope.value = scope;
      await loadSkills();
      layout.showNotice(t("settings.skillImported", { name }));
    } catch (error) {
      skillError.value = error instanceof Error ? error.message : String(error);
    } finally {
      skillActionPath.value = "";
    }
  }

  return {
    skills,
    skillQuery,
    skillScope,
    skillBusy,
    skillError,
    skillActionPath,
    skillImport,
    confirmingSkillPath,
    skillEditor,
    queriedSkills,
    skillSections,
    skillFilters,
    loadSkills,
    openCreateSkill,
    openEditSkill,
    skillSaved,
    toggleManualOnly,
    removeSkill,
    importSkillFile,
  };
}
