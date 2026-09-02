import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  copyPage,
  createPage,
  deletePage,
  favoritePage,
  getPage,
  listCollectives,
  listPages,
  listTags,
  movePage,
  renamePage,
  searchPages,
  setPageEmoji,
  unfavoritePage,
  updatePage,
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
      /not found|404/i,
    );
  });

  test('searchPages accepts a query and returns an array', { skip: skipReason ?? undefined }, async () => {
    const results = await searchPages(client, 'a');
    assert.ok(Array.isArray(results), 'returns an array');
  });
});

describe('Collectives MCP — write integration', () => {
  let client: NextcloudClient;
  const unique = `mcp-test-${Date.now()}`;
  let landingId: number;
  let createdId: number | null = null;

  before(async () => {
    if (skip) return;
    client = new NextcloudClient(loadConfig());
    const pages = await listPages(client, COLLECTIVE_ID);
    const landing = pages.find((p) => p.parentId === 0);
    assert.ok(landing, 'collective has a Landing page');
    landingId = landing.id;
  });

  after(async () => {
    if (skip || createdId === null) return;
    try {
      await deletePage(client, COLLECTIVE_ID, createdId);
    } catch {
      /* swallow */
    }
  });

  test('createPage creates a page under the landing page', { skip: skipReason ?? undefined }, async () => {
    const page = await createPage(client, {
      collectiveId: COLLECTIVE_ID,
      parentPageId: landingId,
      title: unique,
      body: '# Hello\n\nInitial body.\n',
    });
    createdId = page.id;
    assert.equal(page.title, unique);
    assert.equal(page.parentId, landingId);
  });

  test('updatePage replace overwrites the body', { skip: skipReason ?? undefined }, async () => {
    assert.ok(createdId);
    await updatePage(client, COLLECTIVE_ID, createdId, '# Replaced\n');
    const { markdown } = await getPage(client, COLLECTIVE_ID, createdId);
    assert.equal(markdown.trim(), '# Replaced');
  });

  test('updatePage append adds to the end', { skip: skipReason ?? undefined }, async () => {
    assert.ok(createdId);
    await updatePage(client, COLLECTIVE_ID, createdId, 'appended', 'append');
    const { markdown } = await getPage(client, COLLECTIVE_ID, createdId);
    assert.match(markdown, /Replaced[\s\S]*appended/);
  });

  test('updatePage prepend adds to the start', { skip: skipReason ?? undefined }, async () => {
    assert.ok(createdId);
    await updatePage(client, COLLECTIVE_ID, createdId, 'prepended', 'prepend');
    const { markdown } = await getPage(client, COLLECTIVE_ID, createdId);
    assert.match(markdown, /^prepended[\s\S]*Replaced[\s\S]*appended/);
  });

  test('setPageEmoji sets and clears the icon', { skip: skipReason ?? undefined }, async () => {
    assert.ok(createdId);
    const set = await setPageEmoji(client, COLLECTIVE_ID, createdId, '🧪');
    assert.equal(set.emoji, '🧪');
    const cleared = await setPageEmoji(client, COLLECTIVE_ID, createdId, '');
    assert.ok(!cleared.emoji, `expected emoji to be cleared, got ${JSON.stringify(cleared.emoji)}`);
  });

  test('renamePage changes the title', { skip: skipReason ?? undefined }, async () => {
    assert.ok(createdId);
    const newTitle = `${unique}-renamed`;
    const renamed = await renamePage(client, COLLECTIVE_ID, createdId, newTitle);
    assert.equal(renamed.title, newTitle);
  });

  test('movePage moves the page under a new parent and back', { skip: skipReason ?? undefined }, async () => {
    assert.ok(createdId);
    const sibling = await createPage(client, {
      collectiveId: COLLECTIVE_ID,
      parentPageId: landingId,
      title: `${unique}-host`,
    });
    try {
      const moved = await movePage(client, COLLECTIVE_ID, createdId, sibling.id);
      assert.equal(moved.parentId, sibling.id);
      const back = await movePage(client, COLLECTIVE_ID, createdId, landingId);
      assert.equal(back.parentId, landingId);
    } finally {
      await deletePage(client, COLLECTIVE_ID, sibling.id);
    }
  });

  test('favoritePage / unfavoritePage round-trip', { skip: skipReason ?? undefined }, async () => {
    assert.ok(createdId);
    await favoritePage(client, COLLECTIVE_ID, createdId);
    const collectives = await listCollectives(client);
    const c = collectives.find((x) => x.id === COLLECTIVE_ID);
    assert.ok(c?.userFavoritePages?.includes(createdId), 'favorite is recorded');
    await unfavoritePage(client, COLLECTIVE_ID, createdId);
  });

  test('copyPage duplicates the page', { skip: skipReason ?? undefined }, async () => {
    assert.ok(createdId);
    const copy = await copyPage(client, COLLECTIVE_ID, createdId);
    try {
      assert.ok(copy.id !== createdId, 'copy has a fresh id');
    } finally {
      await deletePage(client, COLLECTIVE_ID, copy.id);
    }
  });

  test('listTags returns an array', { skip: skipReason ?? undefined }, async () => {
    const tags = await listTags(client, COLLECTIVE_ID);
    assert.ok(Array.isArray(tags));
  });

  test('deletePage removes the page', { skip: skipReason ?? undefined }, async () => {
    assert.ok(createdId);
    await deletePage(client, COLLECTIVE_ID, createdId);
    const after = await listPages(client, COLLECTIVE_ID);
    assert.ok(!after.some((p) => p.id === createdId), 'page no longer listed');
    createdId = null;
  });
});
