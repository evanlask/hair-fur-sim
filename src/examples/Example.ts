import type { FolderApi } from 'tweakpane';

import type { App, FrameInfo } from '../app/App';
import type { Gui } from '../app/Gui';
import type { LightRig } from '../app/LightRig';
import type { QualityPreset } from '../app/quality';
import type { HairSystem } from '../hair/HairSystem';

export interface ExampleContext {
  app: App;
  hair: HairSystem;
  gui: Gui;
  lights: LightRig;
  quality: QualityPreset;
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
}
