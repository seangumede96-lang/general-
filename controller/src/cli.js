#!/usr/bin/env node
// Entry point. Listens on localhost only by default: the UI is opened in the phone's own
// browser, and nothing else on the network should be able to reach it.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './server.js';

const port = Number(process.env.PORT || 8400);
const host = process.env.HOST || '127.0.0.1';
const dataDir = process.env.ASSISTANT_DATA_DIR || join(homedir(), '.assistant-controller');

const app = createApp({ dataDir });
const addr = await app.listen(port, host);
console.log(`Controller running at http://${addr.address}:${addr.port}`);
console.log(`Data directory: ${dataDir}`);
if (host !== '127.0.0.1' && host !== 'localhost') {
	console.warn('Warning: listening beyond localhost. There is no login yet, so anyone who can reach this port can use it.');
}

for (const sig of ['SIGINT', 'SIGTERM']) {
	process.on(sig, () => { app.close().finally(() => process.exit(0)); });
}
