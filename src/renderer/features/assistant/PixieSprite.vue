<script setup lang="ts">
import { ContextMenuContent, ContextMenuItem, ContextMenuPortal, ContextMenuRoot, ContextMenuTrigger } from "reka-ui";
import { EyeOff, MessageSquare, MessageSquarePlus, Settings } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAssistantStore } from "../../stores/assistant";
import { useLayoutStore } from "../../stores/layout";

// Moods map 1:1 onto resources/pixie (built from assets/pixie/animations-v1):
// an animated webp per mood plus a static poster of its first frame, shown
// instead under prefers-reduced-motion. Loop lengths mirror manifest.json so
// one-shot moods hand back to idle on a frame boundary.
type Mood = "idle" | "wave" | "think" | "happy";
const LOOP_MS: Record<Mood, number> = { idle: 2270, wave: 1880, think: 2860, happy: 2050 };
const SIZE = 96;
// A still window (no pointer, no keys) sends the sprite to sleep; any input
// wakes it. Sleep is derived, not a mood, so a run or a greeting overrides it.
const SLEEP_AFTER_MS = 10 * 60_000;

const assistant = useAssistantStore();
const layout = useLayoutStore();
const { t } = useI18n();

const sprite = ref<HTMLElement>();
// null rides the CSS default (bottom-right corner); the first drag pins pixels
// and persists through the layout state.
const position = ref<{ left: number; top: number } | null>(null);
const mood = ref<Mood>("idle");
const sleeping = ref(false);
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const reduced = ref(reducedMotion.matches);

let moodTimer: number | undefined;
let sleepCheck: number | undefined;
let lastActivity = Date.now();
let drag: { id: number; grabX: number; grabY: number; startX: number; startY: number; moved: boolean } | undefined;
let suppressClick = false;

const enabled = computed(() => layout.hydrated && layout.settings?.app.pixie?.sprite !== false);
// Relative on purpose: the built page loads over file://, where an absolute
// /pixie/… would resolve to the drive root instead of the renderer directory
// (same reason WelcomeScreen binds "icon.png" at runtime).
const image = computed(() => `pixie/${sleeping.value && mood.value === "idle" ? "sleep" : mood.value}.${reduced.value ? "png" : "webp"}`);

function playOnce(next: "wave" | "happy", loops: number) {
  mood.value = next;
  clearTimeout(moodTimer);
  moodTimer = window.setTimeout(() => (mood.value = "idle"), LOOP_MS[next] * loops);
}

function noteActivity() {
  lastActivity = Date.now();
  sleeping.value = false;
}

// --- Dragging and activation -------------------------------------------------
// The graph controls own the bottom-right corner: the measured icon row is
// 88px wide at right 8 and 28px tall at bottom 33. Any position — dropped,
// restored, or after a window resize — that would sit on those three icons
// is lifted to just above them. The search box extends further left but is
// transient; only the icons are protected.
const CONTROLS_ZONE_RIGHT = 100, CONTROLS_ZONE_BOTTOM = 64;
function clamp(left: number, top: number) {
  const next = {
    left: Math.min(window.innerWidth - SIZE - 8, Math.max(8, left)),
    top: Math.min(window.innerHeight - SIZE - 8, Math.max(44, top)),
  };
  if (next.left + SIZE > window.innerWidth - CONTROLS_ZONE_RIGHT &&
      next.top + SIZE > window.innerHeight - CONTROLS_ZONE_BOTTOM)
    next.top = window.innerHeight - CONTROLS_ZONE_BOTTOM - SIZE;
  return next;
}
function startDrag(event: PointerEvent) {
  if (event.button !== 0) return;
  const rect = sprite.value?.getBoundingClientRect();
  if (!rect) return;
  drag = {
    id: event.pointerId,
    grabX: event.clientX - rect.left,
    grabY: event.clientY - rect.top,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
  };
}
function dragMove(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.id) return;
  if (!drag.moved) {
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
    drag.moved = true;
    // Capture only once dragging is real: capturing on pointerdown would
    // swallow the click a plain tap must still produce.
    sprite.value?.setPointerCapture(event.pointerId);
  }
  position.value = clamp(event.clientX - drag.grabX, event.clientY - drag.grabY);
}
function endDrag(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.id) return;
  // The click following a drag's pointerup must not toggle the card. A
  // cancelled drag gets no click at all, so the guard clears itself on the
  // next tick instead of poisoning a later keyboard activation.
  if (drag.moved) {
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    if (position.value) void layout.setPixieSprite(position.value);
  }
  drag = undefined;
}
function toggle() {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  assistant.visible ? assistant.hide() : assistant.show();
}
function openPixieSettings() {
  layout.settingsCategory = "pixie";
  layout.screen = "settings";
}
function hideSprite() {
  layout.updateAppSettings({ pixie: { sprite: false } }).catch(error =>
    layout.showNotice(error instanceof Error ? error.message : String(error), "error"));
}
function constrainOnResize() {
  if (position.value) position.value = clamp(position.value.left, position.value.top);
}
// The saved position arrives when bootstrapping hydrates the layout state
// (setup runs earlier); it clamps into the current window in case it shrank,
// and loses to any position pinned locally since.
watch(() => layout.layout.pixieSprite, saved => {
  if (!position.value && saved) position.value = clamp(saved.left, saved.top);
}, { immediate: true });

onMounted(() => {
  // Warm the decoder so mood switches never show a blank frame.
  for (const name of ["idle", "wave", "think", "happy", "sleep"]) new Image().src = `pixie/${name}.${reduced.value ? "png" : "webp"}`;
  noteActivity();
  // pointerdown too: a click without any move must wake a sleeping sprite.
  window.addEventListener("pointerdown", noteActivity, { passive: true });
  window.addEventListener("pointermove", noteActivity, { passive: true });
  window.addEventListener("keydown", noteActivity);
  document.addEventListener("pointermove", dragMove);
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);
  window.addEventListener("resize", constrainOnResize);
  reducedMotion.addEventListener("change", onReducedMotionChange);
  sleepCheck = window.setInterval(() => {
    if (!sleeping.value && Date.now() - lastActivity >= SLEEP_AFTER_MS) sleeping.value = true;
  }, 30_000);
  // The launch greeting; a timed hand-back to idle.
  playOnce("wave", 2);
});
function onReducedMotionChange() {
  reduced.value = reducedMotion.matches;
}
onBeforeUnmount(() => {
  clearTimeout(moodTimer);
  clearInterval(sleepCheck);
  window.removeEventListener("pointerdown", noteActivity);
  window.removeEventListener("pointermove", noteActivity);
  window.removeEventListener("keydown", noteActivity);
  document.removeEventListener("pointermove", dragMove);
  document.removeEventListener("pointerup", endDrag);
  document.removeEventListener("pointercancel", endDrag);
  window.removeEventListener("resize", constrainOnResize);
  reducedMotion.removeEventListener("change", onReducedMotionChange);
});

// A finished run celebrates — unless it failed — and summoning the card greets;
// a new or ongoing run always thinks.
watch(() => assistant.running, (running, wasRunning) => {
  if (running) {
    clearTimeout(moodTimer);
    mood.value = "think";
  } else if (wasRunning && !assistant.error) playOnce("happy", 2);
});
watch(() => assistant.visible, visible => {
  if (visible) playOnce("wave", 2);
});
</script>

<template>
  <Teleport to="body">
    <ContextMenuRoot v-if="enabled">
      <ContextMenuTrigger as-child>
        <button
          ref="sprite"
          type="button"
          class="pixie-sprite"
          :style="position ? { left: `${position.left}px`, top: `${position.top}px` } : undefined"
          :title="`${t('assistant.open')} · ${t('assistant.dragHint')}`"
          :aria-label="t('assistant.title')"
          data-pixie-sprite
          @pointerdown="startDrag"
          @lostpointercapture="endDrag"
          @click="toggle"
        >
          <img :src="image" :width="SIZE" :height="SIZE" alt="" draggable="false" />
        </button>
      </ContextMenuTrigger>
      <ContextMenuPortal>
        <ContextMenuContent class="menu-content" data-pixie-menu>
          <ContextMenuItem class="menu-item" data-action="pixie-menu-toggle" @select="toggle">
            <MessageSquare :size="14" /> {{ assistant.visible ? t("assistant.collapse") : t("assistant.menuOpen") }}
          </ContextMenuItem>
          <ContextMenuItem
            class="menu-item"
            data-action="pixie-menu-new"
            :disabled="assistant.running"
            @select="assistant.newSession()"
          >
            <MessageSquarePlus :size="14" /> {{ t("assistant.newSession") }}
          </ContextMenuItem>
          <ContextMenuItem class="menu-item" data-action="pixie-menu-settings" @select="openPixieSettings">
            <Settings :size="14" /> {{ t("assistant.menuSettings") }}
          </ContextMenuItem>
          <ContextMenuItem class="menu-item" data-action="pixie-menu-hide" @select="hideSprite">
            <EyeOff :size="14" /> {{ t("assistant.menuHide") }}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenuPortal>
    </ContextMenuRoot>
  </Teleport>
</template>

<style scoped>
/* Above workbench panels, under the assistant card (140), dialogs, and toasts. */
.pixie-sprite {
  position: fixed;
  right: 18px;
  /* Parks above the bottom-right icon row — see CONTROLS_ZONE_* above. */
  bottom: 64px;
  z-index: 130;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.pixie-sprite[style*="left:"] { right: auto; }
.pixie-sprite:active { cursor: grabbing; }
.pixie-sprite:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 12px; }
.pixie-sprite img { display: block; width: 96px; height: 96px; pointer-events: none; }
</style>
