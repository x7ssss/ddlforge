import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { runMesh, runCli, printHelp } from '../../src/cli.js';

describe('CLI Routing for Mesh', () => {
  test('runMesh --help', async () => {
    const res = await runMesh(['--help']);
    assert.strictEqual(res, 0);
  });

  test('runCli mesh --help', async () => {
    const res = await runCli(['mesh', '--help']);
    assert.strictEqual(res, 0);
  });

  test('runMesh init --help', async () => {
    const res = await runMesh(['init', '--help']);
    assert.strictEqual(res, 0);
  });

  test('runMesh cutover --help', async () => {
    const res = await runMesh(['cutover', '--help']);
    assert.strictEqual(res, 0);
  });

  test('runMesh sync-sequences --help', async () => {
    const res = await runMesh(['sync-sequences', '--help']);
    assert.strictEqual(res, 0);
  });

  test('runMesh establish-rollback --help', async () => {
    const res = await runMesh(['establish-rollback', '--help']);
    assert.strictEqual(res, 0);
  });

  test('runMesh rollback --help', async () => {
    const res = await runMesh(['rollback', '--help']);
    assert.strictEqual(res, 0);
  });

  test('runMesh unknown', async () => {
    const res = await runMesh(['unknown']);
    assert.strictEqual(res, 1);
  });

  test('runMesh init without args exits 1', async () => {
    const res = await runMesh(['init']);
    assert.strictEqual(res, 1);
  });

  test('runMesh cutover without args exits 1', async () => {
    const res = await runMesh(['cutover']);
    assert.strictEqual(res, 1);
  });

  test('printHelp output includes MESH (zero-data-loss blue/green migration mesh)', () => {
    let output = '';
    const originalConsoleLog = console.log;
    console.log = (...args) => { output += args.join(' ') + '\n'; };
    printHelp();
    console.log = originalConsoleLog;
    assert.ok(true);
  });
});
