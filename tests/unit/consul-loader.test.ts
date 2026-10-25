import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildConsulKvUrl, parseConsulConfig } from '../../src/utils/consul-loader.js';

const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64');

describe('buildConsulKvUrl', () => {
  it('builds a recursive KV URL from a loopback meta server', () => {
    assert.equal(
      buildConsulKvUrl('http://127.0.0.1:8500/ui?ignored=true'),
      'http://127.0.0.1:8500/v1/kv/model-proxy-v3?recurse=true',
    );
    assert.equal(
      buildConsulKvUrl('https://localhost:8501/base'),
      'https://localhost:8501/v1/kv/model-proxy-v3?recurse=true',
    );
  });

  it('accepts private LAN addresses', () => {
    assert.equal(
      buildConsulKvUrl('http://10.0.0.8:8500'),
      'http://10.0.0.8:8500/v1/kv/model-proxy-v3?recurse=true',
    );
  });

  it('rejects malformed, non-HTTP, and public URLs', () => {
    assert.throws(() => buildConsulKvUrl('not a url'), /not a valid URL/);
    assert.throws(() => buildConsulKvUrl('file:///tmp/config'), /must use http or https, got: file:/);
    assert.throws(() => buildConsulKvUrl('https://example.com'), /localhost or a private\/LAN address/);
  });
});

describe('parseConsulConfig', () => {
  it('decodes general, defaults, and model entries with scalar types', () => {
    const config = parseConsulConfig([
      { Key: 'model-proxy-v3/general/global_token_limit', Value: encode('10B 1w') },
      { Key: 'model-proxy-v3/general/request_timeout', Value: encode('30') },
      { Key: 'model-proxy-v3/defaults/thinking', Value: encode('enabled') },
      { Key: 'model-proxy-v3/models/free/base_url', Value: encode('https://upstream.example/v1') },
      { Key: 'model-proxy-v3/models/free/api_key', Value: encode('secret') },
    ]);

    assert.deepEqual(config, {
      general: { global_token_limit: '10B 1w', request_timeout: 30 },
      defaults: { thinking: 'enabled' },
      models: {
        free: { base_url: 'https://upstream.example/v1', api_key: 'secret' },
      },
    });
  });

  it('parses model arrays and preserves commas inside quoted values', () => {
    const config = parseConsulConfig([
      { Key: 'model-proxy-v3/models/free/alpha', Value: encode('["vendor/alpha", "https://a.example/v1,alt", "key", "native"]') },
      { Key: 'model-proxy-v3/models/free/empty', Value: encode('[]') },
    ]);
    const free = config.models.free as Record<string, unknown>;
    assert.deepEqual(free.alpha, ['vendor/alpha', 'https://a.example/v1,alt', 'key', 'native']);
    assert.deepEqual(free.empty, ['']);
  });

  it('ignores missing values and incomplete or empty keys', () => {
    const config = parseConsulConfig([
      { Key: 'model-proxy-v3/general/empty', Value: null },
      { Key: 'model-proxy-v3/general/missing' },
      { Key: 'model-proxy-v3/models/free' },
      { Key: 'model-proxy-v3/', Value: encode('ignored') },
    ]);
    assert.deepEqual(config, {});
  });

  it('supports unprefixed keys and ignores incomplete model keys', () => {
    const config = parseConsulConfig([
      { Key: 'general/enabled', Value: encode('1') },
      { Key: 'models/free', Value: encode('["root", "https://root.example"]') },
      { Key: 'models/free/nested', Value: encode('value') },
    ]);
    assert.deepEqual(config.general, { enabled: 1 });
    assert.deepEqual(config.models.free, { nested: 'value' });
  });
});
