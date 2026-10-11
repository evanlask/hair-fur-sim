/** What a curve export holds: the simulated guide hairs, or every drawn strand. */
export type CurveExport = 'guides' | 'strands';

/** One layer's curves: `curves` polylines of `perCurve` points each (x, y, z, width), in the head's model units. */
export interface LayerCurves {
  name: string;
  points: Float32Array;
  curves: number;
  perCurve: number;
  /** Linear RGB of the hair at the root. */
  color: [number, number, number];
}

/** A valid, unique USD prim name for each layer name. */
function primNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((n) => {
    let base = n.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(?=[0-9])/, '_') || 'layer';
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
    used.add(name);
    base = name;
    return base;
  });
}

const f5 = (x: number) => (Math.abs(x) < 5e-6 ? '0' : x.toFixed(5));

/**
 * The layers as USD BasisCurves (.usda text): one linear curves prim per layer with per-point widths and the root
 * colour as its display colour. DCCs that read USD (Houdini, Maya, Blender, Omniverse) load these as hair curves.
 * `metersPerUnit` is the head's model scale, so the curves line up with the head's own mesh.
 */
export function curvesUsda(
  layers: LayerCurves[],
  what: CurveExport,
  head: string,
  metersPerUnit: number,
): string {
  const out: string[] = [
    '#usda 1.0',
    '(',
    '    defaultPrim = "Groom"',
    `    doc = "Groom Studio ${what} on the ${head} head"`,
    `    metersPerUnit = ${metersPerUnit}`,
    '    upAxis = "Y"',
    ')',
    '',
    'def Xform "Groom"',
    '{',
  ];
  const names = primNames(layers.map((l) => `${l.name}_${what}`));
  layers.forEach((l, k) => {
    const { points: P, curves, perCurve } = l;
    out.push(`    def BasisCurves "${names[k]}"`, '    {');
    out.push('        uniform token type = "linear"', '        uniform token wrap = "nonperiodic"');
    out.push(
      `        int[] curveVertexCounts = [${Array.from({ length: curves }, () => perCurve).join(', ')}]`,
    );
    const pts: string[] = [];
    const widths: string[] = [];
    for (let i = 0; i < curves * perCurve; i++) {
      pts.push(`(${f5(P[i * 4])}, ${f5(P[i * 4 + 1])}, ${f5(P[i * 4 + 2])})`);
      widths.push(P[i * 4 + 3].toPrecision(3));
    }
    out.push(`        point3f[] points = [${pts.join(', ')}]`);
    out.push(
      `        float[] widths = [${widths.join(', ')}] (`,
      '            interpolation = "vertex"',
      '        )',
    );
    const c = l.color.map((x) => x.toFixed(4)).join(', ');
    out.push(
      `        color3f[] primvars:displayColor = [(${c})] (`,
      '            interpolation = "constant"',
      '        )',
    );
    out.push('    }');
  });
  out.push('}', '');
  return out.join('\n');
}
