import { describe, expect, it } from 'vitest';
import { generatePerformanceEntities } from '../lod';
import { LivingKind, LivingLod, LivingPrimaryRenderer } from './types';
import {
  createLivingPartition,
  livingConservation,
  previousLivingLodMap,
} from './partition';
import { supportedLivingActivityScheduleDescriptor } from './activitySchedule';

describe('living entity partition', () => {
  it('keeps individual profile eligibility independent of focus kind and screen-space LOD', () => {
    const ordinaryPerson = {
      ...generatePerformanceEntities({ pedestrianCount: 1, vehicleCount: 0 })[0]!,
      kind: 'person' as const,
      representation: 'focus_person_1to1' as const,
      representedCount: 1,
    };
    const partition = createLivingPartition([ordinaryPerson], {
      zoom: 16, origin: [0, 0], screenSizePixels: 1, rendererPolicy: 'deck_only',
    });
    expect(partition.identity.kind[0]).toBe(LivingKind.PERSON);
    expect(partition.presentation.lod[0]).not.toBe(LivingLod.FOCUS);
    expect(() => createLivingPartition([{ ...ordinaryPerson, kind: 'vehicle' }], {
      zoom: 16, origin: [0, 0], screenSizePixels: 1,
    })).toThrow(/profile|focus/);
  });

  it('rejects a scene origin outside WebMercator bounds', () => {
    expect(() => createLivingPartition(generatePerformanceEntities({ pedestrianCount: 1, vehicleCount: 0 }), {
      zoom: 12,
      origin: [0, 86],
      screenSizePixels: 1,
    })).toThrow(/WebMercator/);
  });

  it('stores the exact 10k + 2k fixture in typed SoA buffers with one primary renderer', () => {
    const entities = generatePerformanceEntities();
    const screenSizePixels = new Float32Array(entities.length).fill(5);
    const partition = createLivingPartition(entities, {
      zoom: 14.6,
      origin: [0, 0],
      screenSizePixels,
    });
    const conservation = livingConservation(partition);

    expect(partition.count).toBe(12_000);
    expect(partition.position.currentX).toBeInstanceOf(Float32Array);
    expect(partition.identity.idHash).toBeInstanceOf(Uint32Array);
    expect(partition.presentation.primaryRenderer).toBeInstanceOf(Uint8Array);
    expect(new Set(partition.identity.ids).size).toBe(12_000);
    expect(conservation).toEqual({
      logical: 12_000,
      deck: 0,
      three: 12_000,
      culled: 0,
      duplicatePrimary: 0,
      representedLogical: 10_000,
      representedDeck: 0,
      representedThree: 10_000,
      representedCulled: 0,
    });
    expect([...partition.presentation.primaryRenderer].every(
      (renderer) => renderer === LivingPrimaryRenderer.THREE,
    )).toBe(true);
  });

  it('applies deterministic device caps without losing conservation', () => {
    const entities = generatePerformanceEntities({ pedestrianCount: 20, vehicleCount: 8 });
    const partition = createLivingPartition(entities, {
      zoom: 18,
      origin: [0, 0],
      screenSizePixels: new Float32Array(entities.length).fill(30),
      caps: {
        maxPedestrians: 6,
        maxVehicles: 3,
        maxDetailed: 4,
        maxLow: 4,
        maxImpostors: 1,
      },
    });
    const first = livingConservation(partition);
    const second = livingConservation(createLivingPartition(entities, {
      zoom: 18,
      origin: [0, 0],
      screenSizePixels: new Float32Array(entities.length).fill(30),
      caps: {
        maxPedestrians: 6,
        maxVehicles: 3,
        maxDetailed: 4,
        maxLow: 4,
        maxImpostors: 1,
      },
    }));

    expect(first).toEqual(second);
    expect(first.logical).toBe(28);
    expect(first.deck + first.three + first.culled).toBe(first.logical);
    expect(first.duplicatePrimary).toBe(0);
    expect(first.representedDeck + first.representedThree + first.representedCulled)
      .toBe(first.representedLogical);
    expect(first.three).toBe(8);
    expect(first.deck).toBe(1);
  });

  it('bounds near people and vehicles independently before falling back to low LOD', () => {
    const entities = generatePerformanceEntities({ pedestrianCount: 10, vehicleCount: 10 });
    const partition = createLivingPartition(entities, {
      zoom: 18,
      origin: [0, 0],
      screenSizePixels: 30,
      rendererPolicy: 'deck_only',
      caps: {
        maxPedestrians: 10,
        maxVehicles: 10,
        maxDetailedPedestrians: 2,
        maxDetailedVehicles: 3,
        maxDetailed: 20,
        maxLow: 20,
        maxImpostors: 20,
      },
    });
    let detailedPeople = 0;
    let detailedVehicles = 0;
    for (let index = 0; index < partition.count; index += 1) {
      if (partition.presentation.lod[index] !== LivingLod.DETAILED) continue;
      if (partition.identity.kind[index] === LivingKind.VEHICLE) detailedVehicles += 1;
      else detailedPeople += 1;
    }
    expect({ detailedPeople, detailedVehicles }).toEqual({
      detailedPeople: 2,
      detailedVehicles: 3,
    });
    expect([...partition.presentation.lod].filter((lod) => lod === LivingLod.LOW)).toHaveLength(15);
  });

  it('promotes only the selected row above ordinary near caps', () => {
    const entities = generatePerformanceEntities({ pedestrianCount: 3, vehicleCount: 0 });
    const focusRows = entities.map((entity, index) => ({
      ...entity,
      id: `focus-${index}`,
      kind: 'focus' as const,
      representation: 'focus_person_1to1' as const,
      representedCount: 1,
    }));
    const partition = createLivingPartition(focusRows, {
      zoom: 18,
      origin: [0, 0],
      screenSizePixels: 30,
      selectedId: focusRows[2]!.id,
      rendererPolicy: 'deck_only',
      caps: {
        maxDetailedPedestrians: 1,
        maxDetailedVehicles: 0,
        maxDetailed: 1,
        maxLow: 3,
        maxImpostors: 3,
      },
    });
    expect(partition.presentation.lod[2]).toBe(LivingLod.FOCUS);
    expect([...partition.presentation.lod].filter((lod) => lod === LivingLod.FOCUS)).toHaveLength(1);
    expect([...partition.presentation.lod].filter((lod) => lod === LivingLod.DETAILED)).toHaveLength(1);
  });

  it('fails closed for duplicate IDs and invalid representation counts', () => {
    const [entity] = generatePerformanceEntities({ pedestrianCount: 1, vehicleCount: 0 });
    expect(() => createLivingPartition([entity!, entity!], {
      zoom: 18,
      origin: [0, 0],
      screenSizePixels: 8,
    })).toThrow(/duplicate/i);
    expect(() => createLivingPartition([{
      ...entity!,
      kind: 'vehicle',
      representation: 'ambient_only',
      representedCount: 1,
    }], {
      zoom: 18,
      origin: [0, 0],
      screenSizePixels: 8,
    })).toThrow(/representedCount=0/);
    expect(() => createLivingPartition([entity!], {
      zoom: 18,
      origin: [0, 0],
      screenSizePixels: 8,
      routeIdByEntityId: new Map([['unknown-logical-id', 'route']]),
    })).toThrow(/unknown logical id/);
  });

  it('normalizes complete schedule profiles and rejects missing or invalid bindings', () => {
    const entities = generatePerformanceEntities({ pedestrianCount: 2, vehicleCount: 0 });
    const descriptor = supportedLivingActivityScheduleDescriptor('Europe/Moscow');
    const partition = createLivingPartition(entities, {
      zoom: 18,
      origin: [0, 0],
      screenSizePixels: 8,
      activitySchedule: {
        descriptor,
        profileByEntityId: new Map([[entities[0]!.id, 11], [entities[1]!.id, null]]),
      },
    });
    expect([...partition.activitySchedule!.profile]).toEqual([11, 255]);
    expect(partition.activitySchedule?.descriptor).toEqual(descriptor);

    expect(() => createLivingPartition(entities, {
      zoom: 18, origin: [0, 0], screenSizePixels: 8,
      activitySchedule: {
        descriptor,
        profileByEntityId: new Map([[entities[0]!.id, 0]]),
      },
    })).toThrow(/missing logical id/);
    expect(() => createLivingPartition(entities, {
      zoom: 18, origin: [0, 0], screenSizePixels: 8,
      activitySchedule: {
        descriptor,
        profileByEntityId: new Map([[entities[0]!.id, 12], [entities[1]!.id, 0]]),
      },
    })).toThrow(/\[0, 11\]/);
  });

  it('uses an explicit antimeridian-safe scene origin', () => {
    const [entity] = generatePerformanceEntities({ pedestrianCount: 1, vehicleCount: 0 });
    const partition = createLivingPartition([{
      ...entity!,
      longitude: -179.9,
      latitude: 55,
    }], {
      zoom: 18,
      origin: [179.9, 55],
      screenSizePixels: 8,
    });
    expect(partition.position.baseX[0]).toBeGreaterThan(10_000);
    expect(partition.position.baseX[0]).toBeLessThan(20_000);
  });

  it('preserves identity and represented totals across an LOD renderer handoff', () => {
    const entities = generatePerformanceEntities({ pedestrianCount: 20, vehicleCount: 4 });
    const near = createLivingPartition(entities, {
      zoom: 18,
      origin: [0, 0],
      screenSizePixels: 5,
    });
    const far = createLivingPartition(entities, {
      zoom: 18,
      origin: [0, 0],
      screenSizePixels: 1,
      previousLodById: previousLivingLodMap(near),
    });
    expect(far.identity.ids).toEqual(near.identity.ids);
    expect([...far.identity.representation]).toEqual([...near.identity.representation]);
    expect([...far.identity.representedCount]).toEqual([...near.identity.representedCount]);
    expect(livingConservation(near).representedLogical)
      .toBe(livingConservation(far).representedLogical);
    expect(livingConservation(near).three).toBe(24);
    expect(livingConservation(far).deck).toBe(24);
  });

  it('threads the deck-only policy through budgeted LOD assignment', () => {
    const entities = generatePerformanceEntities({ pedestrianCount: 12, vehicleCount: 3 });
    const partition = createLivingPartition(entities, {
      zoom: 18,
      origin: [0, 0],
      screenSizePixels: 20,
      rendererPolicy: 'deck_only',
    });
    const conservation = livingConservation(partition);
    expect(conservation.deck).toBe(15);
    expect(conservation.three).toBe(0);
    expect(conservation.duplicatePrimary).toBe(0);
  });
});
