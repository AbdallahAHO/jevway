import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { JourneyReply, SessionService } from '../session/session-service.ts';
import { errorResult, jsonResult, linkTo } from './results.ts';

/** A screen report as JSON plus a light JPEG of the screen (`content[1]`), so a multimodal agent sees what Jev saw. */
const journeyResult = ({ journey, report, preview }: JourneyReply) => {
  const result = jsonResult({ journey, ...report });
  return { ...result, content: [...result.content, { type: 'image' as const, data: preview, mimeType: 'image/jpeg' }] };
};

/** Registers the five `jevway_journey_*` tools over the session service. */
export const journeyTools = (service: SessionService) => ({
  jevway_journey_start: (server: McpServer) =>
    server.registerTool(
      'jevway_journey_start',
      {
        title: 'Start mapping mobile user journeys',
        // Opens a tab on any URL; taps nothing.
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        description:
          'Open a URL on an emulated phone and map its user journeys: each screen gets a report (type, UI patterns, ranked next taps, QA findings) and an image. Go on with jevway_journey_step (you pick) or jevway_journey_autopilot (Jev explores), describe screens with jevway_journey_annotate, end with jevway_journey_finish.',
        inputSchema: z.object({
          url: z.string().url(),
          device: z.enum(['iphone-15', 'pixel-8', 'laptop', 'desktop']).optional(),
          intent: z.string().optional().describe('One journey to follow; omit to explore.'),
          values: z.record(z.string(), z.string()).optional().describe('Text autopilot may type.'),
          stay_within: z.string().optional().describe('URL prefix to stay under (default: same origin).'),
          out_dir: z.string().optional().describe('Exact folder (default ./.jevway/journeys/…).'),
        }),
      },
      async ({ url, device, intent, values, stay_within, out_dir }) => {
        try {
          return journeyResult(
            await service.journeyStart({ url, device, intent, values, stayWithin: stay_within, outDir: out_dir }),
          );
        } catch (error) {
          return errorResult('jevway_journey_start', error);
        }
      },
    ),

  jevway_journey_step: (server: McpServer) =>
    server.registerTool(
      'jevway_journey_step',
      {
        title: 'Take the next journey step',
        // Taps whatever the caller names, a submit included.
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description:
          'Take one step and note the screen you leave. `next`: an index from `elements` or `ranked_taps` ("3:2" is a dropdown option), back, restart, scroll_down, scroll_up or screen:<id>.',
        inputSchema: z.object({
          journey: z.string(),
          next: z.union([z.string(), z.number()]),
          value: z.string().optional().describe('Text to type.'),
          flow: z.string().optional().describe('Flow name, kept for later steps.'),
          description: z.string().optional().describe('What the screen you leave is.'),
          insight: z.string().optional().describe('A UX observation.'),
        }),
      },
      async ({ journey, ...input }) => {
        try {
          return journeyResult(await service.journeyStep(journey, input));
        } catch (error) {
          return errorResult('jevway_journey_step', error);
        }
      },
    ),

  jevway_journey_autopilot: (server: McpServer) =>
    server.registerTool(
      'jevway_journey_autopilot',
      {
        title: 'Let Jev explore the journey',
        // Taps on the site, but skips irreversible taps and stops at auth walls.
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        description:
          'Let Jev explore: with `intent` until it is reached, a stop (sign-in, an irreversible tap) or no untried taps; without, for `screens` new screens. Skips tried, off-site and irreversible taps; returns a move log.',
        inputSchema: z.object({
          journey: z.string(),
          screens: z.number().int().positive().max(30).optional(),
          flow: z.string().optional(),
          intent: z.string().optional(),
        }),
      },
      async ({ journey, screens, flow, intent }) => {
        try {
          return journeyResult(await service.journeyAutopilot(journey, { screens, flow, intent }));
        } catch (error) {
          return errorResult('jevway_journey_autopilot', error);
        }
      },
    ),

  jevway_journey_annotate: (server: McpServer) =>
    server.registerTool(
      'jevway_journey_annotate',
      {
        title: 'Describe a journey screen',
        // Edits the local journey record only.
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description:
          'Describe a screen by id, and/or move steps from_step..to_step (0-based, see journey.json) into a named flow.',
        inputSchema: z.object({
          journey: z.string(),
          screen: z.string(),
          description: z.string().optional(),
          insight: z.string().optional(),
          relabel: z
            .object({
              from_step: z.number().int().min(0).max(999),
              to_step: z.number().int().min(0).max(999),
              flow: z.string(),
            })
            .optional(),
        }),
      },
      async ({ journey, screen, description, insight, relabel }) => {
        try {
          service.journeyAnnotate(
            journey,
            screen,
            { description, insight },
            relabel && { fromStep: relabel.from_step, toStep: relabel.to_step, flow: relabel.flow },
          );
          return { content: [{ type: 'text' as const, text: `Annotated ${screen}.` }] };
        } catch (error) {
          return errorResult('jevway_journey_annotate', error);
        }
      },
    ),

  jevway_journey_finish: (server: McpServer) =>
    server.registerTool(
      'jevway_journey_finish',
      {
        title: 'Finish the journey map',
        // Writes the local journey files and closes the tab.
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description:
          'Write journey.json and the index.html viewer, close the tab unless `keep_tab`, and list screens still undescribed.',
        inputSchema: z.object({ journey: z.string(), keep_tab: z.boolean().optional() }),
      },
      async ({ journey, keep_tab }) => {
        try {
          const summary = await service.journeyFinish(journey, { keepTab: keep_tab });
          return jsonResult(summary, [
            linkTo(summary.viewer, 'text/html', 'The journey viewer: screens, flows and QA findings.'),
            linkTo(summary.journey_json, 'application/json', 'The journey map as data.'),
            linkTo(summary.manifest, 'application/json', 'Every file in the journey folder, with what it is.'),
          ]);
        } catch (error) {
          return errorResult('jevway_journey_finish', error);
        }
      },
    ),
});
