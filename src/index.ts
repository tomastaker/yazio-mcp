#!/usr/bin/env node

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { createYazioServer } from './server.js';

const config = loadConfig();

serveStdio(() => createYazioServer(config), {
  legacy: 'serve',
  onerror: (error) => {
    process.stderr.write(`yazio-mcp transport error: ${error.message}\n`);
  },
});
