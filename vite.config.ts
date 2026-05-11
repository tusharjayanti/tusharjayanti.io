import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function promptTokenCount(): Plugin {
  return {
    name: 'prompt-token-count',
    apply: 'serve',
    async configureServer() {
      try {
        const path = resolve(__dirname, 'api/_systemPrompt.txt');
        const content = await readFile(path, 'utf-8');
        const tokens = Math.ceil(content.length / 4);
        // eslint-disable-next-line no-console
        console.log(
          `\n  system prompt: ~${tokens} tokens (${content.length} chars)\n`,
        );
      } catch {
        // _systemPrompt.txt doesn't exist yet (pre-Chunk 4) — silent skip
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), promptTokenCount()],
});
