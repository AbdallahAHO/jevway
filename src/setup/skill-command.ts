import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { print, printError, printJson } from './command-output.ts';

export const SKILL_USAGE = `Examples:
  jevway skill
  jevway skill --install ~/.claude/skills

jevway skill [--name jevway-inbox]       print the SKILL.md this version ships (default jevway)
jevway skill --install <dir> [--force]   copy both skill folders into <dir>/jevway and <dir>/jevway-inbox

Examples:
  jevway skill --install ~/.claude/skills
  jevway skill --install ~/.codex/skills

--install prints { ok, status: installed|unchanged|replaced, path, files } for jevway and the same for each skill in
skills: [{ name, … }]. jevway-inbox is a standalone disposable inbox script for agents without jevway. A different
skill already in either folder (or a symlink to one) is left alone, and nothing is copied, unless --force is given.`;

/** The skills this package ships, by folder name; `--install` copies them all. */
const BUNDLED_SKILLS = ['jevway', 'jevway-inbox'] as const;
type BundledSkill = (typeof BUNDLED_SKILLS)[number];

/** A `skill/<name>/` folder of the installed package: two levels up from both `src/setup/` and `dist/setup/`. */
const bundledSkillFolder = (name: BundledSkill) => fileURLToPath(new URL(`../../skill/${name}/`, import.meta.url));

/** The `skill/jevway/` folder of the installed package. */
export const bundledSkillDir = () => bundledSkillFolder('jevway');

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

/** Whether `<parent>/<name>` is missing, the same as `source`, or something else (a different skill or a symlink to one). */
export const skillState = (source: string, parent: string, name = 'jevway'): 'missing' | 'same' | 'different' => {
  const path = join(parent, name);
  if (!existsSync(path) && !lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return 'missing';
  return sameFolder(source, path) ? 'same' : 'different';
};

export type SkillInstall =
  | { status: 'installed' | 'unchanged' | 'replaced'; path: string; files: string[] }
  | { status: 'exists'; path: string };

/**
 * Copies `source` to `<parent>/<name>` (default `jevway`). An identical copy is left as it is; a different folder or a
 * symlink is replaced only with `force` (a symlink is removed, never its target). The copy lands under a temporary
 * name first, so an interrupted install never leaves half a skill.
 *
 * @example
 * installSkill(bundledSkillDir(), '/Users/ada/.claude/skills', { force: false })
 * // { status: 'installed', path: '/Users/ada/.claude/skills/jevway', files: ['SKILL.md'] }
 */
export const installSkill = (source: string, parent: string, { force, name = 'jevway' }: { force: boolean; name?: string }): SkillInstall => {
  const path = join(parent, name);
  const files = filesIn(source);
  const state = skillState(source, parent, name);
  if (state === 'same') return { status: 'unchanged', path, files };
  if (state === 'different' && !force) return { status: 'exists', path };
  const present = state === 'different';
  mkdirSync(parent, { recursive: true });
  const incoming = join(parent, `.${name}-${process.pid}.incoming`);
  cpSync(source, incoming, { recursive: true });
  if (present) rmSync(path, { recursive: true, force: true });
  renameSync(incoming, path);
  return { status: present ? 'replaced' : 'installed', path, files };
};

/**
 * Installs every bundled skill into `parent`, or none: a different folder for any of them, without `force`, is
 * `exists` with its path and nothing is copied.
 */
export const installSkills = (parent: string, { force }: { force: boolean }) => {
  const different = BUNDLED_SKILLS.filter((name) => skillState(bundledSkillFolder(name), parent, name) === 'different');
  if (different.length && !force) return { status: 'exists' as const, paths: different.map((name) => join(parent, name)) };
  return {
    status: 'done' as const,
    skills: BUNDLED_SKILLS.map((name) => ({ name, ...(installSkill(bundledSkillFolder(name), parent, { force, name }) as Exclude<SkillInstall, { status: 'exists' }>) })),
  };
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
      options: { install: { type: 'string' }, name: { type: 'string' }, force: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    }));
  } catch (error) {
    return printError(2, 'usage', `jevway skill: ${(error as Error).message}`, 'jevway skill --install <dir> [--force]');
  }
  if (options.help) {
    await print(`${SKILL_USAGE}\n`);
    return 0;
  }
  if (options.install === undefined) {
    const name = options.name ?? 'jevway';
    if (!BUNDLED_SKILLS.includes(name as BundledSkill)) {
      return printError(2, 'usage', `jevway skill: --name must be ${BUNDLED_SKILLS.join(' or ')}, got "${name}"`, 'jevway skill --name jevway-inbox');
    }
    await print(readFileSync(join(bundledSkillFolder(name as BundledSkill), 'SKILL.md'), 'utf8'));
    return 0;
  }
  const result = installSkills(options.install, { force: Boolean(options.force) });
  if (result.status === 'exists') {
    return printError(
      1,
      'skill_exists',
      `${result.paths.join(' and ')} already ${result.paths.length === 1 ? 'holds a different skill' : 'hold different skills'} (or a link to one); nothing was copied`,
      `Run again with --force to replace them with this version's skills: jevway skill --install ${options.install} --force`,
    );
  }
  const [{ name: _name, ...jevway }] = result.skills;
  await printJson({ ok: true, ...jevway, skills: result.skills });
  return 0;
};
