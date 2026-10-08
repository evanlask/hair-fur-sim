import * as THREE from 'three/webgpu';

import { App, WebGPUUnavailableError } from './app/App';
import { Gui, num } from './app/Gui';
import { LIGHTING_PRESETS, type LightingName, type LightingPreset } from './app/lightingPresets';
import { LightRig } from './app/LightRig';
import { QUALITY, getQuality, type QualityName } from './app/quality';
import { Stats } from './app/Stats';
import type { Example, ExampleContext } from './examples/Example';
import { HairSystem } from './hair/HairSystem';
import { hairRenderSettings } from './hair/render/HairMaterial';

const EXAMPLES: Record<string, { title: string; load: () => Promise<Example> }> = {
  hairball: {
    title: 'Hair Ball',
    load: async () => new (await import('./examples/HairBall')).HairBallExample(),
  },
  fox: { title: 'Fox', load: async () => new (await import('./examples/Fox')).FoxExample() },
  wayne: { title: 'Wayne', load: async () => new (await import('./examples/Mullet')).MulletExample() },
  yeti: { title: 'Yeti', load: async () => new (await import('./examples/Yeti')).YetiExample() },
};
/** Renamed examples, so old links still work. */
const EXAMPLE_ALIASES: Record<string, string> = { mullet: 'wayne' };

function showStatus(title: string, body: string): void {
  const el = document.getElementById('status')!;
  el.innerHTML = `<div class="box"><h2>${title}</h2>${body.trimStart().startsWith('<') ? body : `<p>${body}</p>`}</div>`;
  el.dataset.kind = '';
  el.hidden = false;
}

const HELP_HTML = `
  <ul class="help">
    <li><b>Examples</b>: switch with the tabs at the top left (Hair Ball, Fox, Wayne, Yeti).</li>
    <li><b>Camera</b>: left-drag on empty space to orbit, right-drag to pan, mouse wheel to zoom.</li>
    <li><b>Grab &amp; shake</b>: left-drag the hair ball, Wayne's bust or the yeti and let go. It springs back and the hair swings.</li>
    <li><b>Panels</b> (right), all live:
      <i>Rendering</i> (quality preset, render scale, antialiasing MSAA 4× / off / FXAA / SMAA / TAA, tone mapping) ·
      <i>Lighting</i> (presets: studio, neutral studio, portrait, sunrise, midday, sunset, evening; exposure, environment, lamps) ·
      the example's own controls · <i>Hair</i> / <i>Fur</i> (hair colour presets, <i>Groom</i> sliders that regrow the hair,
      <i>Physics</i>, <i>Style</i>, <i>Shading</i>) · <i>Debug</i> (show guides or colliders, pause, step, reset) ·
      <i>Saved settings</i> (save / load in the browser, export / import JSON).</li>
    <li><b>Headbang to music</b> (Wayne): open <i>Music</i> and press <i>Play</i> (or <b>M</b>). The head locks to the beat;
      pick <i>headbang</i>, <i>nod</i> or <i>roxbury</i> as the motion, or another <i>track</i>. An idle head moves with each
      track's own motion: the <i>roxbury</i> bob for "What Is Love", a <i>nod</i> for "End of Beginning" and headbanging
      for the rest, and goes back to idle when the music stops.
      <i>Beat sync</i> has tap tempo (<b>T</b>), ×2 / ÷2, <i>move</i> (on the beat, every ½ beat for double time, or every 2
      or 4 beats) and a sync offset.</li>
  </ul>
  <p style="opacity:.7">Press <b>H</b> to toggle this help · click anywhere to close.</p>`;

function toggleHelp(): void {
  const el = document.getElementById('status')!;
  if (!el.hidden && el.dataset.kind === 'help') {
    el.hidden = true;
    return;
  }
  showStatus('Help', HELP_HTML);
  el.dataset.kind = 'help';
  el.onclick = () => (el.hidden = true);
}

function buildNav(current: string): void {
  const nav = document.getElementById('examples')!;
  const params = new URLSearchParams(location.search);
  nav.innerHTML = '';
  for (const [key, ex] of Object.entries(EXAMPLES)) {
    params.set('example', key);
    const a = document.createElement('a');
    a.href = `?${params.toString()}`;
    a.textContent = ex.title;
    if (key === current) a.classList.add('active');
    nav.appendChild(a);
  }
  const help = document.createElement('a');
  help.href = '#';
  help.textContent = 'Help';
  help.onclick = (e) => {
    e.preventDefault();
    toggleHelp();
  };
  nav.appendChild(help);
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
    if (e.key === 'h' || e.key === 'H') toggleHelp();
    if (e.key === 'Escape') document.getElementById('status')!.hidden = true;
  });
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const requested = params.get('example') ?? '';
  const resolved = EXAMPLE_ALIASES[requested] ?? requested;
  const key = resolved in EXAMPLES ? resolved : 'hairball';
  buildNav(key);
  const quality = getQuality();

  let app: App;
  try {
    app = await App.create(document.getElementById('app')!);
  } catch (err) {
    if (err instanceof WebGPUUnavailableError || !('gpu' in navigator)) {
      showStatus(
        'WebGPU required',
        'This demo simulates and renders hair with WebGPU compute shaders. Please use a recent Chrome, Edge or Safari (26+) with WebGPU enabled.',
      );
    } else {
      showStatus('Failed to start', String(err));
    }
    throw err;
  }

  app.setRenderScale(quality.renderScale);
  const lights = new LightRig(app.scene, app.renderer);
  lights.params.shadowMapSize = quality.shadowMapSize;
  lights.apply();
  await app.loadEnvironment(LIGHTING_PRESETS.studio.env, lights.params.envIntensity);

  const gui = new Gui();
  const hair = new HairSystem(app.renderer, app.scene, app.camera, lights);
  hair.shadowResolution = quality.hairShadowSize;
  const stats = new Stats(app.renderer, document.getElementById('hud')!);

  const rendering = gui.folder('Rendering', false);
  const q = {
    preset: quality.name as QualityName,
    renderScale: quality.renderScale,
    toneMapping: app.renderer.toneMapping as number,
  };
  rendering
    .addBinding(q, 'preset', {
      label: 'quality',
      options: { low: 'low', medium: 'medium', high: 'high', ultra: 'ultra' },
    })
    .on('change', () => {
      if (q.preset === quality.name) return;
      params.set('quality', q.preset);
      location.search = params.toString();
    });
  num(rendering, q, 'renderScale', { min: 0.5, max: 2, step: 0.05, label: 'render scale' }, () =>
    app.setRenderScale(q.renderScale),
  );
  // WebGPU supports 1 or 4 MSAA samples (no 2× or 8×). FXAA / SMAA are post-process filters on the final image.
  type AaChoice = 'msaa4' | 'off' | 'fxaa' | 'smaa' | 'taa';
  const aa = { mode: 'msaa4' as AaChoice };
  const cov = { coverage: hairRenderSettings.coverage };
  rendering
    .addBinding(aa, 'mode', {
      label: 'antialiasing',
      options: {
        'MSAA 4×': 'msaa4',
        'off (1×)': 'off',
        'FXAA (post)': 'fxaa',
        'SMAA (post)': 'smaa',
        'TAA (temporal)': 'taa',
      },
    })
    .on('change', () => {
      const mode = aa.mode;
      app.setAntialiasing(mode === 'msaa4' || mode === 'off' ? 'msaa' : mode);
      app.setMsaaSamples(mode === 'msaa4' ? 4 : 1);
      hair.setTemporalAntialiasing(mode === 'taa');
      // Alpha to coverage needs MSAA; without it hair falls back to stochastic coverage.
      if (mode !== 'msaa4' && mode !== 'taa' && cov.coverage === 'alphaToCoverage') {
        cov.coverage = 'stochastic';
        hair.setCoverage('stochastic');
      }
      coverageBinding.hidden = mode !== 'msaa4';
    });
  // MSAA only: how strand coverage maps to samples (TAA uses its own temporal coverage).
  const coverageBinding = rendering
    .addBinding(cov, 'coverage', {
      label: 'strand coverage',
      options: { 'stochastic (per-sample)': 'stochastic', 'alpha to coverage': 'alphaToCoverage' },
    })
    .on('change', () => hair.setCoverage(cov.coverage));
  rendering
    .addBinding(q, 'toneMapping', {
      label: 'tone mapping',
      options: {
        'AgX (filmic)': THREE.AgXToneMapping,
        'Khronos neutral': THREE.NeutralToneMapping,
        'ACES filmic': THREE.ACESFilmicToneMapping,
        Reinhard: THREE.ReinhardToneMapping,
        Cineon: THREE.CineonToneMapping,
        'linear (exposure only)': THREE.LinearToneMapping,
        none: THREE.NoToneMapping,
      },
    })
    .on('change', () => (app.renderer.toneMapping = q.toneMapping as THREE.ToneMapping));

  const lighting = gui.folder('Lighting', false);
  const lp = lights.params;
  const apply = () => lights.apply();
  const look = { preset: 'studio' as LightingName };
  lighting
    .addBinding(look, 'preset', {
      options: Object.fromEntries(Object.keys(LIGHTING_PRESETS).map((k) => [k, k])),
    })
    .on('change', async () => {
      const preset: LightingPreset = LIGHTING_PRESETS[look.preset];
      Object.assign(lp, preset.light);
      app.setBackdrop(preset.backdrop.top, preset.backdrop.bottom, preset.backdrop.floor);
      lights.apply();
      await app.loadEnvironment(preset.env, lp.envIntensity);
      hair.lighting.setEnvironment(app.scene.environment);
      gui.pane.refresh();
    });
  num(lighting, lp, 'exposure', { min: 0.1, max: 3 }, apply);
  num(lighting, lp, 'envIntensity', { min: 0, max: 3, label: 'environment' }, apply);
  num(lighting, lp, 'envSaturation', { min: 0, max: 1, label: 'env color on hair' }, apply);
  const lamps = gui
    .folder('Lamps', false, lighting)
    .addTab({ pages: [{ title: 'Key' }, { title: 'Rim' }, { title: 'Fill' }] });
  (['key', 'rim', 'fill'] as const).forEach((lamp, i) => {
    const page = lamps.pages[i];
    num(page, lp, `${lamp}Intensity`, { min: 0, max: 10, label: 'intensity' }, apply);
    num(page, lp, `${lamp}Azimuth`, { min: -180, max: 360, label: 'azimuth' }, apply);
    num(page, lp, `${lamp}Elevation`, { min: -10, max: 90, label: 'elevation' }, apply);
    page.addBinding(lp, `${lamp}Color`, { view: 'color', label: 'color' }).on('change', apply);
  });

  const ctx: ExampleContext = { app, hair, gui, lights, quality };
  const example = await EXAMPLES[key].load();
  await example.init(ctx);
  hair.registerShadowReceiver(app.floor.material as THREE.NodeMaterial);

  addPresetControls(gui, key);

  app.onUpdate = (info) => {
    stats.beginCpu();
    gui.fps.begin();
    example.update(info);
    hair.update(info.dt, info.time);
  };
  app.onAfterRender = (info) => {
    stats.endCpu();
    gui.fps.end();
    stats.update(info.dt, hair.stats(), example.hud?.() ?? []);
  };
  app.onError = (err) => showStatus('Rendering stopped', String(err));
  app.start();

  // Debug handle for automated checks (DevTools MCP).
  (window as unknown as { __fursim: unknown }).__fursim = {
    app,
    hair,
    lights,
    gui,
    stats,
    example,
    quality,
    QUALITY,
  };
}

/** Save / load / export / import every GUI value (Tweakpane state) per example. */
function addPresetControls(gui: Gui, exampleKey: string): void {
  // Tweakpane restores state by position: bump the version whenever the panels' layout changes.
  const storageKey = `fursim:settings:v4:${exampleKey}`;
  const f = gui.folder('Saved settings', false);
  const apply = (state: unknown) => {
    try {
      if (!gui.pane.importState(state as Parameters<typeof gui.pane.importState>[0]))
        console.warn('[fursim] preset only partly matches this example');
    } catch (err) {
      console.warn('[fursim] preset does not match this example', err);
    }
  };
  f.addButton({ title: 'Save (browser)' }).on('click', () =>
    localStorage.setItem(storageKey, JSON.stringify(gui.pane.exportState())),
  );
  f.addButton({ title: 'Load (browser)' }).on('click', () => {
    const s = localStorage.getItem(storageKey);
    if (s) apply(JSON.parse(s));
  });
  f.addButton({ title: 'Export JSON' }).on('click', () => {
    const blob = new Blob([JSON.stringify(gui.pane.exportState(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hair-fur-simulation-${exampleKey}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  f.addButton({ title: 'Import JSON' }).on('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) apply(JSON.parse(await file.text()));
    };
    input.click();
  });
  f.addButton({ title: 'Reset to defaults' }).on('click', () => location.reload());
}

main().catch((err) => console.error('[fursim]', err));
