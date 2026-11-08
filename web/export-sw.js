/* Service Worker for streaming jaMME fMP4 video exports directly to browser Downloads */
'use strict';

const STREAM_TTL_MS = 90 * 1000;
const MAX_UNCLAIMED_BUFFER_BYTES = 24 * 1024 * 1024;
const activeStreams = new Map();

function pruneStaleStreams() {
  const now = Date.now();
  for (const [jobId, entry] of activeStreams.entries()) {
    if (!entry.claimed && now - entry.createdAt > STREAM_TTL_MS) {
      entry.queue.length = 0;
      entry.queuedBytes = 0;
      try {
        if (entry.port) entry.port.close();
      } catch (_) {}
      activeStreams.delete(jobId);
    }
  }
}

function sanitizeAsciiFilename(rawName) {
  const base = String(rawName || 'jka-clip.mp4')
    .replace(/[\r\n"\\/:*?<>|]+/g, '_')
    .replace(/[^\x20-\x7E]+/g, '_')
    .trim();
  if (!base) return 'jka-clip.mp4';
  return /\.mp4$/i.test(base) ? base : base + '.mp4';
}

function flushEntryToController(entry) {
  const ctrl = entry.controller;
  if (!ctrl) return;
  let flushedBytes = 0;
  while (entry.queue.length > 0) {
    if (typeof ctrl.desiredSize === 'number' && ctrl.desiredSize <= 0) {
      break;
    }
    const chunk = entry.queue.shift();
    if (chunk && chunk.byteLength > 0) {
      entry.queuedBytes = Math.max(0, entry.queuedBytes - chunk.byteLength);
      flushedBytes += chunk.byteLength;
      try {
        ctrl.enqueue(chunk);
      } catch (_) {
        entry.queue.length = 0;
        entry.queuedBytes = 0;
        break;
      }
    }
  }
  if (flushedBytes > 0 && entry.port) {
    try {
      entry.port.postMessage({ type: 'STREAM_ACK', ackBytes: flushedBytes, queuedBytes: entry.queuedBytes });
    } catch (_) {}
  }
  if (entry.queue.length === 0) {
    if (entry.aborted) {
      activeStreams.delete(entry.jobId);
      try {
        entry.port.close();
      } catch (_) {}
      try {
        ctrl.error(new Error(entry.abortReason || 'Export cancelled'));
      } catch (_) {}
    } else if (entry.closed) {
      activeStreams.delete(entry.jobId);
      try {
        entry.port.postMessage({ type: 'STREAM_EOF_FLUSHED', jobId: entry.jobId });
        entry.port.close();
      } catch (_) {}
      try {
        ctrl.close();
      } catch (_) {}
    }
  }
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'PING') {
    if (event.source && typeof event.source.postMessage === 'function') {
      event.source.postMessage({ type: 'PONG', requestId: data.requestId || '' });
    }
    return;
  }

  if (data.type === 'REGISTER_STREAM') {
    pruneStaleStreams();
    const jobId = String(data.jobId || '');
    const port = event.ports && event.ports[0];
    const ackPort = event.ports && event.ports[1];
    if (!jobId || !port) return;

    const entry = {
      jobId,
      filename: String(data.filename || 'jka-clip.mp4'),
      port,
      queue: [],
      queuedBytes: 0,
      controller: null,
      claimed: false,
      closed: false,
      aborted: false,
      abortReason: '',
      createdAt: Date.now(),
    };

    const enqueueBytes = (bytes) => {
      if (!bytes || bytes.byteLength === 0 || entry.closed || entry.aborted) return;
      if (!entry.claimed && entry.queuedBytes + bytes.byteLength > MAX_UNCLAIMED_BUFFER_BYTES) {
        entry.aborted = true;
        entry.abortReason = 'Download stream was not claimed in time';
        entry.queue.length = 0;
        entry.queuedBytes = 0;
        try {
          port.postMessage({ type: 'STREAM_CANCELLED', jobId });
        } catch (_) {}
        return;
      }
      entry.queue.push(bytes);
      entry.queuedBytes += bytes.byteLength;
      flushEntryToController(entry);
    };

    port.onmessage = (msgEv) => {
      const msg = msgEv.data;
      if (!msg) return;

      if (msg instanceof Uint8Array || msg instanceof ArrayBuffer) {
        const bytes = msg instanceof Uint8Array ? msg : new Uint8Array(msg);
        enqueueBytes(bytes);
        return;
      }

      if (typeof msg === 'object') {
        if (msg.chunk) {
          const raw = msg.chunk;
          const bytes =
            raw instanceof Uint8Array
              ? raw
              : new Uint8Array(raw.buffer || raw, raw.byteOffset || 0, raw.byteLength || 0);
          enqueueBytes(bytes);
        }
        if (msg.eof) {
          entry.closed = true;
          flushEntryToController(entry);
        } else if (msg.abort) {
          entry.aborted = true;
          entry.abortReason = String(msg.reason || 'Export cancelled');
          entry.queue.length = 0;
          entry.queuedBytes = 0;
          flushEntryToController(entry);
        }
      }
    };

    if (typeof port.start === 'function') {
      port.start();
    }

    activeStreams.set(jobId, entry);

    const regAck = {
      type: 'STREAM_REGISTERED',
      jobId,
      requestId: data.requestId || '',
    };
    if (ackPort) {
      try {
        ackPort.postMessage(regAck);
        ackPort.close();
      } catch (_) {}
    }
    if (event.source && typeof event.source.postMessage === 'function') {
      event.source.postMessage(regAck);
    }
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!req || req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return;
  }

  const match = url.pathname.match(/\/export-stream\/([^/?#]+)(?:\/([^?#]*))?$/);
  if (!match) return;

  const jobId = decodeURIComponent(match[1] || '');
  const entry = activeStreams.get(jobId);
  if (!entry) {
    event.respondWith(
      new Response('Export stream not found or expired.', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    );
    return;
  }

  entry.claimed = true;
  const rawFilename =
    (match[2] ? decodeURIComponent(match[2]) : '') || entry.filename || 'jka-clip.mp4';
  const asciiFilename = sanitizeAsciiFilename(rawFilename);
  const encodedStar = encodeURIComponent(
    /\.mp4$/i.test(rawFilename) ? rawFilename : rawFilename + '.mp4'
  );

  const stream = new ReadableStream(
    {
      start(controller) {
        entry.controller = controller;
        flushEntryToController(entry);
      },
      pull() {
        flushEntryToController(entry);
      },
      cancel() {
        entry.queue.length = 0;
        entry.queuedBytes = 0;
        activeStreams.delete(jobId);
        try {
          entry.port.postMessage({ type: 'STREAM_CANCELLED', jobId });
          entry.port.close();
        } catch (_) {}
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 2 * 1024 * 1024 })
  );

  event.respondWith(
    new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Disposition':
          'attachment; filename="' + asciiFilename + "\"; filename*=UTF-8''" + encodedStar,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  );
});
