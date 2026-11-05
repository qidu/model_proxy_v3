/**
 * Unit tests for the §5.8 `auth_with_body` external-link projection
 * (src/utils/auth-projection.ts).
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.8, §10
 * ("`auth_with_body` link projection": "for every §5.4 binary predicate, assert
 * the auth body contains a valid `external_blob` link with matching hash/size/
 * media type and no inline base64, while its text/tools reflect the final
 * sidecar mutations … assert the upstream still receives the original inline
 * binary bytes").
 *
 * The bodies are built with small payloads rather than the §5.6 spill threshold:
 * the position matrix and the projection are what is under test here, and
 * `blob-refs.test.ts` is where the threshold-sized round trip lives. Every
 * position still goes through the real `extractInlineBlobs`, so each link is
 * built from a genuine ref over a real L2 blob, never a hand-made one.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BlobStoreError, resetBlobStore } from '../../src/utils/blob-store.js';
import {
  collectBlobRefs,
  extractInlineBlobs,
  isBlobRef,
  rehydrateInlineBlobs,
  releaseInlineBlobs,
  type BlobRef,
  type BlobRefKind,
} from '../../src/utils/blob-refs.js';
import { AuthProjectionError, buildAuthProjection, type BlobLinkRef } from '../../src/utils/auth-projection.js';
import { resolveSpoolConfig, setSpoolConfig } from '../../src/utils/spool.js';

const scratchDirs: string[] = [];

/** A fresh temp directory that the test cleanup removes afterwards. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auth-projection-test-'));
  scratchDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of scratchDirs) {
    try {
      chmodSync(dir, 0o700);
    } catch { /* already writable or already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  resetBlobStore();
});

/** A live enabled spool rooted in a fresh scratch directory. */
function useConfig(): void {
  setSpoolConfig(resolveSpoolConfig({ enabled: true, dir: scratch() }));
  resetBlobStore();
}

/** A distinct, valid base64 payload of exactly `chars` bytes. */
function payload(seed: string, chars = 48): string {
  const text = Buffer.alloc((chars / 4) * 3, seed.charCodeAt(0)).toString('base64');
  assert.equal(text.length, chars, 'payload helper must produce the requested byte count');
  return text;
}

/** Read a path out of a parsed body, so an assertion names the exact position. */
function at(root: unknown, ...path: (string | number)[]): unknown {
  let node = root as Record<string | number, unknown>;
  for (const key of path) node = node[key] as Record<string | number, unknown>;
  return node;
}

/** The ref at `path`, asserting the position really holds one. */
function refAt(body: unknown, ...path: (string | number)[]): BlobRef {
  const value = at(body, ...path);
  assert.ok(isBlobRef(value), `expected a ref at ${path.join('.')}, got ${JSON.stringify(value)}`);
  return value;
}

/** The link at `path`, asserting the position really holds one. */
function linkAt(body: unknown, ...path: (string | number)[]): BlobLinkRef {
  const value = at(body, ...path) as BlobLinkRef;
  assert.equal(value?.type, 'external_blob', `expected a link at ${path.join('.')}, got ${JSON.stringify(value)}`);
  return value;
}

/** The signed download URL a test's upload map holds for one blob. */
function signedUrl(hash: string): string {
  return `https://objects.example.test/blobs/${hash}.b64?exp=1700000000&sig=${hash.slice(0, 8)}`;
}

/** A link map for every payload a body holds, as the §5.8 uploader would build. */
function linksOf(body: unknown): Map<string, string> {
  return new Map(collectBlobRefs(body).map((ref) => [ref.hash, signedUrl(ref.hash)]));
}

const SMALL = 48;
const FORGED_HASH = 'f'.repeat(64);

/**
 * One request body holding every §5.4 predicate position, with a distinct
 * payload at each — the same shape `blob-refs.test.ts` uses.
 */
function matrixBody(): Record<string, unknown> {
  const bytes = (seed: string): string => payload(seed, SMALL);
  return {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes('a') } },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes('b') } },
          { type: 'text', text: 'describe these' },
        ],
      },
    ],
    chat: [
      { type: 'image_url', image_url: { url: `data:image/png;base64,${bytes('c')}` } },
      { type: 'input_audio', input_audio: { data: bytes('d'), format: 'wav' } },
      { type: 'file', file: { filename: 'report.pdf', file_data: bytes('e') } },
      { type: 'file', file: { filename: 'url.pdf', file_data: `data:application/pdf;base64,${bytes('f')}` } },
    ],
    gemini: [
      { inline_data: { mime_type: 'video/mp4', data: bytes('g') } },
      { inlineData: { mimeType: 'audio/mp3', data: bytes('h') } },
    ],
    responses: [
      { type: 'input_image', image_url: `data:image/jpeg;base64,${bytes('i')}` },
      { type: 'input_image', image_url: { url: `data:image/jpeg;base64,${bytes('j')}` } },
      { type: 'input_file', file_data: bytes('k') },
      { type: 'inline', source: { type: 'base64', media_type: 'application/zip', data: bytes('l') } },
    ],
  };
}

/**
 * Every allowlisted position in {@link matrixBody}: where its payload field is,
 * which predicate found it, and the media type its link must state.
 *
 * `null` is the honest answer where the schema states no media type: Chat
 * `input_audio` carries a `format` and a bare `data`, and neither Chat
 * `file_data` nor Responses `file_data` bare form carries one.
 */
const POSITIONS: Array<{
  path: (string | number)[];
  kind: BlobRefKind;
  mediaType: string | null;
}> = [
  { path: ['messages', 0, 'content', 0, 'source', 'data'], kind: 'claude-source-data', mediaType: 'image/png' },
  { path: ['messages', 0, 'content', 1, 'source', 'data'], kind: 'claude-source-data', mediaType: 'application/pdf' },
  { path: ['chat', 0, 'image_url', 'url'], kind: 'chat-image-url', mediaType: 'image/png' },
  { path: ['chat', 1, 'input_audio', 'data'], kind: 'chat-input-audio', mediaType: null },
  { path: ['chat', 2, 'file', 'file_data'], kind: 'chat-file-data', mediaType: null },
  { path: ['chat', 3, 'file', 'file_data'], kind: 'chat-file-data', mediaType: 'application/pdf' },
  { path: ['gemini', 0, 'inline_data', 'data'], kind: 'gemini-inline-data', mediaType: 'video/mp4' },
  { path: ['gemini', 1, 'inlineData', 'data'], kind: 'gemini-inline-data', mediaType: 'audio/mp3' },
  { path: ['responses', 0, 'image_url'], kind: 'responses-input-image', mediaType: 'image/jpeg' },
  { path: ['responses', 1, 'image_url', 'url'], kind: 'responses-input-image', mediaType: 'image/jpeg' },
  { path: ['responses', 2, 'file_data'], kind: 'responses-input-file', mediaType: null },
  { path: ['responses', 3, 'source', 'data'], kind: 'responses-inline-skill', mediaType: 'application/zip' },
];

describe('§5.8 auth projection over the §5.4 predicate matrix', () => {
  it('replaces every ref with a link at the same path, and changes nothing else', async () => {
    useConfig();
    const body = matrixBody();
    const before = structuredClone(body);
    const extracted = await extractInlineBlobs(body);
    assert.equal(extracted.refs, POSITIONS.length, 'the matrix must cover every predicate');

    const projection = buildAuthProjection(body, linksOf(body));

    assert.equal(projection.refs, POSITIONS.length);
    assert.equal(projection.bytes, POSITIONS.length * SMALL);
    assert.equal(collectBlobRefs(projection.body).length, 0, 'no ref may survive into the auth request');
    assert.notEqual(projection.body, body, 'the projection must be a copy, never the caller’s body');

    for (const { path, kind, mediaType } of POSITIONS) {
      const ref = refAt(body, ...path);
      assert.equal(ref.kind, kind, `the predicate that produced the ref at ${path.join('.')}`);
      assert.deepStrictEqual(
        at(projection.body, ...path),
        {
          type: 'external_blob',
          url: signedUrl(ref.hash),
          sha256: ref.hash,
          size: ref.size,
          media_type: mediaType,
          encoding: 'base64',
        },
        `the link at ${path.join('.')}`,
      );
      assert.equal(isBlobRef(linkAt(projection.body, ...path)), false, 'a link is not a ref');
    }

    // The surrounding metadata and the field paths survive untouched, and no
    // inline base64 or `data:` prefix is left anywhere in the auth body.
    assert.equal(at(projection.body, 'messages', 0, 'content', 0, 'source', 'type'), 'base64');
    assert.equal(at(projection.body, 'messages', 0, 'content', 0, 'source', 'media_type'), 'image/png');
    assert.equal(at(projection.body, 'messages', 0, 'content', 0, 'type'), 'image');
    assert.equal(at(projection.body, 'chat', 1, 'input_audio', 'format'), 'wav');
    assert.equal(at(projection.body, 'chat', 3, 'file', 'filename'), 'url.pdf');
    assert.equal(at(projection.body, 'messages', 0, 'content', 2, 'text'), 'describe these');

    const authText = JSON.stringify(projection.body);
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']) {
      assert.ok(!authText.includes(payload(seed, SMALL)), `payload ${seed} must not reach the auth request`);
    }
    assert.ok(!authText.includes(';base64,'), 'no data-URL prefix may survive into the auth request');
  });

  it('leaves the request body able to send the original inline bytes upstream', async () => {
    useConfig();
    const body = matrixBody();
    const before = structuredClone(body);
    await extractInlineBlobs(body);
    const extracted = structuredClone(body);

    buildAuthProjection(body, linksOf(body));

    // §5.8: "The upstream request is unchanged in semantics: it still streams the
    // original inline base64 fields from the local blobs." So the body keeps its
    // own refs, and expanding them reproduces the client's bytes exactly.
    assert.deepStrictEqual(body, extracted, 'the projection must not touch the request body');
    assert.equal(collectBlobRefs(body).length, POSITIONS.length);

    const copy = structuredClone(body);
    assert.equal(await rehydrateInlineBlobs(copy), POSITIONS.length);
    assert.deepStrictEqual(copy, before);
    assert.equal(JSON.stringify(copy), JSON.stringify(before), 'wire bytes must match the input exactly');
    assert.equal(releaseInlineBlobs(body), POSITIONS.length);
  });

  it('states null media_type without inventing one from a nearby field', async () => {
    useConfig();
    const body = { chat: [{ type: 'input_audio', input_audio: { data: payload('z', SMALL), format: 'wav' } }] };
    await extractInlineBlobs(body);

    const { body: projected } = buildAuthProjection(body, linksOf(body));

    const link = linkAt(projected, 'chat', 0, 'input_audio', 'data');
    assert.equal(link.media_type, null);
    assert.equal(link.size, SMALL);
    assert.equal(at(projected, 'chat', 0, 'input_audio', 'format'), 'wav', 'the format field is not a media type');
  });

  it('projects one link per ref, and needs one upload for a payload two refs share', async () => {
    useConfig();
    const shared = payload('s', SMALL);
    const body = {
      messages: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: shared } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: shared } },
      ],
    };
    await extractInlineBlobs(body);
    const links = linksOf(body);
    assert.equal(links.size, 1, 'the two refs name one stored blob');

    const projection = buildAuthProjection(body, links);

    assert.equal(projection.refs, 2);
    assert.equal(projection.bytes, 2 * SMALL);
    const [first, second] = [
      linkAt(projection.body, 'messages', 0, 'source', 'data'),
      linkAt(projection.body, 'messages', 1, 'source', 'data'),
    ];
    assert.deepStrictEqual(first, second);
    assert.equal(collectBlobRefs(body).length, 2);
  });
});

describe('§5.8 auth projection keeps the sidecar’s final text and tools', () => {
  it('carries the mutated text and tools verbatim beside a link', async () => {
    useConfig();
    const body: Record<string, unknown> = {
      model: 'claude-sonnet-5-5',
      system: 'You are helpful.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is in this image?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: payload('m', SMALL) } },
          ],
        },
      ],
      tools: [{ name: 'lookup', description: 'Look something up.', input_schema: { type: 'object' } }],
    };
    await extractInlineBlobs(body);

    // What privacy/kompress/judge do to the parse tree after extraction: the
    // text and tools the auth request must see are the final values.
    const content = at(body, 'messages', 0, 'content') as Record<string, unknown>[];
    content[0].text = 'redacted question';
    body.tools = [{ name: 'lookup', description: 'redacted description', input_schema: { type: 'object' } }];

    const { body: projected } = buildAuthProjection(body, linksOf(body));

    assert.equal(at(projected, 'messages', 0, 'content', 0, 'text'), 'redacted question');
    assert.deepStrictEqual(at(projected, 'tools', 0), {
      name: 'lookup',
      description: 'redacted description',
      input_schema: { type: 'object' },
    });
    assert.equal(at(projected, 'system'), 'You are helpful.');
    assert.equal(at(projected, 'model'), 'claude-sonnet-5-5');
    assert.equal(linkAt(projected, 'messages', 0, 'content', 1, 'source', 'data').media_type, 'image/png');
  });
});

describe('§5.8 auth projection passes non-binary fields through', () => {
  it('leaves existing remote URLs and file URIs byte-identical', async () => {
    useConfig();
    const body = {
      messages: [
        { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: payload('p', SMALL) } },
      ],
      chat: [
        { type: 'image_url', image_url: { url: 'https://example.com/b.png' } },
        { type: 'input_audio', input_audio: { format: 'wav' } },
      ],
      gemini: [{ fileData: { mimeType: 'application/pdf', fileUri: 'files/abc123' } }],
    };
    await extractInlineBlobs(body);

    const { body: projected, refs } = buildAuthProjection(body, linksOf(body));

    assert.equal(refs, 1, 'only the one inline payload is projected');
    assert.deepStrictEqual(projected, {
      messages: [
        { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: {
              type: 'external_blob',
              url: signedUrl(refAt(body, 'messages', 1, 'source', 'data').hash),
              sha256: refAt(body, 'messages', 1, 'source', 'data').hash,
              size: SMALL,
              media_type: 'image/png',
              encoding: 'base64',
            },
          },
        },
      ],
      chat: [
        { type: 'image_url', image_url: { url: 'https://example.com/b.png' } },
        { type: 'input_audio', input_audio: { format: 'wav' } },
      ],
      gemini: [{ fileData: { mimeType: 'application/pdf', fileUri: 'files/abc123' } }],
    });
  });

  it('returns a deep-equal copy and no links for a body with no refs', () => {
    useConfig();
    const body = { model: 'gpt-5', input: 'hello', urls: ['https://example.com/a.png'] };

    const projection = buildAuthProjection(body, new Map());

    assert.equal(projection.refs, 0);
    assert.equal(projection.bytes, 0);
    assert.deepStrictEqual(projection.body, body);
    assert.notEqual(projection.body, body);
  });
});

describe('§5.8 auth projection fails closed', () => {
  /** A body with one extracted payload, and the ref it produced. */
  async function extracted(): Promise<{ body: Record<string, unknown>; ref: BlobRef }> {
    useConfig();
    const body = { chat: [{ type: 'file', file: { file_data: payload('q', SMALL) } }] };
    await extractInlineBlobs(body);
    return { body, ref: refAt(body, 'chat', 0, 'file', 'file_data') };
  }

  it('refuses a ref with no upload, and leaves the body usable', async () => {
    const { body, ref } = await extracted();
    const before = structuredClone(body);

    assert.throws(
      () => buildAuthProjection(body, new Map()),
      (error: unknown) => {
        assert.ok(error instanceof AuthProjectionError, `expected AuthProjectionError, got ${String(error)}`);
        assert.match((error as Error).message, new RegExp(ref.hash));
        return true;
      },
    );
    assert.deepStrictEqual(body, before, 'a refused projection must not have applied anything');
    assert.equal(releaseInlineBlobs(body), 1);
  });

  it('refuses an unusable link without echoing the URL', async () => {
    const { body, ref } = await extracted();
    const cases: Array<[string, string]> = [
      ['', 'no external link for blob'],
      ['not a url', 'is not a URL'],
      ['http://objects.example.test/a.b64', 'uses http:, not https:'],
      ['file:///var/tmp/a.b64', 'uses file:, not https:'],
    ];

    for (const [url, needle] of cases) {
      assert.throws(
        () => buildAuthProjection(body, new Map([[ref.hash, url]])),
        (error: unknown) => {
          assert.ok(error instanceof AuthProjectionError, `expected AuthProjectionError, got ${String(error)}`);
          const message = (error as Error).message;
          assert.ok(message.includes(needle), `expected ${JSON.stringify(message)} to contain ${JSON.stringify(needle)}`);
          if (url !== '') assert.ok(!message.includes(url), 'a signed URL must never be echoed into an error');
          return true;
        },
      );
    }
  });

  it('checks the ref’s shape before it consults the upload map', async () => {
    const { body, ref } = await extracted();
    // A ref a client forged into its own field: the marker and a hash, but the
    // metadata the link is built from is not there. The hash is in the map, so a
    // projection that looked the link up first would state the forged size.
    const forged = { ...ref, size: 'lots', prefix: 5 };
    const forgedBody = { chat: [{ type: 'file', file: { file_data: forged } }] };

    assert.throws(
      () => buildAuthProjection(forgedBody, new Map([[ref.hash, signedUrl(ref.hash)]])),
      (error: unknown) => {
        assert.ok(error instanceof BlobStoreError, `expected BlobStoreError, got ${String(error)}`);
        assert.match((error as Error).message, /malformed ref/);
        return true;
      },
    );
  });

  it('refuses a hash the caller has no link for, even when other refs have one', async () => {
    const { body, ref } = await extracted();
    const mixed = {
      chat: structuredClone(at(body, 'chat')),
      responses: [{ type: 'input_file', file_data: { ...ref, hash: FORGED_HASH } }],
    };

    assert.throws(
      () => buildAuthProjection(mixed, new Map([[ref.hash, signedUrl(ref.hash)]])),
      (error: unknown) => {
        assert.ok(error instanceof AuthProjectionError, `expected AuthProjectionError, got ${String(error)}`);
        assert.match((error as Error).message, new RegExp(FORGED_HASH));
        return true;
      },
    );
  });
});
