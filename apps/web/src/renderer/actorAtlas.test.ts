import { describe, expect, it } from 'vitest';
import {
  UNIVERSAL_ACTOR_ATLAS_HEIGHT,
  UNIVERSAL_ACTOR_ATLAS_URL,
  UNIVERSAL_ACTOR_ATLAS_WIDTH,
  UNIVERSAL_ACTOR_ICON_MAPPING,
  universalActorGaitFrame,
  universalActorSpriteKey,
  writeUniversalActorIconDefinition,
} from './actorAtlas';

describe('universal actor atlas', () => {
  it('is one power-of-two atlas with complete person and vehicle mappings', () => {
    expect(UNIVERSAL_ACTOR_ATLAS_URL).toBe(
      '/assets/universal-materials/omnitwin-actor-atlas-v1.svg',
    );
    expect(UNIVERSAL_ACTOR_ATLAS_WIDTH).toBe(256);
    expect(UNIVERSAL_ACTOR_ATLAS_HEIGHT).toBe(128);
    expect(Object.keys(UNIVERSAL_ACTOR_ICON_MAPPING)).toHaveLength(16);
    for (const entry of Object.values(UNIVERSAL_ACTOR_ICON_MAPPING)) {
      expect(entry.mask).toBe(false);
      expect(entry.x + entry.width).toBeLessThanOrEqual(UNIVERSAL_ACTOR_ATLAS_WIDTH);
      expect(entry.y + entry.height).toBeLessThanOrEqual(UNIVERSAL_ACTOR_ATLAS_HEIGHT);
    }
  });

  it('assigns stable appearance variants while changing only the gait frame', () => {
    const first = universalActorSpriteKey('agt_123', 'person', 0);
    const second = universalActorSpriteKey('agt_123', 'person', 1);
    expect(first).toMatch(/^person-[0-3]-walk-0$/);
    expect(second).toBe(first.replace('-walk-0', '-walk-1'));
    expect(universalActorSpriteKey('veh_123', 'vehicle', 0)).toMatch(/^vehicle-[0-7]$/);
    expect(universalActorSpriteKey('veh_123', 'vehicle', 1))
      .toBe(universalActorSpriteKey('veh_123', 'vehicle', 0));
  });

  it('writes allocation-free binary icon definitions with bottom-anchored people', () => {
    const target = new Float32Array(21);
    writeUniversalActorIconDefinition(target, 1, 'agt_123', 'person', 0);
    const definition = [...target.subarray(7, 14)];
    expect(definition[0]).toBe(0);
    expect(definition[1]).toBe(-23.5);
    expect(definition[3]).toBe(9);
    expect(definition[4]).toBe(32);
    expect(definition[5]).toBe(47);
    expect(definition[6]).toBe(0);
    const buffer = target.buffer;
    writeUniversalActorIconDefinition(target, 1, 'agt_123', 'person', 1);
    expect(target.buffer).toBe(buffer);
  });

  it('derives a deterministic two-frame walking phase from world position', () => {
    const phase = universalActorGaitFrame('agt_123', 10, -4);
    expect(phase === 0 || phase === 1).toBe(true);
    expect(universalActorGaitFrame('agt_123', 10, -4)).toBe(phase);
  });
});
