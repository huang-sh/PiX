<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Folder,
  LoaderCircle,
  MonitorUp,
  Server,
  ShieldCheck,
  TerminalSquare,
  X,
} from "@lucide/vue";
import type { FileNode, WslDistribution } from "../../../shared/types";
import Button from "../../components/ui/Button.vue";

const props = defineProps<{
  open: boolean;
  distributions: WslDistribution[];
  distributionsLoading?: boolean;
  sshHosts: string[];
  sshLoading?: boolean;
  connectedPath?: string;
  directories: FileNode[];
  directoryBusy: boolean;
  busy: boolean;
  error?: string;
}>();
const emit = defineEmits<{
  close: [];
  back: [];
  connectWsl: [input: { distro: string; cwd: string; browse?: boolean }];
  connectSsh: [input: { host: string; cwd: string; browse?: boolean }];
  probeWsl: [];
  browseDirectory: [path: string];
  openDirectory: [path: string];
}>();

const { t } = useI18n();
const step = ref<1 | 2 | 3 | 4>(1);
const mode = ref<"wsl" | "ssh">("ssh");
const distro = ref("");
const host = ref("");
const path = ref("");
const selectedDistro = computed(() =>
  props.distributions.find((item) => item.name === distro.value),
);
const steps = computed(() => [
  t("remote.step1"),
  t("remote.step2"),
  t("remote.step3"),
  t("remote.step4"),
]);
const title = computed(() => [
  t("remote.title1"),
  t("remote.title2", { mode: mode.value.toUpperCase() }),
  t("remote.title3"),
  t("remote.title4"),
][step.value - 1]);
const subtitle = computed(() => [
  t("remote.subtitle1"),
  mode.value === "ssh"
    ? t("remote.subtitle2Ssh")
    : t("remote.subtitle2Wsl"),
  t("remote.subtitle3"),
  t("remote.subtitle4"),
][step.value - 1]);

watch(
  () => props.distributions,
  () => {
    if (!props.distributions.some((item) => item.name === distro.value))
      distro.value = props.distributions[0]?.name ?? "";
  },
  { immediate: true, deep: true },
);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    step.value = 1;
    if (mode.value === "wsl") emit("probeWsl");
    if (!host.value && props.sshHosts.length === 1) host.value = props.sshHosts[0]!;
  },
);

watch(
  () => props.connectedPath,
  (connectedPath) => {
    if (!props.open || !connectedPath) return;
    path.value = connectedPath;
    step.value = 4;
  },
);

watch(
  () => [props.error, props.busy] as const,
  ([error, busy]) => {
    if (error && !busy) step.value = props.connectedPath ? 4 : 2;
  },
);

function choose(next: "wsl" | "ssh") {
  mode.value = next;
  if (next === "wsl") emit("probeWsl");
}

function connect() {
  step.value = 3;
  if (mode.value === "ssh")
    emit("connectSsh", { host: host.value.trim(), cwd: "~", browse: true });
  else
    emit("connectWsl", {
      distro: distro.value,
      cwd: selectedDistro.value?.home ?? "",
      browse: true,
    });
}

function enterDirectory(node: FileNode) {
  path.value = node.path;
  emit("browseDirectory", node.path);
}

function parentDirectory() {
  const current = path.value.replace(/\/+$/u, "");
  const parent = current.slice(0, current.lastIndexOf("/")) || "/";
  path.value = parent;
  emit("browseDirectory", parent);
}

function browseTypedPath() {
  const input = path.value.trim();
  if (input) emit("browseDirectory", input);
}

function finish() {
  const cwd = path.value.trim();
  if (!cwd) return;
  step.value = 3;
  emit("openDirectory", cwd);
}

function previous() {
  if (step.value === 2) step.value = 1;
  else if (step.value === 4) {
    step.value = 2;
    emit("back");
  }
}
</script>

<template>
  <template v-if="open">
    <div class="dialog-overlay remote-overlay" @click.self="step !== 3 && emit('close')" />
    <form class="remote-dialog" data-wsl-dialog @submit.prevent>
      <aside class="remote-stepper">
        <div class="remote-stepper-title"><MonitorUp :size="18" /> {{ t("remote.sidebarTitle") }}</div>
        <ol>
          <li v-for="(label, index) in steps" :key="label" :class="{ active: step === index + 1, done: step > index + 1 }">
            <span class="remote-step-number">
              <Check v-if="step > index + 1" :size="14" />
              <template v-else>{{ index + 1 }}</template>
            </span>
            <strong>{{ label }}</strong>
          </li>
        </ol>
      </aside>

      <main class="remote-dialog-main">
        <header class="remote-dialog-header">
          <div>
            <h2>{{ title }}</h2>
            <p>{{ subtitle }}</p>
          </div>
          <Button data-action="wsl-close" variant="ghost" size="icon" type="button" :title="t('common.close')" :disabled="step === 3" @click="emit('close')">
            <X :size="18" />
          </Button>
        </header>

          <section class="remote-dialog-page">
            <div v-if="step === 1" class="remote-methods">
              <button type="button" class="remote-method" :class="{ selected: mode === 'ssh' }" @click="choose('ssh')">
                <span class="remote-method-icon"><Server :size="25" /></span>
                <strong>SSH</strong>
                <small>{{ t("remote.sshSubtitle") }}</small>
                <span v-if="sshHosts.length" class="remote-method-meta">{{ t(sshHosts.length === 1 ? "remote.oneHostFound" : "remote.hostsFound", { n: sshHosts.length }) }}</span>
                <span v-else-if="sshLoading" class="remote-method-meta">{{ t("remote.sshChecking") }}</span>
              </button>
              <button data-action="remote-method-wsl" type="button" class="remote-method" :class="{ selected: mode === 'wsl' }" @click="choose('wsl')">
                <span class="remote-method-icon"><TerminalSquare :size="25" /></span>
                <strong>WSL</strong>
                <small>{{ t("remote.wslSubtitle") }}</small>
                <span v-if="distributions.length" class="remote-method-meta">{{ t(distributions.length === 1 ? "remote.oneDistroFound" : "remote.distrosFound", { n: distributions.length }) }}</span>
                <span v-else-if="distributionsLoading" class="remote-method-meta">{{ t("remote.distrosChecking") }}</span>
              </button>
            </div>

            <div v-else-if="step === 2" class="remote-config">
              <label v-if="mode === 'ssh'">
                <span>{{ t("remote.sshHostLabel") }}</span>
                <input v-model="host" list="pix-ssh-hosts" :placeholder="t('remote.sshHostPlaceholder')" autocomplete="off" />
                <datalist id="pix-ssh-hosts">
                  <option v-for="item in sshHosts" :key="item" :value="item" />
                </datalist>
                <small v-if="sshHosts.length">{{ t("remote.sshHostsDetected") }}</small>
                <small v-else-if="sshLoading">{{ t("remote.sshChecking") }}</small>
                <small v-else>{{ t("remote.sshNoHosts") }}</small>
                <div v-if="sshHosts.length" class="remote-host-list">
                  <button v-for="item in sshHosts" :key="item" type="button" :class="{ selected: host === item }" @click="host = item">
                    <Server :size="16" />
                    <span><strong>{{ item }}</strong><small>{{ t("remote.sshConfig") }}</small></span>
                    <Check v-if="host === item" :size="15" />
                  </button>
                </div>
              </label>
              <label v-else>
                <span>{{ t("remote.wslDistroLabel") }}</span>
                <select v-model="distro" data-wsl-distro>
                  <option v-for="item in distributions" :key="item.name" :value="item.name">{{ item.name }}</option>
                </select>
                <small v-if="selectedDistro?.home">{{ t("remote.initialDirectory", { path: selectedDistro.home }) }}</small>
                <small v-else-if="selectedDistro">{{ t("remote.detectingHome") }}</small>
                <small v-else-if="distributionsLoading">{{ t("remote.distrosChecking") }}</small>
                <small v-else>{{ t("remote.noDistros") }}</small>
              </label>
              <div class="remote-security-note">
                <ShieldCheck :size="20" />
                <div>
                  <strong>{{ t("remote.credentialsLocalTitle") }}</strong>
                  <p>{{ (mode === 'ssh' ? t('remote.securitySsh') : t('remote.securityWsl')) + ' ' + t('remote.securityLocal') }}</p>
                </div>
              </div>
            </div>

            <div v-else-if="step === 3" class="remote-connecting" aria-live="polite">
              <span class="remote-spinner"><LoaderCircle :size="30" /></span>
              <h3>{{ busy ? t('remote.preparing') : t('remote.finishing') }}</h3>
              <p>{{ t("remote.connectingDetail") }}</p>
              <div class="remote-progress"><i /></div>
            </div>

            <div v-else class="remote-browser">
              <div class="remote-connected"><Check :size="18" /><strong>{{ t("remote.connected") }}</strong><span>{{ mode === 'ssh' ? host : distro }}</span></div>
              <label>
                <span>{{ t("remote.remoteDirectory") }}</span>
                <div class="remote-path-row">
                  <input v-model="path" data-wsl-path autocomplete="off" @keydown.enter.prevent="browseTypedPath" />
                  <Button type="button" variant="outline" :disabled="directoryBusy" @click="browseTypedPath">
                    <LoaderCircle v-if="directoryBusy" class="remote-inline-spinner" :size="15" />
                    {{ directoryBusy ? t("remote.loading") : t("common.go") }}
                  </Button>
                </div>
                <small>{{ t("remote.selectFolderHint") }}</small>
              </label>
              <div class="remote-folder-list">
                <button v-if="path !== '/'" type="button" :disabled="directoryBusy" @click="parentDirectory">
                  <Folder :size="17" /><span>..</span><small>{{ t("remote.parentDirectory") }}</small>
                </button>
                <button v-for="node in directories" :key="node.path" type="button" :disabled="directoryBusy" @click="enterDirectory(node)">
                  <Folder :size="17" /><span>{{ node.name }}</span><ChevronRight :size="15" />
                </button>
                <p v-if="!directoryBusy && !directories.length" class="remote-empty">{{ t("remote.noFolders") }}</p>
              </div>
            </div>

            <p v-if="error" class="wsl-dialog-error">{{ error }}</p>
          </section>

        <footer class="remote-dialog-footer">
          <Button v-if="step === 1" variant="ghost" type="button" @click="emit('close')">{{ t("common.cancel") }}</Button>
          <Button v-else-if="step !== 3" variant="outline" type="button" :disabled="busy" @click="previous">
            <ChevronLeft :size="15" /> {{ t("common.back") }}
          </Button>
          <span v-else />
          <Button v-if="step === 1" data-action="remote-next" class="remote-primary" type="button" @click="step = 2">{{ t("common.next") }} <ChevronRight :size="15" /></Button>
          <Button v-else-if="step === 2" data-action="wsl-submit" class="remote-primary" type="button" :disabled="busy || (mode === 'ssh' ? !host.trim() : !distro)" @click="connect">
            {{ t("remote.connect") }} <ChevronRight :size="15" />
          </Button>
          <Button v-else-if="step === 3" variant="ghost" type="button" disabled>{{ t("remote.connecting") }}</Button>
          <Button v-else data-action="remote-open-folder" class="remote-primary" type="button" :disabled="busy || !path.trim()" @click="finish">{{ t("remote.openFolder") }}</Button>
        </footer>
      </main>
    </form>
  </template>
</template>
