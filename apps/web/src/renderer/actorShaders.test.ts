import { describe, expect, it } from 'vitest';
import { livingActorFragmentShader, livingActorUniforms, livingActorVertexShader } from './actorShaders';
import { ACTOR_ALPHA_CUTOFF, PERSON_IMPOSTOR_DIAMETER_CSS_PIXELS, PERSON_IMPOSTOR_ALPHA_FALLOFF, personImpostorMix } from './actorPhysical';

describe('physical actor shader contract', () => {
  it('projects world-metre vertex offsets and interpolates all three anchor axes before projection', () => {
    expect(livingActorVertexShader).toContain('in vec3 instancePreviousPositions;');
    expect(livingActorVertexShader).toContain('mix(instancePreviousPositions, instancePositions,');
    expect(livingActorVertexShader).toContain('vec3(omnitwinLivingInterpolation.cameraRight * metres.x, -metres.y)');
    expect(livingActorVertexShader).toContain('project_size(offsetMeters)');
    expect(livingActorVertexShader).toContain('project_position_to_clipspace(anchor, low, offsetCommon, geometry.position)');
    expect(livingActorVertexShader).not.toMatch(/sizeMinPixels|sizeMaxPixels/);
  });

  it('uses a bounded perspective/DPR-aware distant-person glow that fades to the physical body', () => {
    expect(livingActorVertexShader).toContain('project.viewportSize / project.devicePixelRatio');
    expect(livingActorVertexShader).toContain('1.0 - smoothstep(3.0, 5.0, physicalHeightPixels)');
    expect(livingActorVertexShader).toContain('positions * 4.0');
    expect(livingActorFragmentShader).toContain('vImpostorMix');
    expect(livingActorFragmentShader).toContain('exp(-4.5 * radius * radius)');
  });

  it('keeps a roughly five-CSS-pixel visible core on low-DPR mobile without enlarging the near body', () => {
    expect(PERSON_IMPOSTOR_DIAMETER_CSS_PIXELS).toBe(8);
    const visibleDiameter = PERSON_IMPOSTOR_DIAMETER_CSS_PIXELS
      * Math.sqrt(Math.log((238 / 255) / ACTOR_ALPHA_CUTOFF) / PERSON_IMPOSTOR_ALPHA_FALLOFF);
    expect(visibleDiameter).toBeGreaterThan(4.9);
    expect(visibleDiameter).toBeLessThan(5.2);
    for (const dpr of [0.75, 1, 2, 3]) {
      const deviceDiameter = PERSON_IMPOSTOR_DIAMETER_CSS_PIXELS * dpr;
      expect(deviceDiameter / dpr).toBe(8);
    }
    expect(personImpostorMix(3)).toBe(1);
    expect(personImpostorMix(5)).toBe(0);
    expect(personImpostorMix(12)).toBe(0);
  });

  it('keeps native picking colors and atlas transparency in the actual fragment path', () => {
    expect(livingActorVertexShader).toContain('geometry.pickingColor = instancePickingColors');
    expect(livingActorFragmentShader).toContain('if (fragColor.a < icon.alphaCutoff) discard;');
    expect(livingActorFragmentShader).toContain('DECKGL_FILTER_COLOR(fragColor, geometry)');
  });

  it('defines a separate physical top-view footprint and selected ring without changing body scale', () => {
    expect(livingActorVertexShader).toContain('vec3(positions * vec2(0.28, 0.35), 0.1)');
    expect(livingActorVertexShader).toContain('max(0.8, instanceSizes * 0.55), 0.04');
    expect(livingActorUniforms.uniformTypes).toMatchObject({ alpha: 'f32', cameraRight: 'vec2<f32>', actorMode: 'f32' });
    expect(livingActorUniforms.fs).toBe(livingActorUniforms.vs);
  });
});
