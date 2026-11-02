import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const json = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const pkg = json('package.json');

describe('the npm package', () => {
  it('installs the commands jevway and jevway-mcp on Node 24 or later', () => {
    expect(pkg).toMatchObject({
      name: 'jevway',
      bin: { jevway: 'dist/cli/main.js', 'jevway-mcp': 'dist/mcp.js' },
      engines: { node: '>=24' },
      license: 'MIT',
    });
  });

  it('ships the built code, the skill and the install guide for agents, and nothing from verify/ or test/', () => {
    expect(pkg.files).toEqual(expect.arrayContaining(['dist', 'skill', 'INSTALL-FOR-AGENTS.md']));
    expect(pkg.files.join(' ')).not.toMatch(/verify|test|src/);
    expect(existsSync(new URL('../INSTALL-FOR-AGENTS.md', import.meta.url))).toBe(true);
  });

  it('points npm at the GitHub repository, its issues and its README', () => {
    expect(pkg.repository).toEqual({ type: 'git', url: 'git+https://github.com/AbdallahAHO/jevway.git' });
    expect(pkg.homepage).toBe('https://github.com/AbdallahAHO/jevway#readme');
    expect(pkg.bugs).toEqual({ url: 'https://github.com/AbdallahAHO/jevway/issues' });
    expect(pkg.keywords).toEqual(expect.arrayContaining(['mcp', 'browser-automation', 'jev']));
  });

  it('typechecks, tests and builds from a clean dist/ before every publish', () => {
    expect(pkg.scripts.prepublishOnly).toMatch(/typecheck.*test.*rm -rf dist.*build/);
  });
});

describe('the Claude Code plugin', () => {
  const plugin = json('.claude-plugin/plugin.json');
  const marketplace = json('.claude-plugin/marketplace.json');

  it('is listed by a marketplace named jevway, so `/plugin install jevway@jevway` works', () => {
    expect(marketplace.name).toBe('jevway');
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: 'jevway', source: './', version: pkg.version })]);
    expect(plugin).toMatchObject({ name: 'jevway', version: pkg.version, license: 'MIT' });
  });

  it('starts the published MCP server through npx, a command the package ships', () => {
    expect(plugin.mcpServers).toEqual({ jevway: { command: 'npx', args: ['-y', '-p', 'jevway', 'jevway-mcp'] } });
    expect(pkg.bin['jevway-mcp']).toBeDefined();
  });

  it('brings the skill from skill/jevway instead of a copy', () => {
    expect(plugin.skills).toEqual(['./skill/jevway']);
    expect(readFileSync(new URL('../skill/jevway/SKILL.md', import.meta.url), 'utf8')).toMatch(/^---\nname: jevway\n/);
  });
});

describe('releases', () => {
  const config = json('release-please-config.json');
  const root = config.packages['.'];

  it('start from the published version, so the next release PR bumps from it', () => {
    expect(json('.release-please-manifest.json')).toEqual({ '.': pkg.version });
  });

  it('bump both plugin manifests with package.json, so the plugin never points at an older version', () => {
    expect(root['extra-files']).toEqual([
      { type: 'json', path: '.claude-plugin/plugin.json', jsonpath: '$.version' },
      { type: 'json', path: '.claude-plugin/marketplace.json', jsonpath: '$.plugins[0].version' },
    ]);
  });

  it('bump the minor for a feat or a breaking change until 1.0, and tag as v<version>', () => {
    expect(root).toMatchObject({ 'release-type': 'node', 'bump-minor-pre-major': true, 'bump-patch-for-minor-pre-major': false });
    expect(config['include-component-in-tag']).toBe(false);
  });
});
