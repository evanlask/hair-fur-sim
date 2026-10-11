/**
 * Loading indicator. Grooming runs on the main thread and blocks it for seconds, so every label change waits until
 * the browser has painted it before the blocking work starts. The spinner is a CSS transform animation, which the
 * compositor keeps turning while the page is blocked.
 *
 * Startup uses the full-screen overlay (static in index.html, so it shows before any script has loaded); later
 * blocking work (regrooms) uses a small badge over the running scene.
 */
export class Loading {
  private readonly el = document.getElementById('loading')!;
  private readonly label = document.getElementById('loading-label')!;
  private busyCount = 0;

  /** Shows `label` on the startup overlay and resolves once it is on screen. */
  step(label: string): Promise<void> {
    this.label.textContent = label;
    return painted();
  }

  /** Fades the startup overlay out. */
  hide(): void {
    this.el.classList.add('done');
    this.el.addEventListener('transitionend', () => this.reset(), { once: true });
    // No transition runs if the overlay is already invisible (e.g. a background tab).
    setTimeout(() => this.reset(), 500);
  }

  /** Shows `label` in a badge while blocking work `fn` runs (e.g. a regroom). */
  async busy<T>(label: string, fn: () => T): Promise<T> {
    this.busyCount++;
    this.label.textContent = label;
    this.el.classList.remove('done');
    this.el.classList.add('badge');
    this.el.hidden = false;
    try {
      await painted();
      return fn();
    } finally {
      if (--this.busyCount === 0) this.el.hidden = true;
    }
  }

  private reset(): void {
    if (this.busyCount > 0) return;
    this.el.hidden = true;
    this.el.classList.remove('done');
  }
}

/** Resolves after the next frame has been painted (or soon anyway in a background tab, where frames stop). */
function painted(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
    setTimeout(resolve, 100);
  });
}
