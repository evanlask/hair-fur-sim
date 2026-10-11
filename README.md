# Hair & Fur Simulation

Real-time hair and fur in the browser. Every strand moves and is drawn on the GPU, using
[three.js](https://threejs.org) (r186) with WebGPU.

**Live demo:** <https://evanlask.github.io/hair-fur-sim/>

You need a browser with WebGPU: Chrome, Edge, or Safari 26 or later. Other browsers show a message saying so.

## Examples

Pick one with the tabs at the top left.

| Example          | What it shows                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Hair Ball**    | Long hair on a ball, a ring, a rounded box, a capsule or a knot. Drag it to shake it, or pick a motion, add wind and change the colour. |
| **Fox**          | Furry foxes walking, running or looking around in a field of grass that moves out of their way and sways in the wind.                   |
| **Wayne**        | A 1980s mullet on a scanned head. Press **Press to party** (or **M**) for music and wind, and he bangs his head to the beat.            |
| **Yeti**         | A shaggy cartoon yeti with a beard and short fur on his face and ears. The fur moves with his body.                                     |
| **Groom Studio** | A hairstyle editor: paint hair onto a head in layers, shape it, start from a ready-made style, and save or export it.                   |

## Controls

| Input              | Action                              |
| ------------------ | ----------------------------------- |
| Drag empty space   | Turn the view                       |
| Right-drag         | Move the view                       |
| Mouse wheel        | Zoom                                |
| Drag the character | Grab and shake it (it springs back) |
| **H**              | Show or hide the help               |
| **M**              | Play or stop the music (Wayne)      |
| **T**              | Tap the tempo (Wayne)               |

The **Debug** panel on the right changes everything live; hover over a setting to see what it does.

- **Example:** the scene's own settings, such as its shape, motion or music.
- **Hair / Fur:** colour, the main sliders for how the hair looks and moves, wind, and folders with finer settings.
- **Lighting:** lighting looks from studio to sunset, brightness, and settings for each lamp.
- **Rendering:** quality, resolution, antialiasing and tone mapping.
- **View & simulation:** show or hide parts of the scene; slow motion, pause, step and reset.
- **Save / load:** keep your settings in the browser or in a file.

The meter at the bottom left shows the frame rate, how long each frame takes, and how many hairs are drawn.

### Groom Studio

The panel on the left has everything for grooming, from top to bottom: the view, styles and files, the tools, the
brush, the layers and the selected layer. A layer's finer settings are under **Advanced**. Press **H** to see every
shortcut.

| Input                      | Action                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Drag on the head           | Paint with the tool: **D** density, **L** length, **C** comb, **P** part, **R** lift, **B** bend, **W** wave, **S** smooth, **N** noise |
| **Q**                      | Navigate: look around and watch the hair move (⌘/Ctrl-drag the head to shake it)                                                        |
| ⌘/Ctrl-drag                | Do the opposite: erase, shorten, flatten, straighten                                                                                    |
| Shift-drag                 | Smooth                                                                                                                                  |
| **[** / **]** (with Shift) | Brush size (strength); each tool keeps its own                                                                                          |
| **X** / **V**              | Paint both sides at once / hide or show the hair                                                                                        |
| **1**–**4**, **F**         | Front, side, back or top view; fit the head in view                                                                                     |
| **Shift**+**A**            | Add a layer                                                                                                                             |
| Drag a layer in the list   | Move it up or down                                                                                                                      |
| ⌘Z / Ctrl+Z, ⇧⌘Z / Ctrl+Y  | Undo / redo                                                                                                                             |

Your groom saves in the browser as you work. **Export** and **Import** move it to another browser or keep a copy.

## How it works

A few thousand **guide hairs** are simulated: gravity, wind, a stiffness that holds the style, and collisions with the
body. Hundreds of thousands of **drawn hairs** follow the guides around them, so the hair looks full without
simulating every strand.

Every frame, the GPU:

1. moves the body, and the hair roots with it,
2. simulates the guide hairs,
3. places the drawn hairs around them,
4. lights them and adds shadows, and
5. draws each one as a thin ribbon.

A hairstyle is described over the skin: where hair grows, how long it is, which way it's combed, and how much it
lifts, bends and waves. The hair grows from that, and the Groom Studio lets you paint it.

If you want to read the code: the hair growing is in `src/hair/groom/`, the physics in `src/hair/sim/`, the lighting
and drawing in `src/hair/render/`, and the studio in `src/examples/studio/`.

## Limitations

- Hairs don't collide with each other, so they can pass through one another.
- Very long fur can poke slightly into the body in tight spots.

## Development

You need Node 24 (see `.node-version`). The project uses [Vite+](https://viteplus.dev), one tool for the dev
server, the build, tests, linting and formatting (set up in `vite.config.ts`).

```sh
npm install
npm run dev
```

Then open the address it prints. Everything the examples load is already in `public/`, so there's nothing else to
download.

### Scripts

| Script               | What it does                                              |
| -------------------- | --------------------------------------------------------- |
| `npm run dev`        | Start the dev server (reloads as you edit)                |
| `npm run build`      | Build the site into `dist/`                               |
| `npm run preview`    | Serve the built site                                      |
| `npm run check`      | Check formatting, lint and types                          |
| `npm run check:fix`  | The same, fixing what it can                              |
| `npm run test`       | Run the tests                                             |
| `npm run test:watch` | Run the tests again on every change                       |
| `npm run clean`      | Delete `dist/`, `node_modules/` and other generated files |

## Credits

The models and maps belong to their authors and keep their own licenses (each license file sits next to its asset in
`public/`).

- **Fox** from the [Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/Fox):
  model © 2014 PixelMannen ([CC0](https://creativecommons.org/publicdomain/zero/1.0/)), rigging and animation ©
  2014 tomkranis ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)), glTF conversion © 2017 @AsoboStudio and
  @scurest ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)).
- **Head scan** (Wayne and the Groom Studio): "Infinite, 3D Head Scan" by Lee Perry-Smith
  ([CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)), based on a work at www.triplegangers.com. The mesh
  comes via the three.js examples, and its 4K colour and normal maps via Morgan McGuire's Computer Graphics Archive
  (mirrored in NVIDIA's FaceWorks samples).
- **Yeti** © 2017 BabylonJS, from [BabylonJS Assets](https://github.com/BabylonJS/Assets/tree/master/meshes/Yeti)
  ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)). Changed: the sculpted beard and forearm fur are hidden
  and replaced by simulated fur, and the body material is re-shaded.
- **Environment maps** from [Poly Haven](https://polyhaven.com) (CC0), via the three.js repository.
