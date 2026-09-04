// Render-lifecycle signals for boot-time layout choreography.
//
// Nothing here may assume "wait N frames / M ms and hope": requestAnimationFrame
// and ResizeObserver delivery are frozen while the document is hidden, and
// splitter panels only honor programmatic collapse/expand/resize after their
// group has been measured. Each helper waits for a real event instead.

export function nextFrame(timeoutMs = 120): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => requestAnimationFrame(finish));
    } else {
      setTimeout(finish, 0);
    }
  });
}

// Splitter panels and flow graphs measure their containers through
// ResizeObserver, which does not deliver while the document is hidden, so
// layout-affecting calls made before the first paint silently no-op. Wait for
// visibility before restoring UI geometry.
export function whenVisible(): Promise<void> {
  return new Promise((resolve) => {
    if (!document.hidden) return resolve();
    const onChange = () => {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", onChange);
      resolve();
    };
    document.addEventListener("visibilitychange", onChange);
  });
}

// Resolves on the element's first non-zero ResizeObserver delivery. RO
// callbacks for every observer run in the same rendering pass, so once this
// fires the splitter groups have their real size and collapse/expand/resize
// calls take effect. The timeout is a last-resort escape, not the mechanism.
export function whenMeasured(element: Element, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve) => {
    if (typeof ResizeObserver !== "function") return resolve();
    let settled = false;
    const observer = new ResizeObserver((entries) => {
      if (entries.some((entry) => entry.contentRect.width > 0 || entry.contentRect.height > 0)) finish();
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      observer.disconnect();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    observer.observe(element);
  });
}

export interface PanelSettleTarget {
  element: Element;
  collapsed: boolean;
  width: number;
}

// Resolves when every panel's rendered state matches the persisted layout:
// data-state agrees and the measured width reached the target (±2px). Panel
// transitions fire ResizeObserver entries while converging, so this tracks
// the actual settle point instead of the 340ms CSS transition duration; the
// timeout only covers layouts where constraints clamp the target away.
export function whenPanelsSettle(targets: PanelSettleTarget[], timeoutMs = 1500): Promise<void> {
  return new Promise((resolve) => {
    const reached = () => targets.every((target) => {
      const rect = target.element.getBoundingClientRect();
      if (target.collapsed)
        return target.element.getAttribute("data-state") === "collapsed" && rect.width < 2;
      return target.element.getAttribute("data-state") !== "collapsed" && Math.abs(rect.width - target.width) <= 2;
    });
    if (reached()) return resolve();
    if (typeof ResizeObserver !== "function") return resolve();
    let settled = false;
    const observer = new ResizeObserver(() => {
      if (reached()) finish();
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      observer.disconnect();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    for (const target of targets) observer.observe(target.element);
  });
}

// Resolves once no matching element has a running CSS transition. Re-checks
// after each batch settles because transitions register on the next rendering
// update, not synchronously with the style change.
export function whenTransitionsSettle(
  matches: (target: Element) => boolean,
  timeoutMs = 1500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    await nextFrame();
    if (typeof document.getAnimations !== "function") return;
    for (;;) {
      const running = document.getAnimations().filter((animation) => {
        const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
        return target instanceof Element && matches(target);
      });
      if (!running.length || Date.now() >= deadline) return;
      await Promise.race([
        Promise.allSettled(running.map((animation) => animation.finished)),
        new Promise((resolve) => setTimeout(resolve, deadline - Date.now())),
      ]);
      if (Date.now() >= deadline) return;
    }
  })();
}
