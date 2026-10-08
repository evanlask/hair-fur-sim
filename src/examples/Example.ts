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
  init(ctx: ExampleContext): Promise<void>;
  update(info: FrameInfo): void;
  /** Extra HUD lines. */
  hud?(): string[];
}
