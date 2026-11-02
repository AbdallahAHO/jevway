import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { Prompter } from './setup-wizard.ts';

/**
 * The real terminal for setup. Hidden answers are read through readline with its echo sent to a muted stream, and
 * readline keeps no history, so a key is never drawn on screen nor kept after the question. Ctrl-C (or Ctrl-D) exits
 * 130 at once: setup writes every file whole, so nothing is left half-written.
 */
export const terminalPrompter = () => {
  let muted = false;
  let closing = false;
  const echo = new Writable({
    write(chunk, encoding, done) {
      if (!muted) process.stdout.write(chunk, encoding);
      done();
    },
  });
  Object.defineProperty(echo, 'columns', { get: () => process.stdout.columns });
  const rl = createInterface({ input: process.stdin, output: echo, terminal: true, historySize: 0 });
  const stop = () => {
    if (closing) return;
    muted = false;
    process.stdout.write('\nStopped. Every file is as it was before, or written whole.\n');
    process.exit(130);
  };
  rl.on('SIGINT', stop);
  rl.on('close', stop);
  const io: Prompter = {
    say: (text) => void process.stdout.write(`${text}\n`),
    ask: (question) => rl.question(question),
    askHidden: async (question) => {
      process.stdout.write(question);
      muted = true;
      try {
        return await rl.question('');
      } finally {
        muted = false;
        process.stdout.write('\n');
      }
    },
  };
  return {
    io,
    close: () => {
      closing = true;
      rl.close();
    },
  };
};
