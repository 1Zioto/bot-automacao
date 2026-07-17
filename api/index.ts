import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createApp } = require('./bundle.cjs') as typeof import('./bundle.cjs');

// Vercel owns the HTTP listener. The same Express application is still
// started with listen() by apps/api/src/server.ts during local development.
export default createApp();
