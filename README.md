# Hair & Fur Simulation

Real-time strand hair and fur in the browser, simulated and rendered entirely on the GPU with
[three.js](https://threejs.org) (r186) WebGPU and TSL compute shaders.

A few thousand **guide hairs** are simulated with position-based physics, and hundreds of thousands of
**render strands** are interpolated from them every frame, then shaded with a Marschner hair BSDF, deep-shadowed and
drawn as camera-facing ribbons.

**Live demo:** <https://evanlask.github.io/hair-fur-sim/>

It needs a browser with WebGPU: Chrome or Edge, or Safari 26+. Other browsers get an explanatory message instead
of a blank page.

## Examples

Switch between them with the tabs at the top left.

| Example       | What it shows                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hair Ball** | Long hair on a sphere, torus, rounded box, capsule or torus knot. Drag to shake it, or pick a motion preset, add wind and change the colour.              |
| **Fox**       | Dense, fine fur on the animated Khronos Fox (walk, run, survey), coloured from its texture, with bone capsules as colliders.                              |
| **Wayne**     | A two-part 1980s mullet on a head scan on a marble pedestal. Press **M** for music and the head bangs to the beat.                                        |
| **Yeti**      | Long shaggy fur on an animated cartoon yeti: a beard, short fur on the face and ears, bare skin where it belongs. It collides with the moving body's SDF. |

## Controls

| Input                    | Action                                           |
| ------------------------ | ------------------------------------------------ |
| Left-drag on empty space | Orbit                                            |
| Right-drag               | Pan                                              |
| Mouse wheel              | Zoom                                             |
| Left-drag the subject    | Grab and shake it; it springs back when released |
| **H**                    | Show / hide help                                 |
| **M**                    | Play / stop music (Wayne)                        |
| **T**                    | Tap tempo (Wayne)                                |

Every setting in the panel on the right updates live, and hovering one shows what it does:

- **Example:** shape, motion and speed for the current scene (and music for Wayne).
- **Hair / Fur:** colour presets and the **Basics** sliders (style hold, bend stiffness, damping, gravity, curl,
  frizz, clump, width, shine), groom sliders that regrow the hair, wind, then the **Motion**, **Strand shape**,
  **Color & shine** and **Performance** folders and a reset button. Wayne has a tab for each hair group.
- **Lighting:** looks from studio to sunset and evening, exposure, environment strength, hair shadow on skin and
  per-lamp settings.
- **Rendering:** quality preset (strand and guide counts, shadow resolution, solver substeps), render scale,
  antialiasing (MSAA 4×, FXAA, SMAA, TAA or off), tone mapping.
- **View & simulation:** show or hide the body, hair, guides and colliders; slow motion, pause, step and reset.
- **Save / load:** save and load in the browser, export or import JSON, reset to defaults.

The HUD at the bottom left shows FPS, CPU time, GPU compute and render time, and guide and strand counts.

## How it works

```
CPU, once per groom    sample roots → grow guides from style fields → bind each render strand to 3 guides

GPU, every frame       skin the growth mesh             1 thread per vertex
                       compute root frames              1 thread per guide
                       solve guides (all substeps)      1 thread per guide
                       interpolate render strands       1 thread per strand
                       render hair shadow maps          front/back hair depth + opaque depth
                       shade strand points              1 thread per point
                       draw ribbons                     instanced, 16 strands per instance
```

**Grooming** (`src/hair/groom/`). Guide roots are Poisson-disk sampled over the growth mesh. Each guide is grown from
a style's fields (mask, length, comb direction, lift, droop, wave) and pushed out of colliders. Render strands are
bound to their three nearest guides and shuffled so that any prefix is a uniform subset, which makes level of detail a
matter of drawing fewer strands. Rest shapes are stored in per-root frames, so they follow the skinned surface.

**Simulation** (`src/hair/sim/solver.ts`). This combines TressFX-style shape constraints with Dynamic
Follow-The-Leader (Müller et al. 2012):

- Verlet integration with gravity, damping, a "follow root" inertia control, and air drag towards gusty wind.
- Global and local shape constraints keep the groomed style and its bending.
- Follow-The-Leader length constraints with collision handling inside the sweep, plus velocity correction and
  friction against moving colliders.
- Substeps have a fixed length and every coefficient is time-step independent, so uneven frame pacing doesn't add
  energy and all quality presets behave the same.
- Colliders are bone-attached capsules, analytic SDF shapes and baked mesh SDFs. A skinned SDF follows its mesh's
  skinning every frame by warm-started inverse skinning per cell (`sdfSkin.ts`). This is how the yeti's whole body
  pushes its fur around.

**Interpolation** (`interpolate.ts`). Each render strand samples its guides along a Catmull-Rom spline, blends them in
the root frame (short fur) or in world space (long hanging hair), and adds clumping, curl and frizz on a
rotation-minimising frame.

**Shading** (`shade.ts`, `src/hair/render/`). Lighting runs in compute once per strand point. It uses Karis's
Marschner approximation (R, TT and TRT lobes) for three lamps, multiple-scattering diffuse, and spherical-harmonics
environment light. A deep-shadow approximation gives self-shadowing from the key light, alongside opaque-caster
shadows and root ambient occlusion.

**Rendering** (`HairMaterial.ts`). Strands are tapered, camera-facing ribbons with a minimum pixel width. With MSAA,
each strand keeps each sample with a probability equal to its coverage, so many thin overlapping strands add up to
the right opacity. With TAA the coverage pattern changes every frame, and the hair writes its own motion vectors so it
doesn't ghost.

## Limitations

- There's no hair-hair interaction (no volume or voxel pass), so strands pass through each other.
- Very long fur on concave areas of the body can clip slightly.

## Development

You need Node 24 (see `.node-version`). The toolchain is [Vite+](https://viteplus.dev), which provides the dev
server, bundler, Vitest, Oxlint and Oxfmt from a single dependency, all configured in `vite.config.ts`.

```sh
npm install
npm run dev
```

Then open the URL Vite prints. The models, environment maps and music are committed under `public/`, so nothing else
needs downloading.

### Scripts

| Script               | What it does                                              |
| -------------------- | --------------------------------------------------------- |
| `npm run dev`        | Dev server with HMR                                       |
| `npm run build`      | Production build into `dist/`                             |
| `npm run preview`    | Serve the production build                                |
| `npm run check`      | Format check, lint and type-check in one pass             |
| `npm run check:fix`  | Same, writing fixes                                       |
| `npm run test`       | Run the unit tests once                                   |
| `npm run test:watch` | Run the unit tests in watch mode                          |
| `npm run clean`      | Remove `dist/`, `node_modules/` and other generated files |

## Credits

Third-party assets keep their own licenses; the license files are next to each asset in `public/`.

- **Fox** from the [Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/Fox):
  model © 2014 PixelMannen ([CC0](https://creativecommons.org/publicdomain/zero/1.0/)), rigging and animation ©
  2014 tomkranis ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)), glTF conversion © 2017 @AsoboStudio and
  @scurest ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)).
- **Head scan** (Wayne): "Infinite, 3D Head Scan" by Lee Perry-Smith
  ([CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)), based on a work at www.triplegangers.com, via the
  three.js examples.
- **Yeti** © 2017 BabylonJS, from [BabylonJS Assets](https://github.com/BabylonJS/Assets/tree/master/meshes/Yeti)
  ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)). Changed: the sculpted beard and forearm fur are hidden
  and replaced by simulated fur, and the body material is re-shaded.
- **Environment maps** from [Poly Haven](https://polyhaven.com) (CC0), via the three.js repository.
