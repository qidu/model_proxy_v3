#!/usr/bin/env node --import=tsx
/**
 * Stub Clef upstream for manual /decision e2e verification.
 * Serves the Clef contract on a configurable port.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';

const PORT = parseInt(process.env.STUB_PORT || '9999', 10);

interface ClefRequest {
  model: string;
  state: unknown;
  questions: Record<string, unknown>;
  images?: unknown[];
}

interface ClefResponse {
  model: string;
  answers: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number };
}

const receivedRequests: Array<{ timestamp: string; body: ClefRequest; headers: Record<string, string | undefined> }> = [];

function logRequest(body: ClefRequest, headers: Record<string, string | undefined>) {
  receivedRequests.push({ timestamp: new Date().toISOString(), body, headers });
}

function makeResponse(body: ClefRequest): ClefResponse {
  const answers: Record<string, unknown> = {};
  for (const [qid, q] of Object.entries(body.questions)) {
    const qType = (q as Record<string, unknown>).type;
    if (qType === 'noul') {
      answers[qid] = { type: 'noul', noul: 0.73 };
    } else if (qType === 'choice') {
      const criteria = ((q as any).criteria || {}) as Record<string, string>;
      const options = Object.keys(criteria);
      const probs: Record<string, number> = {};
      if (options.length === 1) {
        probs[options[0]] = 1;
      } else {
        const rest = 0.2 / (options.length - 1);
        options.forEach((opt, i) => { probs[opt] = i === 0 ? 0.8 : rest; });
      }
      answers[qid] = { type: 'choice', choice: options[0], probabilities: probs, confidence: 0.8 };
    } else if (qType === 'score') {
      const legend = (q as any).legend || { '0': 'low', '1': 'high' };
      answers[qid] = { type: 'score', score: 0.7, legend, probabilities: { '0': 0.3, '1': 0.7 }, confidence: 0.7 };
    } else {
      answers[qid] = { type: 'noul', noul: 0.5 };
    }
  }
  return {
    model: body.model,
    answers,
    usage: { input_tokens: 123, output_tokens: 0 },
  };
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  // Inspection endpoints for the verify script. Served over HTTP instead of a
  // log file because "/tmp" resolves to different directories for Windows Node
  // and git-bash, so a file shared between them silently reads as empty.
  if (req.method === 'GET' && url.pathname === '/__count') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(String(receivedRequests.length));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/__requests') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(receivedRequests));
    return;
  }

  if (url.pathname !== '/decision' || req.method !== 'POST') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  let body = '';
  for await (const chunk of req) body += chunk;

  let parsed: ClefRequest;
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid json' }));
    return;
  }

  logRequest(parsed, {
    'content-type': req.headers['content-type'],
    'authorization': req.headers['authorization'],
  });

  const response = makeResponse(parsed);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[stub] Clef upstream listening on http://127.0.0.1:${PORT}/decision`);
  console.error(`[stub] inspect recorded traffic at http://127.0.0.1:${PORT}/__requests`);
});

// Print received requests on SIGINT for inspection
process.on('SIGINT', () => {
  console.error('\n[stub] Received requests:');
  for (const r of receivedRequests) {
    console.error(`  ${r.timestamp} model=${r.body.model} questions=${Object.keys(r.body.questions).join(',')} images=${Array.isArray(r.body.images) ? r.body.images.length : 0} auth=${r.headers.authorization ? 'yes' : 'no'}`);
  }
  server.close(() => process.exit(0));
});