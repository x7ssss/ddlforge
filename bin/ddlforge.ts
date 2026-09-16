#!/usr/bin/env node

/**
 * ddlforge - Postgres migration lock linter and data-loss prevention engine
 */

import { runCli } from '../src/cli.js';

runCli(process.argv.slice(2))
  .then(exitCode => {
    process.exit(exitCode);
  })
  .catch(err => {
    console.error('Fatal ddlforge error:', err);
    process.exit(1);
  });
