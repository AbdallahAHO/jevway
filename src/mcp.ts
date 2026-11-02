#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createMcpServer } from './mcp/server.ts';
import { createSessionService } from './session/session-service.ts';
import { loadEnvFile } from './setup/env-file.ts';
import { createRunner } from './task/start-task.ts';

// JEVWAY_BROWSER: auto (running Chrome, shared with chrome-devtools-mcp --auto-connect) | launch | launch-headless | http://host:port
// JEVWAY_MODEL: jev (default) | pplx-decider | clef-omni | clef | clef-flash | gpt-6-luna (see src/jev/model.ts)
// JEVWAY_SCREENSHOTS: off | fallback | always (vision models only)
// JEVWAY_TOOLS: all (default) | task | journeys | inbox; JEVWAY_IMAGE_RESPONSES: auto (default) | always | never
// Keys and JEVWAY_* settings the client's environment lacks come from ~/.config/jevway/env.
loadEnvFile();
const runner = createRunner(process.env.JEVWAY_BROWSER ?? 'auto');
// Without a key the tools are still listed and each call that needs Jev answers with the fix; the client's server log gets it too.
try {
  runner.requireKey();
} catch (error) {
  console.error(`jevway-mcp: ${(error as Error).message}`);
}
// Sessions live here, outside the per-connection servers, until the process exits.
const service = createSessionService(runner);

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const shutdown = async () => {
  await service.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);

serveStdio(createMcpServer({ service, version }), {
  onerror: (error) => console.error(`jevway-mcp: ${error.message}`),
});
