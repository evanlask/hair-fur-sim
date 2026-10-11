import type { FolderApi } from 'tweakpane';

import type { App, FrameInfo } from '../app/App';
import type { Gui } from '../app/Gui';
import type { LightRig } from '../app/LightRig';
import type { Loading } from '../app/Loading';
import type { QualityPreset } from '../app/quality';
import type { HairSystem } from '../hair/HairSystem';

export interface ExampleContext {
  app: App;
  hair: HairSystem;
  gui: Gui;
  lights: LightRig;
  quality: QualityPreset;
  /** Call `loading.step(label)` before each slow startup stage, `loading.busy()` around later regrooms. */
  loading: Loading;
}

export interface Example {
  readonly title: string;
  /** Loads the scene and adds the example's own GUI folders (they come first in the panel). */
  init(ctx: ExampleContext): Promise<void>;
  /** Show / hide toggles for the shared "View & simulation" folder (the simulation controls follow them). */
  viewControls(f: FolderApi): void;
  update(info: FrameInfo): void;
  /** Extra HUD lines. */
  hud?(): string[];
  /** The example saves and restores its own work, so the shared Save / load folder (panel state) is left out. */
  readonly ownsState?: boolean;
  /** Extra Help entries for this example (HTML `<li>` items). */
  readonly help?: string;
  /** Its Help replaces the app's general entries (an example with controls of its own, like a tool). */
  readonly helpOnly?: boolean;
  /** What reloading the page would lose (asked before a quality change reloads it), or null if nothing. */
  reloadWarning?(): string | null;
}
