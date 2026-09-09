import { GameMotionWorkerCore } from './GameMotionWorkerCore';
import { gameMotionTransferables, type GameMotionResponse } from './gameMotionProtocol';

// This entry owns no timer, renderer or independent clock. Native Worker event
// dispatch preserves configure/sample FIFO order; the Scene bounds its queue.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: (message: GameMotionResponse, transfer: ArrayBuffer[]) => void;
};
const core = new GameMotionWorkerCore({ includeFullProbe: import.meta.env.DEV });
scope.onmessage = event => {
  const response = core.handle(event.data);
  scope.postMessage(response, gameMotionTransferables(response));
};
