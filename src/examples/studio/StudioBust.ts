import { attribute, float, mix, texture, uniform, uv } from 'three/tsl';
import * as THREE from 'three/webgpu';

import { ColliderSet } from '../../hair/colliders';
import type { GrowthMesh } from '../../hair/groom/types';
import { rigidGrowth } from '../../hair/growth';
import { ColliderDebug } from '../../hair/render/ColliderDebug';
import { OPAQUE_SHADOW_LAYER } from '../../hair/render/HairShadowPass';
import { bakeMeshSdf } from '../../hair/sdf';
import type { DeformSource } from '../../hair/sim/deform';
import { weldedNormals } from '../../util/weld';
import { SkinMaterial, skinThickness } from '../SkinMaterial';
import type { HeadAssets, HeadModel } from './heads';
import { bareMap } from './headSpace';
import { buildPaintMesh, subdivideMidpoint, type PaintMesh } from './paintMesh';

/** Brush-sized cell of the paint-vertex hash (m). */
const PAINT_CELL = 0.02;

/**
 * A head as a rigid bust to paint and grow hair on. The skin mesh (split once where the scalp is coarse) is both
 * what's drawn and the hair's growth mesh, so its vertices carry the painting overlay and the tint under the hair.
 * Colliders: capsules for the head, a baked SDF for the shoulders.
 */
export class StudioBust {
  readonly head: HeadModel;
  /** At the bust's base. */
  readonly root = new THREE.Group();
  /** What motions and grabbing move. */
  readonly pivot = new THREE.Group();
  /** Model units → meters, placed so the bust's base is at the root. */
  readonly model = new THREE.Group();
  readonly mesh: THREE.Mesh;
  /** The unsplit skin, for picking (fewer triangles, same surface). */
  readonly pickMesh: THREE.Mesh;
  readonly material: SkinMaterial;
  readonly colliders = new ColliderSet();
  readonly colliderDebug: ColliderDebug;
  readonly paint: PaintMesh;
  /** Per paint vertex, 0..1: where hair never grows whatever is painted (the head's bare places: eyes, lips). */
  readonly bare: Float32Array | null;
  readonly growth: GrowthMesh;
  readonly source: DeformSource;
  /** Per render vertex: painting overlay colour (rgb) and opacity (a). */
  readonly overlay: THREE.BufferAttribute;
  /** Per render vertex: skin tint under the hair (rgb) and how much (a). */
  readonly scalpTint: THREE.BufferAttribute;
  readonly overlayOpacity = uniform(1);
  /** 0 while the hair is hidden: the skin then shows nothing of it (no tint, no shading under it). */
  readonly hairShown = uniform(1);
  /** Rotation from model space to world space in the home pose. */
  readonly modelToWorld = new THREE.Quaternion();

  /** `height`: of the bust's base above the floor (m). */
  constructor(head: HeadModel, assets: HeadAssets, height: number) {
    this.head = head;
    this.root.name = `bust:${head.id}`;
    this.root.position.y = height;
    this.root.add(this.pivot);
    this.pivot.add(this.model);
    this.model.scale.setScalar(head.scale);
    this.model.position.copy(head.offset).multiplyScalar(head.scale);

    const base = assets.geometry;
    const { geometry, paint } = skinSurface(head, base);
    const n = geometry.getAttribute('position').count;
    this.overlay = new THREE.BufferAttribute(new Uint8Array(n * 4), 4, true);
    this.scalpTint = new THREE.BufferAttribute(new Uint8Array(n * 4), 4, true);
    geometry.setAttribute('overlay', this.overlay);
    geometry.setAttribute('scalpTint', this.scalpTint);
    // How thick the skin is (m), for light shining through the ears.
    geometry.setAttribute(
      'thickness',
      new THREE.BufferAttribute(skinThickness(geometry, head.scale, head.frame.ears), 1),
    );
    this.paint = paint;
    this.bare = bareMap(head.frame, paint);

    this.material = this.createMaterial(assets);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = `skin:${head.id}`;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.layers.enable(OPAQUE_SHADOW_LAYER);
    this.model.add(this.mesh);
    this.pickMesh = new THREE.Mesh(base, new THREE.MeshBasicNodeMaterial());
    this.pickMesh.visible = false;
    this.model.add(this.pickMesh);

    this.root.updateMatrixWorld(true);
    this.model.getWorldQuaternion(this.modelToWorld);
    ({ source: this.source, growth: this.growth } = rigidGrowth(geometry, this.mesh));
    this.buildColliders(base);
    this.colliderDebug = new ColliderDebug(this.colliders);
  }

  private createMaterial(assets: HeadAssets): SkinMaterial {
    const s = assets.skin;
    const m = new SkinMaterial(
      {
        attribute: 'thickness',
        cranium: { c: this.head.frame.center, r: this.head.frame.radii },
        strength: 2,
      },
      {
        normalMap: s.normalMap,
        normalScale: new THREE.Vector2(s.normalScale, s.normalScale),
        roughness: s.roughness,
        envMapIntensity: s.envMapIntensity,
      },
    );
    const skin = texture(s.map, uv()).rgb;
    const tint = attribute('scalpTint', 'vec4');
    const over = attribute('overlay', 'vec4');
    // How much hair covers the skin. Clamped: MSAA can shade edge pixels slightly past the vertex values, and the
    // sqrt below would give NaN for < 0.
    const cover = tint.a.saturate().mul(this.hairShown);
    // Under the hair the skin takes a darkened root colour, so gaps between strands read as hair (as on Wayne).
    const haired = mix(skin, tint.rgb.mul(0.8), cover.mul(0.7));
    const shown = over.a.mul(this.overlayOpacity);
    m.colorNode = mix(haired, over.rgb, shown);
    // A little glow keeps the overlay readable in shadow.
    m.emissiveNode = over.rgb.mul(shown).mul(0.2);
    // The scan's specular map: oily forehead, nose and lips shine, the beard's stubble doesn't (and is rougher). Less
    // under the hair (dark tinted skin would mirror the rim light).
    const shine = texture(s.specMap, uv()).r;
    m.specularIntensityNode = mix(shine.mul(s.specularIntensity), float(0.08), cover);
    m.roughnessNode = shine.mul(-0.2).add(s.roughness + 0.1);
    // Both faces into the shadow map: back faces only lets the key light through the head onto the far ear.
    m.shadowSide = THREE.DoubleSide;
    // The hair shades the skin under it from the surroundings (the studio map's coloured light would tint it), even
    // short hair that shows the skin through.
    m.aoNode = float(1).sub(cover.sqrt().mul(0.85));
    return m;
  }

  private buildColliders(base: THREE.BufferGeometry): void {
    const h = this.head;
    for (const c of h.capsules) {
      this.colliders.add({
        name: c.name,
        a: new THREE.Vector3(...c.a),
        b: new THREE.Vector3(...c.b),
        radius: c.r * h.scale,
        attach: this.model,
      });
    }
    // Shoulders, back and chest: a narrow-band SDF baked from the unsplit skin (rigid, unlike Wayne's).
    const pos = base.getAttribute('position');
    const positions = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) positions.set([pos.getX(i), pos.getY(i), pos.getZ(i)], i * 3);
    const normals = weldedNormals(positions, base.index!.array);
    const { min, max, cell, band } = h.torso;
    this.colliders.setSdf(
      bakeMeshSdf(positions, normals, base.index!.array, min, max, cell, band),
      this.model,
    );
  }

  /** Runs `fn` with the bust in its home pose: grooming reads the colliders' and the bust's current transforms. */
  withHomePose<T>(fn: () => T): T {
    const p = this.pivot.position.clone();
    const q = this.pivot.quaternion.clone();
    this.pivot.position.set(0, 0, 0);
    this.pivot.quaternion.identity();
    this.root.updateMatrixWorld(true);
    try {
      return fn();
    } finally {
      this.pivot.position.copy(p);
      this.pivot.quaternion.copy(q);
      this.root.updateMatrixWorld(true);
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    this.colliderDebug.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
    (this.pickMesh.material as THREE.Material).dispose();
  }
}

/**
 * The head's skin as the studio paints on it: split once (the scan's scalp is coarse), with normals welded across UV
 * seams (no seams in shading or in the hair's growth directions), and its paint vertices.
 */
function skinSurface(
  head: HeadModel,
  base: THREE.BufferGeometry,
): { geometry: THREE.BufferGeometry; paint: PaintMesh } {
  if (!base.index) throw new Error(`${head.id}: the skin geometry must be indexed`);
  const geometry = subdivideMidpoint(base);
  const pos = geometry.getAttribute('position');
  const positions = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) positions.set([pos.getX(i), pos.getY(i), pos.getZ(i)], i * 3);
  geometry.setAttribute(
    'normal',
    new THREE.BufferAttribute(weldedNormals(positions, geometry.index!.array), 3),
  );
  return { geometry, paint: buildPaintMesh(geometry, head.frame.midlineX, PAINT_CELL / head.scale) };
}
