/**
 * Worker thread that runs the Live agent relay (./relay/relay.ts): it watches
 * Claude Code session transcripts and agent-flow hook events off the main
 * thread and posts what each subscribed agent window should show.
 * Started and stopped by LiveAgentRelay (./live-agent-relay.ts).
 */
import { parentPort, workerData } from 'worker_threads';
import { createRelay, type Relay } from './relay/relay';
import { setLogSink } from './relay/lib/logger';
import type { RelayWorkerData, RelayWorkerRequest, RelayWorkerMessage } from './relay-worker-protocol';

const port = parentPort;
if (port) {
  const post = (message: RelayWorkerMessage) => port.postMessage(message);
  setLogSink((level, message) => post({ type: 'log', level, message }));

  let relay: Relay | null = null;
  let stopping = false;
  // Requests that arrive while the relay is starting
  const queued: RelayWorkerRequest[] = [];

  const handle = (request: RelayWorkerRequest) => {
    if (!relay) return;
    switch (request.type) {
      case 'subscribe':
        relay.addClaudeDirs(request.claudeDirs);
        relay.addCodexHomes(request.codexHomes);
        relay.subscribe(request.clientId, request.cwd, request.flowDir);
        break;
      case 'unsubscribe':
        relay.unsubscribe(request.clientId);
        break;
    }
  };

  port.on('message', (request: RelayWorkerRequest) => {
    switch (request.type) {
      case 'start':
        if (relay || stopping) return;
        createRelay({
          claudeDirs: request.claudeDirs,
          codexHomes: request.codexHomes,
          send: (clientIds, data) => post({ type: 'message', clientIds, data }),
          wsl: (workerData as RelayWorkerData | undefined)?.wsl ?? null,
        }).then((created) => {
          if (stopping) {
            created.dispose();
            return;
          }
          relay = created;
          for (const next of queued.splice(0)) handle(next);
          post({ type: 'ready' });
        }, (error: unknown) => {
          post({ type: 'error', error: error instanceof Error ? error.message : String(error) });
        });
        break;
      case 'stop':
        stopping = true;
        relay?.dispose();
        relay = null;
        post({ type: 'stopped' });
        break;
      default:
        if (relay) handle(request);
        else queued.push(request);
    }
  });
}
