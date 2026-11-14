// PURE: read and edit vcstool `.repos` files without a YAML library.
//
// vcstool files are block-style YAML of one shape:
//
//   repositories:
//     <path>:
//       type: git
//       url: <url>
//       version: <branch | tag | commit>   # optional
//
// The parser keeps where every value sits, so edits (lock, unlock, add an entry)
// replace or insert single lines and leave order, comments, quoting and line
// endings exactly as they were. Anything outside that shape (flow style `{}`,
// anchors, tabs, multi-line values) is refused with a message rather than guessed.

export interface ValueSpan {
  /** 0-based line index. */
  line: number;
  /** Column where the value (including any quote) starts. */
  start: number;
  /** Column just after the value (including any closing quote). */
  end: number;
  quote: '' | "'" | '"';
}

export interface ReposEntry {
  /** The key: a path relative to the import (target) folder. */
  name: string;
  type?: string;
  url?: string;
  version?: string;
  /** Text of the comment after the version value, without `#` (for example `locked: jazzy`). */
  versionComment?: string;
  /** Line of `<name>:`. */
  line: number;
  /** Last line that belongs to the entry (its last field, or the key line). */
  lastLine: number;
  /** Indentation of the entry's fields (falls back to key indent + 2). */
  fieldIndent: number;
  spans: { type?: ValueSpan; url?: ValueSpan; version?: ValueSpan };
}

export interface ReposFile {
  entries: ReposEntry[];
  /** Line of `repositories:`. */
  repositoriesLine: number;
  /** Indentation used for entry keys (2 if the block is empty). */
  entryIndent: number;
  /** Last line of the repositories block (its last non-blank line). */
  lastLine: number;
  eol: '\n' | '\r\n';
  lines: string[];
}

export type ParseResult = { ok: true; file: ReposFile } | { ok: false; error: string; line?: number };

/** The comment Lock writes after a version it pinned: `# locked: <branch it replaced>`. */
export const LOCK_MARKER = 'locked:';

const KEY_RE = /^( *)((?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"][^:#]*?))\s*:(?:\s+(.*))?$/;

function stripComment(rest: string): { value: string; comment?: string; valueEnd: number } {
  // rest starts at the value. A comment starts at " #" outside quotes.
  const q = rest[0];
  if (q === '"' || q === "'") {
    let i = 1;
    while (i < rest.length) {
      if (q === '"' && rest[i] === '\\') {
        i += 2;
        continue;
      }
      if (rest[i] === q) {
        if (q === "'" && rest[i + 1] === "'") {
          i += 2;
          continue;
        }
        break;
      }
      i++;
    }
    const valueEnd = Math.min(i + 1, rest.length);
    const after = rest.slice(valueEnd);
    const m = /^\s*#\s?(.*)$/.exec(after);
    return { value: rest.slice(0, valueEnd), comment: m ? m[1].trimEnd() : undefined, valueEnd };
  }
  const hash = rest.search(/\s#/);
  if (hash < 0) return { value: rest.trimEnd(), valueEnd: rest.trimEnd().length };
  const value = rest.slice(0, hash).trimEnd();
  const comment = rest.slice(hash).replace(/^\s*#\s?/, '').trimEnd();
  return { value, comment, valueEnd: value.length };
}

function unquote(raw: string): { text: string; quote: '' | "'" | '"' } {
  if (raw.length >= 2 && raw[0] === '"' && raw.endsWith('"')) {
    return { text: raw.slice(1, -1).replace(/\\(["\\])/g, '$1'), quote: '"' };
  }
  if (raw.length >= 2 && raw[0] === "'" && raw.endsWith("'")) {
    return { text: raw.slice(1, -1).replace(/''/g, "'"), quote: "'" };
  }
  return { text: raw, quote: '' };
}

const isBlankOrComment = (l: string) => /^\s*(#.*)?$/.test(l);

export function parseReposFile(text: string): ParseResult {
  const eol: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    if (/^\t| \t/.test(lines[i]) && !isBlankOrComment(lines[i])) {
      return { ok: false, error: 'Tabs are not allowed for indentation in YAML.', line: i };
    }
  }

  const repositoriesLine = lines.findIndex((l) => /^repositories\s*:\s*(#.*)?$/.test(l));
  if (repositoriesLine < 0) {
    if (lines.some((l) => /^repositories\s*:\s*\{/.test(l))) {
      return { ok: false, error: 'Flow style ("repositories: {...}") is not supported. Use the block style that "vcs export" writes.' };
    }
    return { ok: false, error: 'No "repositories:" section found.' };
  }

  const entries: ReposEntry[] = [];
  let entryIndent = -1;
  let current: ReposEntry | undefined;
  let lastLine = repositoriesLine;

  for (let i = repositoriesLine + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (isBlankOrComment(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) break; // next top-level key ends the block
    const m = KEY_RE.exec(raw);
    if (!m) {
      return { ok: false, error: `Cannot read this line: "${raw.trim()}". Only "key: value" lines are supported.`, line: i };
    }
    const keyRaw = m[2].trim();
    const rest = m[3] ?? '';
    if (/^[{[&*|>]/.test(rest)) {
      return { ok: false, error: `Unsupported YAML on this line (flow style, anchor or multi-line value): "${raw.trim()}".`, line: i };
    }
    if (entryIndent < 0) entryIndent = indent;

    if (indent === entryIndent) {
      const restValue = stripComment(rest).value;
      if (restValue !== '') {
        return { ok: false, error: `Expected a repository path followed by ":" on this line: "${raw.trim()}".`, line: i };
      }
      current = {
        name: unquote(keyRaw).text,
        line: i,
        lastLine: i,
        fieldIndent: indent + 2,
        spans: {},
      };
      entries.push(current);
      lastLine = i;
      continue;
    }
    if (indent < entryIndent) {
      return { ok: false, error: `Wrong indentation on this line: "${raw.trim()}".`, line: i };
    }
    if (!current) {
      return { ok: false, error: `A field outside any repository: "${raw.trim()}".`, line: i };
    }
    if (current.lastLine === current.line) current.fieldIndent = indent;
    current.lastLine = i;
    lastLine = i;
    if (indent !== current.fieldIndent) continue; // deeper nesting is not part of vcstool's format; keep it untouched

    const field = keyRaw;
    if (field !== 'type' && field !== 'url' && field !== 'version') continue;
    const valueStart = raw.length - rest.length;
    const { value, comment, valueEnd } = stripComment(rest);
    const { text: v, quote } = unquote(value);
    const span: ValueSpan = { line: i, start: valueStart, end: valueStart + valueEnd, quote };
    current.spans[field] = span;
    current[field] = v;
    if (field === 'version') current.versionComment = comment;
  }

  return {
    ok: true,
    file: { entries, repositoriesLine, entryIndent: entryIndent < 0 ? 2 : entryIndent, lastLine, eol, lines },
  };
}

/** A full or abbreviated commit hash (7–40 hex digits). */
export function isCommitHash(version: string | undefined): boolean {
  return !!version && /^[0-9a-f]{7,40}$/i.test(version);
}

/** The branch a Lock replaced, read from the `# locked: <branch>` comment; undefined when not locked by us. */
export function lockedFrom(entry: ReposEntry): string | undefined {
  const c = entry.versionComment?.trim();
  if (!c?.startsWith(LOCK_MARKER)) return undefined;
  const branch = c.slice(LOCK_MARKER.length).trim();
  return branch || undefined;
}

/** Quote a value for YAML when a plain scalar would change its meaning. */
export function yamlScalar(value: string, prefer: '' | "'" | '"' = ''): string {
  if (prefer === "'") return `'${value.replace(/'/g, "''")}'`;
  if (prefer === '"') return `"${value.replace(/(["\\])/g, '\\$1')}"`;
  const needsQuote =
    value === '' ||
    /^[\s]|[\s]$/.test(value) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    /: |\s#/.test(value) ||
    /^(true|false|yes|no|on|off|null|~)$/i.test(value) ||
    /^[-+]?(\d[\d_]*)?(\.\d*)?([eE][-+]?\d+)?$/.test(value);
  return needsQuote ? `'${value.replace(/'/g, "''")}'` : value;
}

export interface VersionEdit {
  version: string;
  /** Comment to put after the value (without `#`); null removes an existing comment; undefined keeps it. */
  comment?: string | null;
}

/**
 * Write new versions into the file text. Only the version values (and their comments) change;
 * an entry without a `version:` line gets one after its last field. Unknown names are ignored.
 */
export function setVersions(file: ReposFile, edits: ReadonlyMap<string, VersionEdit>): string {
  const lines = [...file.lines];
  const inserts: { after: number; text: string }[] = [];
  for (const entry of file.entries) {
    const edit = edits.get(entry.name);
    if (!edit) continue;
    const span = entry.spans.version;
    if (span) {
      const line = lines[span.line];
      const value = yamlScalar(edit.version, span.quote);
      let tail = line.slice(span.end);
      if (edit.comment === null) tail = '';
      else if (edit.comment !== undefined) tail = `  # ${edit.comment}`;
      lines[span.line] = line.slice(0, span.start) + value + tail;
    } else {
      const comment = edit.comment ? `  # ${edit.comment}` : '';
      inserts.push({ after: entry.lastLine, text: `${' '.repeat(entry.fieldIndent)}version: ${yamlScalar(edit.version)}${comment}` });
    }
  }
  for (const ins of inserts.sort((a, b) => b.after - a.after)) lines.splice(ins.after + 1, 0, ins.text);
  return lines.join(file.eol);
}

/** Append a repository at the end of the repositories block, in the file's own indentation. */
export function addEntry(file: ReposFile, entry: { name: string; type: string; url: string; version?: string }): string {
  const lines = [...file.lines];
  const ind = ' '.repeat(file.entryIndent);
  const field = ' '.repeat(file.entries[0] ? file.entries[0].fieldIndent : file.entryIndent + 2);
  const block = [
    `${ind}${yamlScalar(entry.name)}:`,
    `${field}type: ${yamlScalar(entry.type)}`,
    `${field}url: ${yamlScalar(entry.url)}`,
    ...(entry.version ? [`${field}version: ${yamlScalar(entry.version)}`] : []),
  ];
  lines.splice(file.lastLine + 1, 0, ...block);
  return lines.join(file.eol);
}
