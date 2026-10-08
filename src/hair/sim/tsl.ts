import * as TSLModule from 'three/tsl';

/**
 * Loosely typed view of TSL for kernel / shader code. TSL's generic node typings are too strict
 * for heavy kernel code (mixed scalar/vector math, uint/float conversions), so shader modules
 * destructure their functions from this object instead of importing 'three/tsl' directly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const tsl: any = TSLModule;
