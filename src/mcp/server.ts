import { McpServer } from '@modelcontextprotocol/server';
import type { SessionService } from '../session/session-service.ts';
import { instructionsFor, type ToolSet } from './instructions.ts';
import { journeyTools } from './journey-tools.ts';
import type { ImageResponses } from './results.ts';
import { taskTools } from './task-tools.ts';

// One fixed order, whatever the set: a byte-stable tool list keeps a client's prompt cache warm.
const TOOLS_IN_ORDER = {
  task: ['jevway_task', 'jevway_look', 'jevway_end'],
  journeys: [
    'jevway_journey_start',
    'jevway_journey_step',
    'jevway_journey_autopilot',
    'jevway_journey_annotate',
    'jevway_journey_finish',
  ],
} as const;

/** A setting's value when it is one of `allowed`, else the first (the default), with a warning on stderr. */
const setting = <T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T => {
  if (!value || allowed.includes(value as T)) return (value as T) || allowed[0];
  console.error(`jevway-mcp: ${name}=${value} is not one of ${allowed.join(' | ')}; using ${allowed[0]}.`);
  return allowed[0];
};

/**
 * The factory `serveStdio` calls for each connection (twice when a 2026-07-28 probe falls back to initialize): it
 * builds a server and nothing else, so every connection shares the service's sessions. `JEVWAY_TOOLS` picks the tools
 * and `JEVWAY_IMAGE_RESPONSES` when a task result inlines its end page; both are read once, from `env`.
 *
 * @example
 * serveStdio(createMcpServer({ service: createSessionService(createRunner('auto')), version: '0.4.0' }));
 */
export const createMcpServer = ({
  service,
  version,
  env = process.env,
}: {
  service: SessionService;
  version: string;
  env?: Record<string, string | undefined>;
}) => {
  const tools: ToolSet = setting('JEVWAY_TOOLS', env.JEVWAY_TOOLS, ['all', 'task', 'journeys'] as const);
  const images: ImageResponses = setting('JEVWAY_IMAGE_RESPONSES', env.JEVWAY_IMAGE_RESPONSES, [
    'auto',
    'always',
    'never',
  ] as const);
  const registrations = { ...taskTools(service, { images }), ...journeyTools(service) };
  const served = [
    ...(tools === 'journeys' ? [] : TOOLS_IN_ORDER.task),
    ...(tools === 'task' ? [] : TOOLS_IN_ORDER.journeys),
  ];
  const instructions = instructionsFor(tools);

  return () => {
    const server = new McpServer({ name: 'jevway', version }, { instructions });
    for (const name of served) registrations[name](server);
    return server;
  };
};
