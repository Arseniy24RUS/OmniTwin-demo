import { expect, it } from 'vitest';
import { livingFrameAdvanceDue } from '../renderer/runtime/livingFrameCadence';

it('flushes the final pause pose even inside the previous animation cadence window', () => {
  const previous = { presentationSeconds: 100.328, previousRequestedSeconds: 100, nowMs: 1_028, previousSubmitMs: 1_000, updateHz: 2 };
  expect(livingFrameAdvanceDue({ ...previous, paused: false })).toBe(false);
  expect(livingFrameAdvanceDue({ ...previous, paused: true })).toBe(true);
  expect(livingFrameAdvanceDue({ ...previous, paused: true, previousRequestedSeconds: 100.328 })).toBe(false);
});
