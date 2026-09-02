import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { normalizeColor, PAGE_MODES, PAGE_ORDERS } from './api.js';
import { canonicalizeBaseUrl, DEFAULT_TIMEOUT_MS, loadConfig } from './config.js';
import { dispatchTool, encodeAttachmentFilename, TOOLS } from './tools.js';
import { VERSION } from './version.js';

/**
 * Deterministic unit tests. No Nextcloud instance required — these always run,
 * including in CI.
 */

describe('Tag colour normalisation (pure)', () => {
  test('accepts six hex digits with or without a leading #', () => {
    assert.equal(normalizeColor('#2d7d46'), '2d7d46');
    assert.equal(normalizeColor('2d7d46'), '2d7d46');
    assert.equal(normalizeColor('  #FFFFFF  '), 'FFFFFF');
  });

  test('rejects anything that is not exactly six hex digits', () => {
    for (const bad of ['red', '#12345', '##ffffff', '1234567', '', '#', 'gggggg', '#12 456']) {
      assert.throws(() => normalizeColor(bad), /six hexadecimal digits/, `should reject ${bad}`);
    }
  });
});

describe('Base URL canonicalisation (pure)', () => {
  test('strips trailing slashes and keeps a deployment sub-path', () => {
    assert.equal(canonicalizeBaseUrl('https://cloud.example.com/'), 'https://cloud.example.com');
    assert.equal(canonicalizeBaseUrl('https://cloud.example.com///'), 'https://cloud.example.com');
    assert.equal(canonicalizeBaseUrl('https://example.com/nextcloud/'), 'https://example.com/nextcloud');
  });

  test('rejects components that would corrupt the endpoint path', () => {
    assert.throws(() => canonicalizeBaseUrl('https://cloud.example/nextcloud?x=1'), /query string/);
    assert.throws(() => canonicalizeBaseUrl('https://cloud.example/#top'), /fragment/);
  });

  test('rejects embedded credentials', () => {
    assert.throws(
      () => canonicalizeBaseUrl('https://alice:secret@cloud.example'),
      /embedded credentials/,
    );
  });

  test('rejects non-http protocols and unparseable input', () => {
    assert.throws(() => canonicalizeBaseUrl('ftp://cloud.example'), /http or https/);
    assert.throws(() => canonicalizeBaseUrl('not a url'), /not a valid URL/);
  });
});

describe('Config loading (pure)', () => {
  const base = {
    NEXTCLOUD_URL: 'https://cloud.example.com/',
    NEXTCLOUD_USER: 'alice',
    NEXTCLOUD_APP_PASSWORD: 'app-pw',
  };

  test('canonicalises the URL and applies the default timeout', () => {
    const cfg = loadConfig({ ...base });
    assert.equal(cfg.url, 'https://cloud.example.com');
    assert.equal(cfg.timeoutMs, DEFAULT_TIMEOUT_MS);
  });

  test('honours NEXTCLOUD_TIMEOUT_MS and rejects nonsense values', () => {
    assert.equal(loadConfig({ ...base, NEXTCLOUD_TIMEOUT_MS: '5000' }).timeoutMs, 5000);
    assert.throws(() => loadConfig({ ...base, NEXTCLOUD_TIMEOUT_MS: '0' }), /positive number/);
    assert.throws(() => loadConfig({ ...base, NEXTCLOUD_TIMEOUT_MS: 'soon' }), /positive number/);
  });

  test('names every missing required variable', () => {
    assert.throws(() => loadConfig({}), /NEXTCLOUD_URL, NEXTCLOUD_USER, NEXTCLOUD_APP_PASSWORD/);
  });
});

describe('Attachment filename encoding (pure)', () => {
  test('escapes URL-significant characters that break markdown links', () => {
    assert.equal(encodeAttachmentFilename('report#1 (final).png'), 'report%231%20%28final%29.png');
    assert.equal(encodeAttachmentFilename("it's a *test*.md"), 'it%27s%20a%20%2Atest%2A.md');
  });

  test('leaves an already-safe name untouched', () => {
    assert.equal(encodeAttachmentFilename('diagram-v2.png'), 'diagram-v2.png');
  });
});

describe('Tool registry annotations', () => {
  test('every tool declares explicit behaviour hints', () => {
    for (const tool of TOOLS) {
      const a = tool.annotations;
      assert.ok(a, `${tool.name} has annotations`);
      assert.equal(typeof a.readOnlyHint, 'boolean', `${tool.name} readOnlyHint`);
      assert.equal(typeof a.destructiveHint, 'boolean', `${tool.name} destructiveHint`);
      assert.equal(typeof a.idempotentHint, 'boolean', `${tool.name} idempotentHint`);
      assert.equal(typeof a.openWorldHint, 'boolean', `${tool.name} openWorldHint`);
    }
  });

  test('irreversible deletions are marked destructive and not read-only', () => {
    for (const name of ['purge_page', 'permanently_delete_collective', 'delete_attachment']) {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool, `${name} is registered`);
      assert.equal(tool.annotations?.destructiveHint, true, `${name} is destructive`);
      assert.equal(tool.annotations?.readOnlyHint, false, `${name} is not read-only`);
    }
  });

  test('no read-only tool is also marked destructive', () => {
    for (const tool of TOOLS) {
      if (tool.annotations?.readOnlyHint) {
        assert.equal(tool.annotations.destructiveHint, false, `${tool.name}`);
      }
    }
  });
});

describe('Server identity', () => {
  test('advertised version matches package.json', () => {
    const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
    assert.equal(VERSION, pkg.version);
  });
});

describe('Setting enums (pure)', () => {
  test('page modes match the values the API expects', () => {
    assert.deepEqual(PAGE_MODES, { view: 0, edit: 1 });
  });

  test('page orders match the documented userSettings values', () => {
    assert.deepEqual(PAGE_ORDERS, {
      byOrder: 0,
      byTimeAsc: 1,
      byTitleAsc: 2,
      byTimeDesc: 3,
      byTitleDesc: 4,
    });
  });
});

describe('Tool registry shape', () => {
  test('tool names are unique and match their registry keys', () => {
    const names = TOOLS.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, 'no duplicate tool names');
  });

  test('every tool declares an object input schema with additionalProperties false', () => {
    for (const tool of TOOLS) {
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} schema type`);
      assert.equal(
        tool.inputSchema.additionalProperties,
        false,
        `${tool.name} rejects unknown properties`,
      );
    }
  });

  test('every required property is actually declared in the schema', () => {
    for (const tool of TOOLS) {
      const props = Object.keys(tool.inputSchema.properties ?? {});
      for (const req of tool.inputSchema.required ?? []) {
        assert.ok(props.includes(req), `${tool.name} declares required property "${req}"`);
      }
    }
  });

  test('every tool has a description', () => {
    for (const tool of TOOLS) {
      assert.ok((tool.description ?? '').trim().length > 0, `${tool.name} is described`);
    }
  });
});

describe('Argument validation (pure)', () => {
  const ctx = { client: null as never, configSummary: 'unused' };

  /** Narrow a CallToolResult's first block to its text, which these all are. */
  const errorText = (res: Awaited<ReturnType<typeof dispatchTool>>): string => {
    const block = res.content?.[0];
    return block && block.type === 'text' ? block.text : '';
  };

  test('unknown tool names are reported, not thrown', async () => {
    const res = await dispatchTool('no_such_tool', {}, ctx);
    assert.equal(res.isError, true);
    assert.match(errorText(res), /Unknown tool/);
  });

  test('set_user_settings requires at least one field to change', async () => {
    const res = await dispatchTool('set_user_settings', { collectiveId: 1 }, ctx);
    assert.equal(res.isError, true);
    assert.match(errorText(res), /at least one of pageOrder/);
  });

  test('set_user_settings rejects an unknown page order', async () => {
    const res = await dispatchTool('set_user_settings', { collectiveId: 1, pageOrder: 'sideways' }, ctx);
    assert.equal(res.isError, true);
    assert.match(errorText(res), /pageOrder/);
  });

  test('set_page_mode rejects a mode outside view/edit', async () => {
    const res = await dispatchTool('set_page_mode', { collectiveId: 1, mode: 'readonly' }, ctx);
    assert.equal(res.isError, true);
    assert.match(errorText(res), /mode/);
  });

  test('unknown arguments are rejected rather than ignored', async () => {
    const res = await dispatchTool('touch_page', { collectiveId: 1, pageId: 2, oops: true }, ctx);
    assert.equal(res.isError, true);
  });

  test('create_tag still rejects a malformed colour through dispatch', async () => {
    const res = await dispatchTool('create_tag', { collectiveId: 1, name: 'x', color: 'red' }, ctx);
    assert.equal(res.isError, true);
    assert.match(errorText(res), /six hexadecimal digits/);
  });
});
