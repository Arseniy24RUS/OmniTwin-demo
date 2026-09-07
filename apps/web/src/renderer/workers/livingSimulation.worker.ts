/// <reference lib="webworker" />

import {
  createLivingPersistentWorkerProcessor,
  livingWorkerFrameTransferables,
  type LivingPersistentWorkerRequest,
} from './livingWorkerProtocol';

const workerScope = self as DedicatedWorkerGlobalScope;
const processor = createLivingPersistentWorkerProcessor();

workerScope.onmessage = (event: MessageEvent<LivingPersistentWorkerRequest>) => {
  const response = processor.process(event.data);
  workerScope.postMessage(response, livingWorkerFrameTransferables(response));
};
