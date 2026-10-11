import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * A glTF loader for public/models: the models there are meshopt-compressed (EXT_meshopt_compression, packed losslessly,
 * keeping every vertex and triangle in order) and their textures are lossless WebP (EXT_texture_webp).
 */
export function gltfLoader(): GLTFLoader {
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
}
