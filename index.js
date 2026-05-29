#!/usr/bin/env node

const { main } = require('./src/cli');
const { startPluginServer } = require('./src/pluginServer');

async function run() {
  const args = process.argv.slice(2);
  if (args.includes('--plugin-server')) {
    startPluginServer();
    return;
  }
  await main();
}

run().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
