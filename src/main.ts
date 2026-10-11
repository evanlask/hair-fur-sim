import * as THREE from 'three/webgpu';

import { App, WebGPUUnavailableError } from './app/App';
import { Gui, addSimulationControls, num, tip } from './app/Gui';
import { LIGHTING_PRESETS, type LightingName, type LightingPreset } from './app/lightingPresets';
import { LightRig } from './app/LightRig';
import { Loading } from './app/Loading';
import { QUALITY, getQuality, type QualityName, type QualityPreset } from './app/quality';
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
  document.getElementById('loading')!.hidden = true;
}

const HELP_HTML = `
  <ul class="help">
    <li><b>Examples</b>: switch with the tabs at the top left (Hair Ball, Fox, Wayne, Yeti).</li>
    <li><b>Camera</b>: left-drag on empty space to orbit, right-drag to pan, mouse wheel to zoom.</li>
    <li><b>Grab &amp; shake</b>: left-drag the hair ball, Wayne's bust or the yeti and let go. It springs back and the hair swings.</li>
    <li><b>Panels</b> (right), all live; hover a setting for what it does:
      the example's own controls · <i>Hair</i> / <i>Fur</i> (colour presets, the <i>Basics</i> sliders, <i>Groom</i>
      sliders that regrow the hair, <i>Wind</i>, then <i>Motion</i>, <i>Strand shape</i>, <i>Color &amp; shine</i> and
      <i>Performance</i>) ·
      <i>Lighting</i> (looks: studio, neutral studio, portrait, sunrise, midday, sunset, evening; exposure, environment, lamps) ·
      <i>Rendering</i> (quality preset, render scale, antialiasing MSAA 4× / off / FXAA / SMAA / TAA, tone mapping) ·
      <i>View &amp; simulation</i> (show guides or colliders, slow motion, pause, step, reset) ·
      <i>Save / load</i> (save / load in the browser, export / import JSON).</li>
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
  const loading = new Loading();
  await loading.step('Starting WebGPU…');

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
  await loading.step('Loading lighting…');
  await app.loadEnvironment(LIGHTING_PRESETS.studio.env, lights.params.envIntensity);

  const gui = new Gui();
  const hair = new HairSystem(app.renderer, app.scene, app.camera, lights);
  hair.shadowResolution = quality.hairShadowSize;
  const stats = new Stats(app.renderer, document.getElementById('hud')!);

  // The example's own folders come first (what you play with most), then the scene-wide ones.
  const ctx: ExampleContext = { app, hair, gui, lights, quality, loading };
  await loading.step(`Loading ${EXAMPLES[key].title}…`);
  const example = await EXAMPLES[key].load();
  await example.init(ctx);
  hair.registerShadowReceiver(app.floor.material as THREE.NodeMaterial);

  addLightingFolder(gui, app, lights, hair);
  addRenderingFolder(gui, app, hair, quality, params);
  const view = gui.folder('View & simulation', false);
  example.viewControls(view);
  view.addBlade({ view: 'separator' });
  addSimulationControls(view, app, hair);
  addPresetControls(gui, key);

  app.onUpdate = (info) => {
    stats.beginCpu();
    // Pausing the simulation also freezes the examples' animation (one 1/60 s step for "Step one frame"), so
    // bodies don't move away from their paused hair.
    example.update(hair.paused ? { ...info, dt: hair.stepOnce ? 1 / 60 : 0 } : info);
    hair.update(info.dt, info.time);
  };
  app.onAfterRender = (info) => {
    stats.endCpu();
    stats.update(info.realDt, hair.stats(), example.hud?.() ?? []);
    // The first frames compile the shaders; the scene is ready once they are through.
    if (info.frame === 2) loading.hide();
  };
  app.onError = (err) => showStatus('Rendering stopped', String(err));
  await loading.step('Compiling shaders…');
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
    profile: (frames?: number) => profileStages(app, hair, frames),
  };
}

/**
 * Times frames with each hair stage skipped in turn (`await __fursim.profile()` in DevTools). Each stage is timed
 * right after a fresh baseline and the median of `reps` differences is its cost (GPU clocks drift, so one baseline
 * for all is misleading). The skipped stage's output goes stale, so frames look wrong while it runs.
 */
async function profileStages(
  app: App,
  hair: HairSystem,
  frames = 40,
  reps = 3,
): Promise<Record<string, number>> {
  const stages = ['solve', 'interpolate', 'shadows', 'shade', 'draw'] as const;
  const median = (v: number[]) => v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const baselines: number[] = [];
  const costs: Record<string, number[]> = {};
  for (let r = 0; r < reps; r++) {
    for (const stage of stages) {
      const base = (await app.benchmark(frames)).medianMs;
      hair.debugSkip[stage] = true;
      try {
        (costs[stage] ??= []).push(base - (await app.benchmark(frames)).medianMs);
      } finally {
        hair.debugSkip[stage] = false;
      }
      baselines.push(base);
    }
  }
  const out: Record<string, number> = { baseline: median(baselines) };
  for (const stage of stages) out[stage] = median(costs[stage]);
  for (const k in out) out[k] = Math.round(out[k] * 100) / 100;
  console.table(out);
  return out;
}

/** Rendering settings: quality preset, resolution, antialiasing and tone mapping. */
function addRenderingFolder(
  gui: Gui,
  app: App,
  hair: HairSystem,
  quality: QualityPreset,
  params: URLSearchParams,
): void {
  const rendering = gui.folder('Rendering', true);
  const q = {
    preset: quality.name as QualityName,
    renderScale: quality.renderScale,
    toneMapping: app.renderer.toneMapping as number,
  };
  tip(
    rendering.addBinding(q, 'preset', {
      label: 'quality',
      options: { low: 'low', medium: 'medium', high: 'high', ultra: 'ultra' },
    }),
    'Reloads the page with another quality preset (strand counts, shadow sizes, substeps).',
  ).on('change', () => {
    if (q.preset === quality.name) return;
    params.set('quality', q.preset);
    location.search = params.toString();
  });
  num(
    rendering,
    q,
    'renderScale',
    {
      min: 0.5,
      max: 2,
      step: 0.05,
      label: 'render scale',
      hint: "Pixels per screen point, up to the display's own density (no supersampling): lower is faster, higher is sharper on high-DPI screens.",
    },
    () => app.setRenderScale(q.renderScale),
  );
  // WebGPU supports 1 or 4 MSAA samples (no 2× or 8×). FXAA / SMAA are post-process filters on the final image.
  type AaChoice = 'msaa4' | 'off' | 'fxaa' | 'smaa' | 'taa';
  const aa = { mode: 'msaa4' as AaChoice };
  const cov = { coverage: hairRenderSettings.coverage };
  tip(
    rendering.addBinding(aa, 'mode', {
      label: 'antialiasing',
      options: {
        'MSAA 4×': 'msaa4',
        'off (1×)': 'off',
        'FXAA (post)': 'fxaa',
        'SMAA (post)': 'smaa',
        'TAA (temporal)': 'taa',
      },
    }),
    'MSAA smooths edges while drawing; FXAA / SMAA filter the finished image; TAA blends frames over time.',
  ).on('change', () => {
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
  const coverageBinding = tip(
    rendering
      .addBinding(cov, 'coverage', {
        label: 'strand coverage',
        options: { 'stochastic (per-sample)': 'stochastic', 'alpha to coverage': 'alphaToCoverage' },
      })
      .on('change', () => hair.setCoverage(cov.coverage)),
    'How thin, semi-transparent strands are drawn with MSAA.',
  );
  tip(
    rendering.addBinding(q, 'toneMapping', {
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
    }),
    'How bright lighting is compressed into screen colors.',
  ).on('change', () => (app.renderer.toneMapping = q.toneMapping as THREE.ToneMapping));
}

/** Lighting look, environment and the three lamps. */
function addLightingFolder(gui: Gui, app: App, lights: LightRig, hair: HairSystem): void {
  const lighting = gui.folder('Lighting', false);
  const lp = lights.params;
  const apply = () => lights.apply();
  const look = { preset: 'studio' as LightingName };
  lighting
    .addBinding(look, 'preset', {
      label: 'look',
      options: Object.fromEntries(Object.keys(LIGHTING_PRESETS).map((k) => [k, k])),
    })
    .on('change', async () => {
      const preset: LightingPreset = LIGHTING_PRESETS[look.preset];
      Object.assign(lp, preset.light);
      app.setBackdrop(preset.backdrop.top, preset.backdrop.bottom, preset.backdrop.floor);
      lights.apply();
      if (!(await app.loadEnvironment(preset.env, lp.envIntensity))) return;
      hair.lighting.setEnvironment(app.scene.environment);
      gui.pane.refresh();
    });
  num(lighting, lp, 'exposure', { min: 0.1, max: 3, hint: 'Overall image brightness.' }, apply);
  num(
    lighting,
    lp,
    'envIntensity',
    {
      min: 0,
      max: 3,
      label: 'environment light',
      hint: 'Brightness of the surrounding (image-based) light.',
    },
    apply,
  );
  num(
    lighting,
    lp,
    'envSaturation',
    {
      min: 0,
      max: 1,
      label: 'environment tint',
      hint: "How much the environment's colors tint the hair (0 = neutral light on the hair).",
    },
    apply,
  );
  num(
    lighting,
    hair,
    'bodyShadowScale',
    {
      min: 0,
      max: 1,
      label: 'hair shadow on skin',
      hint: "Darkness of the hair's shadow on the body and floor, relative to its self-shadow.",
    },
    () => {},
  );
  // The three lamps, switched with tabs.
  const lamps = lighting.addTab({
    pages: [{ title: 'Key lamp' }, { title: 'Rim lamp' }, { title: 'Fill lamp' }],
  });
  (['key', 'rim', 'fill'] as const).forEach((lamp, i) => {
    const page = lamps.pages[i];
    num(page, lp, `${lamp}Intensity`, { min: 0, max: 10, label: 'intensity' }, apply);
    num(
      page,
      lp,
      `${lamp}Azimuth`,
      { min: -180, max: 180, label: 'azimuth (°)', hint: 'Direction around the scene (0 = from +Z).' },
      apply,
    );
    num(
      page,
      lp,
      `${lamp}Elevation`,
      { min: -10, max: 90, label: 'elevation (°)', hint: 'Height above the horizon.' },
      apply,
    );
    page.addBinding(lp, `${lamp}Color`, { view: 'color', label: 'color' }).on('change', apply);
  });
}

/** Save / load / export / import every GUI value (Tweakpane state) per example. */
function addPresetControls(gui: Gui, exampleKey: string): void {
  // Tweakpane restores state by position: bump the version whenever the panels' layout changes.
  const storageKey = `fursim:settings:v10:${exampleKey}`;
  const f = gui.folder('Save / load', false);
  /** Applies a saved preset given as JSON text; bad JSON or a mismatched layout only warns. */
  const apply = (json: string) => {
    try {
      const state = JSON.parse(json) as Parameters<typeof gui.pane.importState>[0];
      if (!gui.pane.importState(state)) console.warn('[fursim] preset only partly matches this example');
    } catch (err) {
      console.warn('[fursim] preset does not match this example', err);
    }
  };
  f.addButton({ title: 'Save (browser)' }).on('click', () =>
    localStorage.setItem(storageKey, JSON.stringify(gui.pane.exportState())),
  );
  f.addButton({ title: 'Load (browser)' }).on('click', () => {
    const s = localStorage.getItem(storageKey);
    if (s) apply(s);
  });
  f.addButton({ title: 'Export JSON' }).on('click', () => {
    const blob = new Blob([JSON.stringify(gui.pane.exportState(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hair-fur-simulation-${exampleKey}.json`;
    a.click();
    // Revoking right after click() can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  });
  f.addButton({ title: 'Import JSON' }).on('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        apply(await file.text());
      } catch (err) {
        console.warn('[fursim] could not read the preset file', err);
      }
    };
    input.click();
  });
  f.addButton({ title: 'Reset to defaults' }).on('click', () => location.reload());
}

main().catch((err) => {
  console.error('[fursim]', err);
  // Keep a more specific message (e.g. "WebGPU required") if one is already up.
  if (document.getElementById('status')!.hidden) showStatus('Failed to start', String(err));
});
