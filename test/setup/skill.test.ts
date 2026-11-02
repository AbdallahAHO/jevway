import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSkill } from '../../src/setup/skill-command.ts';
import { captureStdout } from './stdout.ts';

const bundled = readFileSync(new URL('../../skill/jevway/SKILL.md', import.meta.url), 'utf8');
const skillsFolder = () => mkdtempSync(join(tmpdir(), 'jevway-skills-'));

describe('jevway skill', () => {
  it('prints the SKILL.md this version ships', async () => {
    const { code, output } = await captureStdout(() => runSkill([]));
    expect(code).toBe(0);
    expect(output).toBe(bundled);
  });

  it('--install copies the skill folder into <dir>/jevway and says what it copied', async () => {
    const dir = skillsFolder();
    const { code, output } = await captureStdout(() => runSkill(['--install', dir]));
    expect(code).toBe(0);
    expect(JSON.parse(output)).toEqual({ ok: true, status: 'installed', path: join(dir, 'jevway'), files: ['SKILL.md'] });
    expect(readFileSync(join(dir, 'jevway', 'SKILL.md'), 'utf8')).toBe(bundled);
  });

  it('creates <dir> when it does not exist yet', async () => {
    const dir = join(skillsFolder(), 'nested', 'skills');
    const { code } = await captureStdout(() => runSkill(['--install', dir]));
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'jevway', 'SKILL.md'), 'utf8')).toBe(bundled);
  });

  it('installing the same skill again changes nothing', async () => {
    const dir = skillsFolder();
    await captureStdout(() => runSkill(['--install', dir]));
    const { code, output } = await captureStdout(() => runSkill(['--install', dir]));
    expect(code).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ ok: true, status: 'unchanged' });
  });

  it('refuses to overwrite a different jevway skill, naming --force, and leaves it as it was', async () => {
    const dir = skillsFolder();
    mkdirSync(join(dir, 'jevway'));
    writeFileSync(join(dir, 'jevway', 'SKILL.md'), 'my own edits');
    const { code, output } = await captureStdout(() => runSkill(['--install', dir]));
    expect(code).toBe(1);
    expect(JSON.parse(output)).toEqual({
      ok: false,
      error: { code: 'skill_exists', message: expect.stringContaining(join(dir, 'jevway')), hint: expect.stringContaining('--force') },
    });
    expect(readFileSync(join(dir, 'jevway', 'SKILL.md'), 'utf8')).toBe('my own edits');
  });

  it('--force replaces a different one', async () => {
    const dir = skillsFolder();
    mkdirSync(join(dir, 'jevway'));
    writeFileSync(join(dir, 'jevway', 'SKILL.md'), 'old');
    writeFileSync(join(dir, 'jevway', 'notes.md'), 'stale');
    const { code, output } = await captureStdout(() => runSkill(['--install', dir, '--force']));
    expect(code).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ ok: true, status: 'replaced', files: ['SKILL.md'] });
    expect(readFileSync(join(dir, 'jevway', 'SKILL.md'), 'utf8')).toBe(bundled);
    expect(() => lstatSync(join(dir, 'jevway', 'notes.md'))).toThrow();
  });

  it('treats a symlinked jevway folder as different, and --force replaces the link, never its target', async () => {
    const dir = skillsFolder();
    const elsewhere = skillsFolder();
    writeFileSync(join(elsewhere, 'SKILL.md'), 'linked skill');
    symlinkSync(elsewhere, join(dir, 'jevway'));
    expect((await captureStdout(() => runSkill(['--install', dir]))).code).toBe(1);
    expect(readlinkSync(join(dir, 'jevway'))).toBe(elsewhere);

    expect((await captureStdout(() => runSkill(['--install', dir, '--force']))).code).toBe(0);
    expect(lstatSync(join(dir, 'jevway')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(elsewhere, 'SKILL.md'), 'utf8')).toBe('linked skill');
  });

  it('a missing <dir> is a usage error with exit 2', async () => {
    const { code, output } = await captureStdout(() => runSkill(['--install']));
    expect(code).toBe(2);
    expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: 'usage' } });
  });
});
