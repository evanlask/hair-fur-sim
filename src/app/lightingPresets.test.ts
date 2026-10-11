import { describe, expect, it } from 'vite-plus/test';

import { LIGHTING_PRESETS } from './lightingPresets';

// Lazy glob: only lists the files, nothing is loaded. They're gzipped (App.loadEnvironment unpacks them).
const envFiles = Object.keys(import.meta.glob('../../public/env/*.hdr.gz')).map((p) => p.split('/').pop());

describe('lighting presets', () => {
  it('use environment maps that exist in public/env', () => {
    for (const preset of Object.values(LIGHTING_PRESETS)) expect(envFiles).toContain(`${preset.env}.gz`);
  });
});
