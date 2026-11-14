import { describe, it, expect } from 'vitest';
import { addEntry, isCommitHash, lockedFrom, parseReposFile, setVersions, yamlScalar, type ReposFile } from '../reposFile.js';

const SAMPLE = `# Eurobot workspace
repositories:
  hmi:
    type: git
    url: git@github.com:HMU-Robotics/hmi.git
    version: jazzy
  # third-party
  ruckig:
    type: git
    url: git@github.com:pantor/ruckig.git
    version: 37b6e7a4c60f5befd2506741d5f7d0ae7eefb3db  # keep this pin
  sllidar_ros2:
    type: git
    url: https://github.com/Slamtec/sllidar_ros2.git
    version: '34300099fadfc772965962dec837bf436706188f'
  "quoted name":
    type: hg
    url: https://example.com/x
`;

function parse(text: string): ReposFile {
  const r = parseReposFile(text);
  if (!r.ok) throw new Error(r.error);
  return r.file;
}

describe('parseReposFile', () => {
  it('reads every entry with type, url, version and comments', () => {
    const f = parse(SAMPLE);
    expect(f.entries.map((e) => [e.name, e.type, e.url, e.version])).toEqual([
      ['hmi', 'git', 'git@github.com:HMU-Robotics/hmi.git', 'jazzy'],
      ['ruckig', 'git', 'git@github.com:pantor/ruckig.git', '37b6e7a4c60f5befd2506741d5f7d0ae7eefb3db'],
      ['sllidar_ros2', 'git', 'https://github.com/Slamtec/sllidar_ros2.git', '34300099fadfc772965962dec837bf436706188f'],
      ['quoted name', 'hg', 'https://example.com/x', undefined],
    ]);
    expect(f.entries[1].versionComment).toBe('keep this pin');
    expect(f.entries[2].spans.version?.quote).toBe("'");
    expect(f.entryIndent).toBe(2);
    expect(f.entries[0].fieldIndent).toBe(4);
  });

  it('keeps CRLF line endings', () => {
    expect(parse(SAMPLE.replace(/\n/g, '\r\n')).eol).toBe('\r\n');
  });

  it('stops at the next top-level key', () => {
    const f = parse(`repositories:\n  a:\n    type: git\n    url: u\nother:\n  b: 1\n`);
    expect(f.entries.map((e) => e.name)).toEqual(['a']);
    expect(f.lastLine).toBe(3);
  });

  it('accepts an empty repositories block', () => {
    expect(parse('repositories:\n').entries).toEqual([]);
  });

  it.each([
    ['no section', 'foo: bar\n', /No "repositories:"/],
    ['flow style', 'repositories: {a: {type: git}}\n', /Flow style/],
    ['flow entry', 'repositories:\n  a: {type: git}\n', /Unsupported YAML/],
    ['tabs', 'repositories:\n\ta:\n', /Tabs/],
    ['anchor', 'repositories:\n  a:\n    url: &x u\n', /Unsupported YAML/],
  ])('refuses %s', (_name, text, msg) => {
    const r = parseReposFile(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(msg);
  });
});

describe('isCommitHash / lockedFrom', () => {
  it('recognises 7–40 hex digits only', () => {
    expect(isCommitHash('37b6e7a')).toBe(true);
    expect(isCommitHash('37b6e7a4c60f5befd2506741d5f7d0ae7eefb3db')).toBe(true);
    expect(isCommitHash('jazzy')).toBe(false);
    expect(isCommitHash('abc12')).toBe(false);
    expect(isCommitHash(undefined)).toBe(false);
  });

  it('reads the branch from the lock comment', () => {
    const f = parse('repositories:\n  a:\n    version: 0123456789abcdef  # locked: jazzy\n  b:\n    version: 0123456789abcdef  # pin\n');
    expect(lockedFrom(f.entries[0])).toBe('jazzy');
    expect(lockedFrom(f.entries[1])).toBeUndefined();
  });
});

describe('yamlScalar', () => {
  it('quotes only when a plain scalar would change meaning', () => {
    expect(yamlScalar('jazzy')).toBe('jazzy');
    expect(yamlScalar('37b6e7a4c60f')).toBe('37b6e7a4c60f');
    expect(yamlScalar('1234567')).toBe("'1234567'");
    expect(yamlScalar('703736e4')).toBe("'703736e4'"); // reads as a number in YAML
    expect(yamlScalar('true')).toBe("'true'");
    expect(yamlScalar("it's")).toBe("it's");
    expect(yamlScalar('a: b')).toBe("'a: b'");
    expect(yamlScalar('x', '"')).toBe('"x"');
  });
});

describe('setVersions', () => {
  it('changes only the version values and keeps comments, quotes and order', () => {
    const f = parse(SAMPLE);
    const out = setVersions(
      f,
      new Map([
        ['hmi', { version: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', comment: 'locked: jazzy' }],
        ['sllidar_ros2', { version: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }],
      ]),
    );
    const lines = out.split('\n');
    expect(lines[5]).toBe('    version: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  # locked: jazzy');
    expect(lines[14]).toBe("    version: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'");
    // everything else is byte-for-byte the same
    const before = SAMPLE.split('\n');
    lines.forEach((l, i) => {
      if (i !== 5 && i !== 14) expect(l).toBe(before[i]);
    });
  });

  it('keeps an existing comment when the edit does not mention it, and removes it with null', () => {
    const f = parse(SAMPLE);
    const keep = setVersions(f, new Map([['ruckig', { version: 'cccccccc' }]])).split('\n')[10];
    expect(keep).toBe('    version: cccccccc  # keep this pin');
    const drop = setVersions(f, new Map([['ruckig', { version: 'main', comment: null }]])).split('\n')[10];
    expect(drop).toBe('    version: main');
  });

  it('adds a version line to an entry that has none', () => {
    const f = parse(SAMPLE);
    const out = setVersions(f, new Map([['quoted name', { version: 'default' }]]));
    expect(out.split('\n').slice(-3)).toEqual(['    url: https://example.com/x', '    version: default', '']);
  });

  it('round-trips CRLF', () => {
    const f = parse(SAMPLE.replace(/\n/g, '\r\n'));
    const out = setVersions(f, new Map([['hmi', { version: 'humble' }]]));
    expect(out).toBe(SAMPLE.replace('version: jazzy', 'version: humble').replace(/\n/g, '\r\n'));
  });
});

describe('addEntry', () => {
  it('appends at the end of the block in the file indentation', () => {
    const f = parse('repositories:\n  a:\n    type: git\n    url: u\n\nother: 1\n');
    const out = addEntry(f, { name: 'new_pkg', type: 'git', url: 'git@x:y/new_pkg.git', version: 'main' });
    expect(out).toBe('repositories:\n  a:\n    type: git\n    url: u\n  new_pkg:\n    type: git\n    url: git@x:y/new_pkg.git\n    version: main\n\nother: 1\n');
  });

  it('works on an empty block', () => {
    const out = addEntry(parse('repositories:\n'), { name: 'x', type: 'git', url: 'u' });
    expect(out).toBe('repositories:\n  x:\n    type: git\n    url: u\n');
  });
});
