<script setup lang="ts">
import { Primitive, type PrimitiveProps } from "reka-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn";

const styles = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default: "bg-[var(--accent)] text-[var(--accent-foreground)] hover:bg-[var(--accent-strong)]",
        ghost: "text-[var(--muted)] hover:bg-[var(--muted-surface)] hover:text-[var(--text)]",
        outline: "border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--muted-surface)]",
        danger: "bg-[var(--danger)] text-[var(--danger-foreground)]",
      },
      size: {
        default: "h-9 px-3",
        sm: "h-8 px-2.5 text-xs",
        icon: "size-8 p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

type ButtonVariants = VariantProps<typeof styles>;
interface Props extends PrimitiveProps {
  variant?: ButtonVariants["variant"];
  size?: ButtonVariants["size"];
  class?: string;
}
const props = withDefaults(defineProps<Props>(), { as: "button" });
</script>

<template>
  <Primitive
    :as="props.as"
    :as-child="props.asChild"
    :class="cn(styles({ variant: props.variant, size: props.size }), props.class)"
  >
    <slot />
  </Primitive>
</template>
