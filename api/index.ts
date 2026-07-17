import { createApp } from '../apps/api/dist/app.js';

// Vercel owns the HTTP listener. The same Express application is still
// started with listen() by apps/api/src/server.ts during local development.
export default createApp();
