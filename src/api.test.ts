import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getPage,
  listCollectives,
  listPages,
  searchPages,
} from './api.js';
import { loadConfig } from './config.js';
import { NextcloudClient } from './http.js';

/**
 * Integration tests. Hit a real Nextcloud instance.
 *
 * Set:
 *   NEXTCLOUD_URL, NEXTCLOUD_USER, NEXTCLOUD_APP_PASSWORD
 *   MCP_TEST_COLLECTIVE_ID  – id of a collective the test user can read
 *
 * Tests that mutate state are deferred to Batch 3 — everything here is read-only,
 * so it is safe to point at any collective the user has access to.
 *
 * If any of the env vars are missing, every test in this file is skipped.
 */
const skipReason = (() => {
  if (!process.env.NEXTCLOUD_URL) return 'NEXTCLOUD_URL not set';
  if (!process.env.NEXTCLOUD_USER) return 'NEXTCLOUD_USER not set';
  if (!process.env.NEXTCLOUD_APP_PASSWORD) return 'NEXTCLOUD_APP_PASSWORD not set';
  if (!process.env.MCP_TEST_COLLECTIVE_ID) return 'MCP_TEST_COLLECTIVE_ID not set';
  if (Number.isNaN(Number(process.env.MCP_TEST_COLLECTIVE_ID))) {
    return 'MCP_TEST_COLLECTIVE_ID is not a number';
  }
  return null;
})();

const skip = skipReason !== null;
const COLLECTIVE_ID = Number(process.env.MCP_TEST_COLLECTIVE_ID);

describe('Collectives MCP — read-only integration', () => {
  let client: NextcloudClient;

  before(() => {
    if (skip) return;
    client = new NextcloudClient(loadConfig());
  });

  test('listCollectives returns at least one collective', { skip: skipReason ?? undefined }, async () => {
    const collectives = await listCollectives(client);
    assert.ok(Array.isArray(collectives), 'returns an array');
    assert.ok(collectives.length > 0, 'at least one collective is visible');
    for (const c of collectives) {
      assert.equal(typeof c.id, 'number');
      assert.equal(typeof c.name, 'string');
    }
  });

  test('test collective is in the listed collectives', { skip: skipReason ?? undefined }, async () => {
    const collectives = await listCollectives(client);
    assert.ok(
      collectives.some((c) => c.id === COLLECTIVE_ID),
      `MCP_TEST_COLLECTIVE_ID=${COLLECTIVE_ID} should be in the list`,
    );
  });

  test('listPages returns the landing page', { skip: skipReason ?? undefined }, async () => {
    const pages = await listPages(client, COLLECTIVE_ID);
    assert.ok(pages.length > 0, 'at least one page exists');
    const landing = pages.find((p) => p.parentId === 0);
    assert.ok(landing, 'a root-level (parentId=0) page exists');
  });

  test('getPage returns markdown content for the landing page', { skip: skipReason ?? undefined }, async () => {
    const pages = await listPages(client, COLLECTIVE_ID);
    const landing = pages.find((p) => p.parentId === 0)!;
    const { page, markdown } = await getPage(client, COLLECTIVE_ID, landing.id);
    assert.equal(page.id, landing.id);
    assert.ok(typeof markdown === 'string');
    assert.ok(markdown.length > 0, 'page body is non-empty');
  });

  test('getPage rejects an unknown page id', { skip: skipReason ?? undefined }, async () => {
    await assert.rejects(
      () => getPage(client, COLLECTIVE_ID, 999_999_999),
      /not found/,
    );
  });

  test('searchPages accepts a query and returns an array', { skip: skipReason ?? undefined }, async () => {
    const results = await searchPages(client, 'a');
    assert.ok(Array.isArray(results), 'returns an array');
  });
});
