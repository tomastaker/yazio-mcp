#!/usr/bin/env node

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { createNutritionServer } from './server.js';

const config = loadConfig();

serveStdio(() => createNutritionServer(config), {
  legacy: 'serve',
  onerror: (error) => {
    process.stderr.write(`nutrition-mcp transport error: ${error.message}\n`);
  },
});
