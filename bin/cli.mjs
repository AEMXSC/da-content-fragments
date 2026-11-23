#!/usr/bin/env node
// npx github:AEMXSC/da-content-fragments install   → add the extension to an EDS site (bin/install.mjs)
// npx github:AEMXSC/da-content-fragments backend   → your own broker and sync service (bin/backend.mjs)
const command = process.argv[2];
if (command === 'backend') await import('./backend.mjs');
else if (!command || command === 'install' || command.startsWith('--')) await import('./install.mjs');
else {
  process.stdout.write('Usage: npx github:AEMXSC/da-content-fragments install | backend --da-org <org>\n');
  process.exitCode = 1;
}
