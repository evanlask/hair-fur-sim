import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import {
  mix,
  mrt,
  output,
  pass,
  renderOutput,
  screenUV,
  smoothstep,
  uniform,
  vec2,
  velocity,
} from 'three/tsl';
import * as THREE from 'three/webgpu';

/**
 * 'msaa': straight to the canvas (4× or 1× MSAA). 'taa': temporal reprojection AA.
 * 'fxaa' / 'smaa': post-process edge AA on the tone-mapped image (no MSAA).
 */
export type AntialiasingMode = 'msaa' | 'taa' | 'fxaa' | 'smaa';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

export class WebGPUUnavailableError extends Error {}

/**
 * The hair compute and strand vertex shaders need more and larger storage buffers than the WebGPU defaults allow, so
 * these are requested at the adapter's maximum.
 */
const WANTED_LIMITS = [
  'maxStorageBuffersPerShaderStage',
  'maxStorageBuffersInVertexStage',
  'maxStorageBufferBindingSize',
  'maxBufferSize',
  'maxComputeWorkgroupStorageSize',
  'maxComputeInvocationsPerWorkgroup',
  'maxComputeWorkgroupSizeX',
] as const;

async function buildRequiredLimits(): Promise<Record<string, number>> {
  if (!('gpu' in navigator) || !navigator.gpu) throw new WebGPUUnavailableError('navigator.gpu is missing');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new WebGPUUnavailableError('No WebGPU adapter');
  const limits: Record<string, number> = {};
  const available = adapter.limits as unknown as Record<string, number>;
  for (const key of WANTED_LIMITS) {
    if (key in adapter.limits && typeof available[key] === 'number') limits[key] = available[key];
  }
  return limits;
}

export interface FrameInfo {
  /** Simulated seconds this frame: real time × `App.timeScale`. */
  dt: number;
  /** Real seconds this frame (camera, music, FPS). */
  realDt: number;
  /** Simulated seconds since start. */
  time: number;
  frame: number;
}

export class App {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(35, 1, 0.01, 60);
  readonly controls: OrbitControls;
  readonly container: HTMLElement;
  readonly floor: THREE.Mesh;
  /** Backdrop gradient and floor colours (lighting presets tint them). */
  readonly backdrop = {
    top: uniform(new THREE.Color(0x2a2d36)),
    bottom: uniform(new THREE.Color(0x07080b)),
    floor: uniform(new THREE.Color(0x1c1d22)),
  };
  /** Called every frame before rendering. */
  onUpdate: ((info: FrameInfo) => void) | null = null;
  /** Speed of simulated time (slow motion below 1); the camera keeps real time. */
  timeScale = 1;
  private simTime = 0;
  /** Called after the main render (e.g. stats). */
  onAfterRender: ((info: FrameInfo) => void) | null = null;
  /** Called right before the main render, after onUpdate (e.g. extra passes). */
  onBeforeRender: ((info: FrameInfo) => void) | null = null;

  private renderScale = 1.5;
  private timer = new THREE.Timer();
  private frame = 0;
  private envTextures = new Map<string, THREE.Texture>();

  private constructor(container: HTMLElement, renderer: THREE.WebGPURenderer) {
    this.container = container;
    this.renderer = renderer;
    container.appendChild(renderer.domElement);

    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera.position.set(0, 1.2, 3.2);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 0.6, 0);
    this.controls.minDistance = 0.15;
    this.controls.maxDistance = 20;

    // Backdrop: vertical gradient (sky at the top, horizon at the bottom) with a soft vignette.
    const vignette = smoothstep(1.25, 0.2, screenUV.sub(vec2(0.5, 0.55)).length().mul(1.6));
    this.scene.backgroundNode = mix(
      this.backdrop.bottom,
      this.backdrop.top,
      screenUV.y.oneMinus().pow(1.4),
    ).mul(vignette.mul(0.6).add(0.4));

    this.floor = this.createFloor();
    this.scene.add(this.floor);

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.timer.connect(document);
  }

  static async create(container: HTMLElement): Promise<App> {
    const requiredLimits = await buildRequiredLimits();
    const renderer = new THREE.WebGPURenderer({
      antialias: true,
      trackTimestamp: true,
      powerPreference: 'high-performance',
      requiredLimits,
    } as ConstructorParameters<typeof THREE.WebGPURenderer>[0]);
    await renderer.init();
    const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean; compatibilityMode?: boolean };
    if (!backend.isWebGPUBackend) throw new WebGPUUnavailableError('WebGPURenderer fell back to WebGL');
    if (backend.compatibilityMode) {
      console.warn('[fursim] WebGPU compatibility mode: MSAA/alpha-to-coverage disabled, hair will alias.');
    }
    return new App(container, renderer);
  }

  get samples(): number {
    return (this.renderer as unknown as { samples: number }).samples ?? 0;
  }

  setRenderScale(scale: number): void {
    this.renderScale = scale;
    this.resize();
  }

  getRenderScale(): number {
    return this.renderScale;
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.renderScale));
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Sets the backdrop gradient (top = sky, bottom = horizon) and floor colours (sRGB hex). */
  setBackdrop(top: string, bottom: string, floor: string): void {
    this.backdrop.top.value.set(top);
    this.backdrop.bottom.value.set(bottom);
    this.backdrop.floor.value.set(floor);
  }

  async loadEnvironment(name: string, intensity = 1): Promise<void> {
    let tex = this.envTextures.get(name);
    if (!tex) {
      tex = await new HDRLoader().loadAsync(`env/${name}`);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      this.envTextures.set(name, tex);
    }
    this.scene.environment = tex;
    this.scene.environmentIntensity = intensity;
  }

  private antialiasing: AntialiasingMode = 'msaa';
  private readonly pipelines = new Map<AntialiasingMode, THREE.RenderPipeline>();

  setAntialiasing(mode: AntialiasingMode): void {
    this.antialiasing = mode;
    if (mode === 'msaa' || this.pipelines.has(mode)) return;
    const scenePass = pass(this.scene, this.camera);
    const pipeline = new THREE.RenderPipeline(this.renderer);
    if (mode === 'taa') {
      scenePass.setMRT(mrt({ output, velocity }));
      pipeline.outputNode = traa(
        scenePass.getTextureNode('output'),
        scenePass.getTextureNode('depth'),
        scenePass.getTextureNode('velocity'),
        this.camera,
      );
    } else {
      // Edge AA needs the final (tone-mapped, sRGB) image.
      pipeline.outputColorTransform = false;
      const display = renderOutput(scenePass);
      pipeline.outputNode = mode === 'fxaa' ? fxaa(display) : smaa(display);
    }
    this.pipelines.set(mode, pipeline);
  }

  /**
   * MSAA sample count for direct rendering (WebGPU allows 1 or 4). The renderer only reads it when it
   * creates its internal framebuffer target, so the cached targets are dropped and rebuilt.
   */
  setMsaaSamples(samples: 1 | 4): void {
    const r = this.renderer as unknown as {
      _samples: number;
      _frameBufferTargets: Map<unknown, THREE.RenderTarget>;
    };
    const value = samples === 4 ? 4 : 0;
    if (r._samples === value) return;
    r._samples = value;
    r._frameBufferTargets.forEach((target) => target.dispose());
    r._frameBufferTargets.clear();
  }

  private renderScene(): void {
    const pipeline = this.pipelines.get(this.antialiasing);
    if (this.antialiasing !== 'msaa' && pipeline) pipeline.render();
    else this.renderer.render(this.scene, this.camera);
  }

  start(): void {
    void this.renderer.setAnimationLoop((timestamp?: number) => this.tick(timestamp));
  }

  private tick(timestamp?: number): void {
    try {
      this.timer.update(timestamp);
      // Cap dt so a stall (e.g. returning to a background tab) doesn't hit the simulation with one huge step.
      const realDt = Math.min(this.timer.getDelta(), 1 / 20);
      const dt = realDt * this.timeScale;
      this.simTime += dt;
      const info: FrameInfo = { dt, realDt, time: this.simTime, frame: this.frame++ };
      this.controls.update(realDt);
      this.onUpdate?.(info);
      this.onBeforeRender?.(info);
      this.renderScene();
      this.onAfterRender?.(info);
    } catch (err) {
      // Stop on the first per-frame error instead of flooding the console every frame.
      void this.renderer.setAnimationLoop(null);
      console.error('[fursim] frame loop stopped:', err);
      this.onError?.(err);
    }
  }

  /** Called if the frame loop throws (the loop is stopped). */
  onError: ((err: unknown) => void) | null = null;

  /**
   * GPU-bound benchmark that is immune to rAF throttling: pauses the loop, renders frames back-to-back and waits for
   * the GPU queue after each. The first 5 frames are warm-up and not timed. Called from DevTools via `__fursim.app`.
   */
  async benchmark(frames = 40, dt = 1 / 60): Promise<{ medianMs: number; p90Ms: number }> {
    void this.renderer.setAnimationLoop(null);
    const device = (this.renderer.backend as unknown as { device: GPUDevice }).device;
    const times: number[] = [];
    for (let i = 0; i < frames + 5; i++) {
      const t0 = performance.now();
      this.simTime += dt;
      const info: FrameInfo = { dt, realDt: dt, time: this.simTime, frame: this.frame++ };
      this.onUpdate?.(info);
      this.onBeforeRender?.(info);
      this.renderScene();
      this.onAfterRender?.(info);
      await device.queue.onSubmittedWorkDone();
      if (i >= 5) times.push(performance.now() - t0);
    }
    this.start();
    times.sort((a, b) => a - b);
    return { medianMs: times[Math.floor(times.length / 2)], p90Ms: times[Math.floor(times.length * 0.9)] };
  }

  private createFloor(): THREE.Mesh {
    const geometry = new THREE.CircleGeometry(12, 96);
    geometry.rotateX(-Math.PI / 2);
    // Low specular: a glossy floor would mirror the rim light straight back at the camera.
    const material = new THREE.MeshPhysicalNodeMaterial({
      roughness: 1,
      metalness: 0,
      specularIntensity: 0.12,
      envMapIntensity: 0.3,
    });
    // Fade the floor into the backdrop's horizon colour towards its rim.
    const r = THREE.TSL.positionLocal.xz.length();
    material.colorNode = mix(this.backdrop.floor, this.backdrop.bottom.mul(1.1), smoothstep(1.0, 7.0, r));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.name = 'floor';
    return mesh;
  }
}
