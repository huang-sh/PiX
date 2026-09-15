<script setup lang="ts">
import { Download, Eye, Lock, Pencil, Plus, RefreshCw, Search, Sparkles, Trash2, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import Button from "../../components/ui/Button.vue";
import SkillEditorForm from "./SkillEditorForm.vue";
import { useSkillsContext } from "./settings-context";

const { t } = useI18n();
const {
  skills, skillQuery, skillScope, skillBusy, skillError, skillActionPath, skillImport, confirmingSkillPath,
  skillEditor, queriedSkills, skillSections, skillFilters, loadSkills, openCreateSkill, openEditSkill,
  skillSaved, toggleManualOnly, removeSkill, importSkillFile,
} = useSkillsContext();
</script>

<template>
  <section class="settings-card skill-card" :aria-busy="skillBusy">
    <div class="skill-toolbar">
      <div class="skill-segments" role="radiogroup" :aria-label="t('settings.skillFilterLabel')">
        <button v-for="filter in skillFilters" :key="filter.scope" type="button" role="radio" :aria-checked="skillScope === filter.scope" :class="{ active: skillScope === filter.scope }" :data-skill-filter="filter.scope" @click="skillScope = filter.scope">
          {{ t(`settings.skillFilters.${filter.scope}`) }}<span class="skill-segment-count">{{ filter.count }}</span>
        </button>
      </div>
      <label class="skill-search">
        <Search :size="13" aria-hidden="true" />
        <input type="search" v-model="skillQuery" data-skill-search :aria-label="t('settings.searchSkills')" :placeholder="t('settings.searchSkills')" />
        <button v-if="skillQuery" type="button" class="skill-search-clear" :aria-label="t('common.close')" @click="skillQuery = ''"><X :size="11" /></button>
      </label>
      <div class="skill-toolbar-actions">
        <input ref="skillImport" type="file" accept=".md,text/markdown" hidden @change="importSkillFile" />
        <Button variant="outline" size="sm" data-skill-import :title="t('settings.skillImportHint')" :disabled="!!skillActionPath" @click="skillImport?.click()"><Download :size="14" />{{ t("settings.importSkill") }}</Button>
        <Button size="sm" data-skill-new :disabled="!!skillActionPath" @click="openCreateSkill"><Plus :size="14" />{{ t("settings.newSkill") }}</Button>
        <Button variant="outline" size="icon" :title="t('settings.refreshSkills')" :disabled="skillBusy" @click="loadSkills(true)">
          <RefreshCw :size="15" :class="{ spin: skillBusy }" />
        </Button>
      </div>
    </div>
    <div class="skill-panel" :class="{ 'is-refreshing': skillBusy && skills.length }">
      <p v-if="skillError" class="skill-error" role="alert">{{ skillError }}</p>
      <div v-if="skillBusy && !skills.length" class="skill-skeleton" role="status" :aria-label="t('settings.loadingSkills')">
        <div v-for="row in 3" :key="row" class="skill-skeleton-row">
          <span class="skill-skeleton-glyph" />
          <span class="skill-skeleton-lines"><span class="skill-skeleton-line" /><span class="skill-skeleton-line is-desc" /></span>
        </div>
      </div>
      <div v-else-if="skillQuery && !queriedSkills.length" class="skill-empty">
        <span class="skill-empty-icon"><Search :size="18" /></span>
        <strong>{{ t("settings.noMatchingSkills") }}</strong>
        <span>{{ t("settings.skillNoMatchHint") }}</span>
        <Button variant="outline" size="sm" @click="skillQuery = ''">{{ t("settings.modelResetFilters") }}</Button>
      </div>
      <template v-else>
        <section v-for="section in skillSections" :key="section.scope" class="skill-group">
          <header class="skill-group-header">
            <span class="skill-group-label">{{ section.label }}</span>
            <span class="skill-group-count">{{ section.skills.length }}</span>
          </header>
          <div v-if="section.skills.length" class="skill-list" role="list">
            <article v-for="skill in section.skills" :key="skill.path" class="skill-row" :class="{ 'is-off': skill.disableModelInvocation, 'is-busy': skillActionPath === skill.path }" role="listitem" :data-skill="skill.name" :title="skill.path">
              <span class="skill-glyph" aria-hidden="true"><Sparkles :size="15" /></span>
              <div class="skill-copy">
                <div class="skill-row-title">
                  <span class="skill-name">{{ skill.name }}</span>
                  <span class="skill-badge is-level">{{ t(`settings.skillFilters.${skill.scope}`) }}</span>
                  <span v-if="skill.disableModelInvocation && !skill.editable" class="skill-badge is-manual">{{ t("settings.manualSkill") }}</span>
                  <span v-if="!skill.editable" class="skill-badge"><Lock :size="10" />{{ t("settings.skillReadOnly") }}</span>
                  <span v-if="skill.shadowsBuiltin" class="skill-badge" :title="skill.shadowsBuiltin">{{ t("settings.skillShadowsBuiltin") }}</span>
                </div>
                <p class="skill-description" :title="skill.description">{{ skill.description }}</p>
              </div>
              <div class="skill-actions">
                <button v-if="skill.editable || skill.scope === 'builtin'" type="button" class="skill-switch" role="switch" data-skill-manual :aria-checked="!skill.disableModelInvocation" :aria-label="t('settings.skillAuto')" :title="t(skill.disableModelInvocation ? 'settings.skillManualOnlyHint' : 'settings.skillAutoHint')" :disabled="!!skillActionPath" @click="toggleManualOnly(skill)">
                  <span class="skill-switch-thumb" />
                </button>
                <Button v-if="!skill.editable" class="skill-action" variant="ghost" size="icon" data-skill-view :title="t('settings.viewSkill')" :disabled="!!skillActionPath" @click="openEditSkill(skill)"><Eye :size="15" /></Button>
                <Button v-if="skill.editable" class="skill-action" variant="ghost" size="icon" :title="t('settings.editSkill')" :disabled="!!skillActionPath" @click="openEditSkill(skill)"><Pencil :size="15" /></Button>
                <Button v-if="skill.editable" class="skill-action skill-action-delete" :class="confirmingSkillPath === skill.path ? 'is-arming' : undefined" variant="ghost" size="icon" :title="t(confirmingSkillPath === skill.path ? 'settings.skillDeleteConfirm' : 'settings.deleteSkill')" :disabled="!!skillActionPath" @click="removeSkill(skill)"><Trash2 :size="15" /></Button>
              </div>
            </article>
          </div>
          <p v-else class="skill-group-empty">{{ t("settings.skillGroupEmpty") }}</p>
        </section>
      </template>
    </div>
  </section>
  <SkillEditorForm v-if="skillEditor" :key="skillEditor.document?.path ?? `new:${skillEditor.scope}`" :skill="skillEditor.document" :scope="skillEditor.scope" :readonly="skillEditor.readonly" @saved="skillSaved" @cancel="skillEditor = undefined" />
</template>
