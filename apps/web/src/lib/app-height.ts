/** On a touch screen, size the app to the visible viewport, so the open keyboard
 * shrinks the app instead of pushing its header off the top. iOS Safari keeps the
 * layout viewport full height under the keyboard and scrolls the page instead;
 * Android Chrome resizes it already (interactive-widget in index.html). */
export function installAppHeight(): void {
  const viewport = window.visualViewport;
  if (!viewport || !window.matchMedia("(pointer: coarse)").matches) return;
  const root = document.documentElement;
  let frame = 0;
  const apply = () => {
    frame = 0;
    // Pinch zoom also shrinks the visual viewport; only follow it at scale 1.
    if (Math.abs(viewport.scale - 1) > 0.01) return;
    root.style.setProperty("--app-height", `${Math.round(viewport.height)}px`);
    if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(apply);
  };
  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  apply();
}
