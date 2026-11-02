import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { print, printError, printJson } from './command-output.ts';

const USAGE = `jevway skill                      print the SKILL.md this version ships
jevway skill --install <dir> [--force]   copy the skill folder into <dir>/jevway

Examples:
  jevway skill --install ~/.claude/skills
  jevway skill --install ~/.codex/skills

--install prints { ok, status: installed|unchanged|replaced, path, files }. A different jevway skill already in
<dir>/jevway (or a symlink to one) is left alone unless --force is given.`;

/** The `skill/jevway/` folder of the installed package: two levels up from both `src/setup/` and `dist/setup/`. */
export const bundledSkillDir = () => fileURLToPath(new URL('../../skill/jevway/', import.meta.url));

/** Every file under `dir`, as sorted paths relative to it. */
const filesIn = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();

/** True when `target` holds exactly the files of `source`, byte for byte (following a symlinked `target`). */
const sameFolder = (source: string, target: string) => {
  try {
    const files = filesIn(source);
    return (
      files.join('\n') === filesIn(target).join('\n') &&
      files.every((file) => readFileSync(join(source, file)).equals(readFileSync(join(target, file))))
    );
  } catch {
    return false;
  }
};

/** Whether `<parent>/jevway` is missing, the same as `source`, or something else (a different skill or a symlink to one). */
export const skillState = (source: string, parent: string): 'missing' | 'same' | 'different' => {
  const path = join(parent, 'jevway');
  if (!existsSync(path) && !lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return 'missing';
  return sameFolder(source, path) ? 'same' : 'different';
};

export type SkillInstall =
  | { status: 'installed' | 'unchanged' | 'replaced'; path: string; files: string[] }
  | { status: 'exists'; path: string };

/**
 * Copies `source` to `<parent>/jevway`. An identical copy is left as it is; a different folder or a symlink is
 * replaced only with `force` (a symlink is removed, never its target). The copy lands under a temporary name first,
 * so an interrupted install never leaves half a skill.
 *
 * @example
 * installSkill(bundledSkillDir(), '/Users/ada/.claude/skills', { force: false })
 * // { status: 'installed', path: '/Users/ada/.claude/skills/jevway', files: ['SKILL.md'] }
 */
export const installSkill = (source: string, parent: string, { force }: { force: boolean }): SkillInstall => {
  const path = join(parent, 'jevway');
  const files = filesIn(source);
  const state = skillState(source, parent);
  if (state === 'same') return { status: 'unchanged', path, files };
  if (state === 'different' && !force) return { status: 'exists', path };
  const present = state === 'different';
  mkdirSync(parent, { recursive: true });
  const incoming = join(parent, `.jevway-${process.pid}.incoming`);
  cpSync(source, incoming, { recursive: true });
  if (present) rmSync(path, { recursive: true, force: true });
  renameSync(incoming, path);
  return { status: present ? 'replaced' : 'installed', path, files };
};

/**
 * `jevway skill`: prints the bundled SKILL.md, or with `--install <dir>` copies the skill folder into `<dir>/jevway`.
 *
 * @example
 * process.exit(await runSkill(process.argv.slice(3)));
 */
export const runSkill = async (argv: string[]): Promise<number> => {
  let options;
  try {
    ({ values: options } = parseArgs({
      args: argv,
      options: { install: { type: 'string' }, force: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    }));
  } catch (error) {
    return printError(2, 'usage', `jevway skill: ${(error as Error).message}`, 'jevway skill --install <dir> [--force]');
  }
  if (options.help) {
    await print(`${USAGE}\n`);
    return 0;
  }
  if (options.install === undefined) {
    await print(readFileSync(join(bundledSkillDir(), 'SKILL.md'), 'utf8'));
    return 0;
  }
  const result = installSkill(bundledSkillDir(), options.install, { force: Boolean(options.force) });
  if (result.status === 'exists') {
    return printError(
      1,
      'skill_exists',
      `${result.path} already holds a different jevway skill (or a link to one); it was left as it is`,
      `Run again with --force to replace it with this version's skill: jevway skill --install ${options.install} --force`,
    );
  }
  await printJson({ ok: true, ...result });
  return 0;
};
