/** Whether a new retained presentation pose should be requested from the worker. */
export function livingFrameAdvanceDue(input: {
  paused: boolean; presentationSeconds: number; previousRequestedSeconds: number | null;
  nowMs: number; previousSubmitMs: number; updateHz: number;
}): boolean {
  // Pausing schedules only a finite redraw. Never throttle away its final pose
  // and then wait for an animation frame that will intentionally never arrive.
  if (input.paused) return input.presentationSeconds !== input.previousRequestedSeconds;
  return input.nowMs - input.previousSubmitMs >= 1_000 / input.updateHz;
}
