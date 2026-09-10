

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { MemoryItem, MemoryType } from './types';

export const STATIC_MEMORY_FILENAME = 'MEMORY.md';
export const STATIC_MEMORY_DIR = 'memory';

export const STATIC_MEMORY_SCAFFOLD_MARKER = '.memosync-scaffolded';

export const STATIC_MEMORY_MAX_FILE_CHARS = 24_000;
export const STATIC_MEMORY_MAX_FILES = 20;

export const STUDY_STATIC_MEMORY_MAX_FILES = 128;
export const STUDY_STATIC_MEMORY_MAX_TOTAL_BYTES = 512 * 1024;

export interface StaticMemoryFile {

  relPath: string;

  content: string;

  participantContent?: string;
  truncated?: boolean;
}

export interface StaticFocusSourceSlice {

  readonly relPath: string;

  readonly injectedContent: string;

  readonly contentHash: string;

  readonly truncated: boolean;

  readonly start: number;
  readonly end: number;
}

export interface StaticFocusPayload {

  readonly text: string;

  readonly sources: readonly StaticFocusSourceSlice[];
}

function freezeStaticFocusPayload(text: string, sources: StaticFocusSourceSlice[]): StaticFocusPayload {
  const frozenSources = Object.freeze(sources.map((source) => Object.freeze(source)));
  return Object.freeze({ text, sources: frozenSources });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

class StudyStaticMemoryReadError extends Error {}

const TYPE_SECTIONS: Array<[MemoryType, string]> = [
  ['preference', 'Preferences'],
  ['constraint', 'Constraints'],
  ['lesson', 'Lessons'],
  ['fact', 'Facts'],
];


export function ensureStaticMemoryScaffold(workspaceDir: string, seeds: MemoryItem[] = []): boolean {
  try {
    const markerPath = join(workspaceDir, STATIC_MEMORY_SCAFFOLD_MARKER);
    if (existsSync(markerPath)) return false;
    const path = join(workspaceDir, STATIC_MEMORY_FILENAME);
    mkdirSync(workspaceDir, { recursive: true });
    if (existsSync(path)) {
      writeFileSync(markerPath, `${new Date().toISOString()} adopted existing file\n`, 'utf-8');
      return false;
    }

    const lines: string[] = [
      '# Memory',
      '',
      '<!-- Notes the assistant reads at the start of every turn. Edit freely:',
      '     add, rewrite, or delete anything — changes apply from your next',
      '     message. You can also split notes into memory/*.md files. -->',
      '',
    ];
    for (const [type, section] of TYPE_SECTIONS) {
      lines.push(`## ${section}`);
      for (const item of seeds.filter((s) => s.type === type)) {
        lines.push(`- ${item.content}`);
      }
      lines.push('');
    }

    writeFileSync(path, lines.join('\n'), 'utf-8');
    writeFileSync(markerPath, `${new Date().toISOString()} scaffold generated\n`, 'utf-8');
    return true;
  } catch (error) {
    console.warn(`[memory] static scaffold failed in ${workspaceDir}:`, error);
    return false;
  }
}


export function readStaticMemoryFiles(workspaceDir: string): StaticMemoryFile[] {
  return readStaticMemoryFilesInternal(workspaceDir, false);
}


export function readStudyStaticMemoryFiles(workspaceDir: string): StaticMemoryFile[] {
  return readStaticMemoryFilesInternal(workspaceDir, true);
}

function readStaticMemoryFilesInternal(workspaceDir: string, studyExact: boolean): StaticMemoryFile[] {
  const files: StaticMemoryFile[] = [];
  let studyTotalBytes = 0;
  const push = (relPath: string, absPath: string) => {
    if (!studyExact && files.length >= STATIC_MEMORY_MAX_FILES) return;
    try {
      if (studyExact) {
        if (files.length >= STUDY_STATIC_MEMORY_MAX_FILES) {
          throw new StudyStaticMemoryReadError(
            `Study Static memory representation exceeds the safety limit of ${STUDY_STATIC_MEMORY_MAX_FILES} files`,
          );
        }
        const info = lstatSync(absPath);
        if (info.isSymbolicLink()) {
          throw new StudyStaticMemoryReadError(`Study Static memory path is a symbolic link (${relPath})`);
        }
        if (!info.isFile()) {
          throw new StudyStaticMemoryReadError(`Study Static memory path is not a regular file (${relPath})`);
        }
      }
      let content: string;
      if (studyExact) {
        const bytes = readFileSync(absPath);
        if (studyTotalBytes + bytes.byteLength > STUDY_STATIC_MEMORY_MAX_TOTAL_BYTES) {
          throw new StudyStaticMemoryReadError(
            `Study Static memory representation exceeds the safety limit of ${STUDY_STATIC_MEMORY_MAX_TOTAL_BYTES} bytes`,
          );
        }
        try {
          content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
          throw new StudyStaticMemoryReadError(`Study Static memory file has invalid UTF-8 (${relPath})`);
        }
        studyTotalBytes += bytes.byteLength;
      } else {
        content = readFileSync(absPath, 'utf-8');
      }
      let participantContent: string | undefined;
      let truncated = false;
      if (!studyExact && content.length > STATIC_MEMORY_MAX_FILE_CHARS) {
        participantContent = content.slice(0, STATIC_MEMORY_MAX_FILE_CHARS);
        content = `${participantContent}\n\n<!-- truncated: file exceeds the injection size limit -->`;
        truncated = true;
      }
      files.push({ relPath, content, ...(participantContent === undefined ? {} : { participantContent }), truncated });
    } catch (error) {
      if (studyExact) {
        if (error instanceof StudyStaticMemoryReadError) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw new StudyStaticMemoryReadError(`Study Static memory file is unreadable (${relPath}): ${detail}`);
      }
      console.warn(`[memory] skipping unreadable static memory file ${relPath}:`, error);
    }
  };

  const rootPath = join(workspaceDir, STATIC_MEMORY_FILENAME);
  if (studyExact) {
    try {
      lstatSync(rootPath);
      push(STATIC_MEMORY_FILENAME, rootPath);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
  } else if (existsSync(rootPath)) push(STATIC_MEMORY_FILENAME, rootPath);

  const dirPath = join(workspaceDir, STATIC_MEMORY_DIR);
  const readMemoryDirectory = () => {
    if (studyExact) {
      let directoryInfo;
      try {
        directoryInfo = lstatSync(dirPath);
      } catch (error) {
        if (isMissingPath(error)) return;
        throw error;
      }
      if (directoryInfo.isSymbolicLink()) {
        throw new StudyStaticMemoryReadError(`Study Static memory path is a symbolic link (${STATIC_MEMORY_DIR})`);
      }
      if (!directoryInfo.isDirectory()) {
        throw new StudyStaticMemoryReadError(`Study Static memory path is not a regular directory (${STATIC_MEMORY_DIR})`);
      }
    } else if (!existsSync(dirPath)) return;

    const names = readdirSync(dirPath)
      .filter((name) => name.endsWith('.md'))
      .sort();
    for (const name of names) push(`${STATIC_MEMORY_DIR}/${name}`, join(dirPath, name));
  };
  if (studyExact) {
    try {
      readMemoryDirectory();
    } catch (error) {
      if (error instanceof StudyStaticMemoryReadError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new StudyStaticMemoryReadError(`Study Static ${STATIC_MEMORY_DIR}/ directory is unreadable: ${detail}`);
    }
  } else {
    try {
      readMemoryDirectory();
    } catch (error) {
      console.warn(`[memory] skipping unreadable ${STATIC_MEMORY_DIR}/ directory:`, error);
    }
  }
  return files;
}


export function hashStaticMemoryFiles(files: StaticMemoryFile[]): string {

  let hash = 0x811c9dc5;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };
  for (const f of files) {
    feed(f.relPath);
    feed('\0');
    feed(f.content);
    feed('\0');
  }
  return hash.toString(16);
}


export function buildStaticFocusPayload(files: StaticMemoryFile[]): StaticFocusPayload {
  return buildStaticFocusPayloadInternal(files, false);
}


export function buildStudyStaticFocusPayload(files: StaticMemoryFile[]): StaticFocusPayload {
  return buildStaticFocusPayloadInternal(files, true);
}

function buildStaticFocusPayloadInternal(
  files: StaticMemoryFile[],
  studyExact: boolean,
): StaticFocusPayload {
  if (files.length === 0) return freezeStaticFocusPayload('', []);
  if (studyExact && files.some((file) => file.truncated || file.participantContent !== undefined)) {
    throw new Error('Study Static focus cannot be built from a truncated memory source');
  }
  const fileList = files.map((f) => f.relPath).join(', ');
  const parts: string[] = [
    '# Memory (workspace notes)',
    `You and the user SHARE standing notes — preferences, constraints, lessons, facts — in these workspace files: ${fileList}. ` +
      'They are read fresh at the start of every turn; treat them as instructions that apply across sessions.',


    '## Maintaining the notes\n' +
      'You maintain these files yourself, during the conversation, with your normal file tools (Edit/Write):\n' +
      '- When you learn something durable — a standing preference, a hard constraint, a lesson from a failure, ' +
      'a stable fact or pointer — update MEMORY.md RIGHT AWAY, in the same turn. Do not wait to be asked.\n' +
      '- Make 0 to 4 total memory entry changes per completed turn, counting additions and in-place revisions together. ' +
      'More is not better; change only what the turn supports. Revise an existing entry in place when its meaning changes, ' +
      'and leave an already-correct entry unchanged when the turn only reaffirms it.\n' +
      '- Keep every Markdown bullet or standalone entry to one atomic memory: one independently judgeable fact, preference, constraint, or lesson.\n' +
      '- Keep the file organized under short markdown headings (e.g. Preferences, Constraints, Project facts, Lessons); ' +
      'merge into existing sections rather than appending duplicates; rewrite entries that changed; delete ones the user retracts.\n' +
      '- After every memory edit, tell the user in ONE short line what you added or changed ' +
      '(e.g. "Noted in MEMORY.md: deploys go through staging."). The user sees the file live in their memory panel.\n' +
      '- If a note looks stale, wrong, or in conflict with the current request, say so — and fix the file once the user confirms.',
  ];
  let text = parts.join('\n');
  const sources: StaticFocusSourceSlice[] = [];
  for (const f of files) {
    text += `\n\n## ${f.relPath}\n`;
    const deliveredContent = studyExact ? f.content : f.content.trim();
    const injectedContent = studyExact ? f.content : (f.participantContent ?? f.content).trim();
    const start = text.length;
    text += deliveredContent;
    sources.push({
      relPath: f.relPath,
      injectedContent,
      contentHash: sha256(injectedContent),
      truncated: f.truncated === true,
      start,
      end: start + injectedContent.length,
    });
  }
  return freezeStaticFocusPayload(text, sources);
}

export function buildStaticMemoryBlock(files: StaticMemoryFile[]): string {
  return buildStaticFocusPayload(files).text;
}
