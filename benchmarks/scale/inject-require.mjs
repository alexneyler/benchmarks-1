import { createRequire } from 'node:module';
if (typeof globalThis.require === 'undefined') {
  globalThis.require = createRequire(import.meta.url);
}
