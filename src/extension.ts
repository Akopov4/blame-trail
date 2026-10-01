import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

// ---------- Types ----------

interface LineBlame {
  hash: string;
  authorName: string;
  authorEmail: string;
  authorTimeSec: number;
  summary: string;
}

interface FileState {
  active: boolean;
  blameMap?: Map<number, LineBlame>;
}

// ---------- Module state ----------

const fileStates: Map<string, FileState> = new Map();
const reblameTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

let decorationType: vscode.TextEditorDecorationType;

const UNCOMMITTED_HASH = '0'.repeat(40);
const REBLAME_DEBOUNCE_MS = 100;
const BULK_EDIT_LINE_THRESHOLD = 5;

// ---------- Activation ----------

export function activate(context: vscode.ExtensionContext): void {
  decorationType = vscode.window.createTextEditorDecorationType({});

  context.subscriptions.push(
    vscode.commands.registerCommand('blameTrail.annotate', annotateCommand),
    vscode.commands.registerCommand('blameTrail.close', closeCommand),
    vscode.commands.registerCommand('blameTrail.copyRevision', copyRevisionCommand),
    vscode.commands.registerCommand('blameTrail.toggleRevisionOn', () => toggleSetting('showRevision')),
    vscode.commands.registerCommand('blameTrail.toggleRevisionOff', () => toggleSetting('showRevision')),
    vscode.commands.registerCommand('blameTrail.toggleDateOn', () => toggleSetting('showDate')),
    vscode.commands.registerCommand('blameTrail.toggleDateOff', () => toggleSetting('showDate')),
    vscode.commands.registerCommand('blameTrail.toggleAuthorOn', () => toggleSetting('showAuthor')),
    vscode.commands.registerCommand('blameTrail.toggleAuthorOff', () => toggleSetting('showAuthor')),
    vscode.commands.registerCommand('blameTrail.toggleIgnoreWhitespaceOn', () => toggleSetting('ignoreWhitespace')),
    vscode.commands.registerCommand('blameTrail.toggleIgnoreWhitespaceOff', () => toggleSetting('ignoreWhitespace')),

    vscode.workspace.onDidChangeConfiguration(onConfigChanged),
    vscode.workspace.onDidCloseTextDocument(onDocClosed),
    vscode.workspace.onDidChangeTextDocument(onDocChanged),
    vscode.window.onDidChangeActiveTextEditor(onActiveEditorChanged),
    decorationType
  );

  updateActiveContext(vscode.window.activeTextEditor);
}

export function deactivate(): void {
  for (const timer of reblameTimers.values()) {
    clearTimeout(timer);
  }
  reblameTimers.clear();
  fileStates.clear();
}

// ---------- Commands ----------

async function annotateCommand(uri?: vscode.Uri): Promise<void> {
  const editor = resolveEditor(uri);
  if (!editor) {
    return;
  }
  const doc = editor.document;
  if (doc.uri.scheme !== 'file') {
    return;
  }

  const filePath = doc.uri.fsPath;
  const cwd = path.dirname(filePath);

  const tracked = await isFileTrackedByGit(filePath, cwd);
  if (!tracked) {
    return;
  }

  const key = doc.uri.toString();
  const state: FileState = { active: true };
  fileStates.set(key, state);

  await refreshBlameForEditor(editor, state);
  updateActiveContext(editor);
}

function closeCommand(uri?: vscode.Uri): void {
  const editor = resolveEditor(uri);
  if (!editor) {
    return;
  }
  const key = editor.document.uri.toString();
  const timer = reblameTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    reblameTimers.delete(key);
  }
  const state = fileStates.get(key);
  if (state) {
    state.active = false;
    state.blameMap = undefined;
  }
  editor.setDecorations(decorationType, []);
  updateActiveContext(editor);
}

async function copyRevisionCommand(uri?: vscode.Uri, lineNumber?: number): Promise<void> {
  const editor = resolveEditor(uri);
  if (!editor) {
    return;
  }
  const key = editor.document.uri.toString();
  const state = fileStates.get(key);
  if (!state || !state.active || !state.blameMap) {
    return;
  }

  const line = typeof lineNumber === 'number' ? lineNumber - 1 : editor.selection.active.line;
  const info = state.blameMap.get(line);
  if (!info) {
    return;
  }
  await vscode.env.clipboard.writeText(info.hash);
}

function toggleSetting(section: 'showRevision' | 'showDate' | 'showAuthor' | 'ignoreWhitespace'): void {
  const config = vscode.workspace.getConfiguration('blameTrail');
  const current = config.get<boolean>(section, false);
  config.update(section, !current, vscode.ConfigurationTarget.Global);
}

// ---------- Context key / editor tracking ----------

function resolveEditor(uri?: vscode.Uri): vscode.TextEditor | undefined {
  if (uri) {
    const found = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === uri.toString()
    );
    if (found) {
      return found;
    }
  }
  return vscode.window.activeTextEditor;
}

function updateActiveContext(editor: vscode.TextEditor | undefined): void {
  const active = editor ? fileStates.get(editor.document.uri.toString())?.active ?? false : false;
  vscode.commands.executeCommand('setContext', 'blameTrail.active', active);
}

function onActiveEditorChanged(editor: vscode.TextEditor | undefined): void {
  updateActiveContext(editor);
}

function onConfigChanged(e: vscode.ConfigurationChangeEvent): void {
  if (!e.affectsConfiguration('blameTrail')) {
    return;
  }
  const reblameNeeded = e.affectsConfiguration('blameTrail.ignoreWhitespace');

  for (const editor of vscode.window.visibleTextEditors) {
    const key = editor.document.uri.toString();
    const state = fileStates.get(key);
    if (!state || !state.active) {
      continue;
    }
    if (reblameNeeded) {
      void refreshBlameForEditor(editor, state);
    } else {
      renderDecorationsForEditor(editor, state);
    }
  }
}

function onDocClosed(doc: vscode.TextDocument): void {
  const key = doc.uri.toString();
  const timer = reblameTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    reblameTimers.delete(key);
  }
  fileStates.delete(key);
}

// ---------- Edit tracking / debounce ----------

function isBulkEdit(e: vscode.TextDocumentChangeEvent): boolean {
  const totalLines = e.document.lineCount;
  let spanLines = 0;
  for (const change of e.contentChanges) {
    spanLines = Math.max(spanLines, change.range.end.line - change.range.start.line + 1, change.text.split('\n').length);
  }
  return spanLines > BULK_EDIT_LINE_THRESHOLD || spanLines >= totalLines * 0.5;
}

function isPureNewlineInsertion(e: vscode.TextDocumentChangeEvent): boolean {
  if (e.contentChanges.length !== 1) {
    return false;
  }
  const change = e.contentChanges[0];
  return change.rangeLength === 0 && /^\r?\n[ \t]*$/.test(change.text);
}

function onDocChanged(e: vscode.TextDocumentChangeEvent): void {
  const key = e.document.uri.toString();
  const state = fileStates.get(key);
  if (!state || !state.active) {
    return;
  }

  const editor = vscode.window.visibleTextEditors.find((ed) => ed.document.uri.toString() === key);

  if (isBulkEdit(e)) {
    state.blameMap = undefined;
    if (editor) {
      editor.setDecorations(decorationType, []);
    }
  }

  const existingTimer = reblameTimers.get(key);
  if (existingTimer) {
    clearTimeout(existingTimer);
    reblameTimers.delete(key);
  }

  const doRefresh = () => {
    reblameTimers.delete(key);
    const ed = vscode.window.visibleTextEditors.find((e2) => e2.document.uri.toString() === key);
    if (ed) {
      void refreshBlameForEditor(ed, state);
    }
  };

  if (isPureNewlineInsertion(e)) {
    doRefresh();
  } else {
    const timer = setTimeout(doRefresh, REBLAME_DEBOUNCE_MS);
    reblameTimers.set(key, timer);
  }
}

// ---------- Process helpers ----------

function execFileP(cmd: string, args: string[], opts: cp.ExecFileOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile(cmd, args, { ...opts, maxBuffer: 1024 * 1024 * 32 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout.toString());
    });
  });
}

function execFileWithStdin(
  cmd: string,
  args: string[],
  opts: cp.ExecFileOptions,
  input: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = cp.execFile(
      cmd,
      args,
      { ...opts, maxBuffer: 1024 * 1024 * 32 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout.toString());
      }
    );
    if (child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

async function isFileTrackedByGit(filePath: string, cwd: string): Promise<boolean> {
  try {
    await execFileP('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
    await execFileP('git', ['ls-files', '--error-unmatch', '--', path.basename(filePath)], { cwd });
    return true;
  } catch {
    return false;
  }
}

async function runGitBlame(
  filePath: string,
  cwd: string,
  ignoreWhitespace: boolean,
  contents: string
): Promise<string> {
  const args = ['blame', '--line-porcelain'];
  if (ignoreWhitespace) {
    args.push('-w');
  }
  args.push('--contents', '-', '--', path.basename(filePath));
  return execFileWithStdin('git', args, { cwd }, contents);
}

// ---------- Blame parsing ----------

function parseGitBlamePorcelain(output: string): Map<number, LineBlame> {
  const result = new Map<number, LineBlame>();
  const lines = output.split('\n');

  const commitInfo = new Map<string, Partial<LineBlame>>();
  let currentHash = '';
  let currentFinalLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) {
      continue;
    }

    const headerMatch = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(line);
    if (headerMatch) {
      currentHash = headerMatch[1];
      currentFinalLine = parseInt(headerMatch[3], 10);
      if (!commitInfo.has(currentHash)) {
        commitInfo.set(currentHash, { hash: currentHash });
      }
      continue;
    }

    if (line.startsWith('author ')) {
      const info = commitInfo.get(currentHash) ?? { hash: currentHash };
      info.authorName = line.slice('author '.length);
      commitInfo.set(currentHash, info);
      continue;
    }
    if (line.startsWith('author-mail ')) {
      const info = commitInfo.get(currentHash) ?? { hash: currentHash };
      info.authorEmail = line.slice('author-mail '.length).replace(/^<|>$/g, '');
      commitInfo.set(currentHash, info);
      continue;
    }
    if (line.startsWith('author-time ')) {
      const info = commitInfo.get(currentHash) ?? { hash: currentHash };
      info.authorTimeSec = parseInt(line.slice('author-time '.length), 10);
      commitInfo.set(currentHash, info);
      continue;
    }
    if (line.startsWith('summary ')) {
      const info = commitInfo.get(currentHash) ?? { hash: currentHash };
      info.summary = line.slice('summary '.length);
      commitInfo.set(currentHash, info);
      continue;
    }
    if (line.startsWith('\t')) {
      const info = commitInfo.get(currentHash);
      if (info && currentFinalLine > 0) {
        result.set(currentFinalLine - 1, {
          hash: info.hash ?? currentHash,
          authorName: info.authorName ?? '',
          authorEmail: info.authorEmail ?? '',
          authorTimeSec: info.authorTimeSec ?? 0,
          summary: info.summary ?? ''
        });
      }
      continue;
    }
    // other header fields (committer *, previous, boundary, filename) are ignored
  }

  return result;
}

// ---------- Rendering ----------

async function refreshBlameForEditor(editor: vscode.TextEditor, state: FileState): Promise<void> {
  const doc = editor.document;
  if (doc.uri.scheme !== 'file') {
    return;
  }
  const filePath = doc.uri.fsPath;
  const cwd = path.dirname(filePath);
  const config = vscode.workspace.getConfiguration('blameTrail');
  const ignoreWhitespace = config.get<boolean>('ignoreWhitespace', true);

  try {
    const output = await runGitBlame(filePath, cwd, ignoreWhitespace, doc.getText());
    state.blameMap = parseGitBlamePorcelain(output);
  } catch {
    state.blameMap = undefined;
  }

  const stillVisible = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === doc.uri.toString()
  );
  if (stillVisible) {
    renderDecorationsForEditor(stillVisible, state);
  }
}

function renderDecorationsForEditor(editor: vscode.TextEditor, state: FileState): void {
  if (!state.active || !state.blameMap) {
    editor.setDecorations(decorationType, []);
    return;
  }
  const config = vscode.workspace.getConfiguration('blameTrail');
  const options = buildDecorationOptions(editor, state.blameMap, config);
  editor.setDecorations(decorationType, options);
}

function isUncommitted(hash: string): boolean {
  return hash === UNCOMMITTED_HASH;
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function truncate(text: string, maxLen: number): string {
  if (maxLen <= 0) {
    return '';
  }
  if (text.length <= maxLen) {
    return text;
  }
  if (maxLen === 1) {
    return '…';
  }
  return text.slice(0, maxLen - 1) + '…';
}

function formatAuthorName(name: string, email: string, format: string): string {
  const safeEmail = isValidEmail(email) ? email : '';
  const safeName = (name || '').trim();

  const firstName = safeName.split(/\s+/)[0] || '';
  const nameParts = safeName.split(/\s+/).filter(Boolean);
  const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : '';
  const initials = nameParts.map((p) => p[0]?.toUpperCase() ?? '').join('');

  switch (format) {
    case 'Initials':
      return initials || safeEmail || safeName || 'Unknown';
    case 'Last Name':
      return lastName || safeName || safeEmail || 'Unknown';
    case 'E-mail':
      return safeEmail || safeName || 'Unknown';
    case 'First Name':
    default:
      return firstName || safeEmail || safeName || 'Unknown';
  }
}

function formatDate(epochSeconds: number, format: string): string {
  if (!epochSeconds) {
    return '';
  }
  const d = new Date(epochSeconds * 1000);
  const yyyy = String(d.getFullYear()).padStart(4, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');

  switch (format) {
    case 'YYYY/MM/DD':
      return `${yyyy}/${mm}/${dd}`;
    case 'MM/DD/YYYY':
      return `${mm}/${dd}/${yyyy}`;
    case 'MM-DD-YYYY':
      return `${mm}-${dd}-${yyyy}`;
    case 'YYYY-MM-DD':
    default:
      return `${yyyy}-${mm}-${dd}`;
  }
}

interface LineDisplay {
  text: string;
  info: LineBlame | undefined;
  isTrailingEmptyLine: boolean;
}

// Common monospace font names/families. `ch` (the width of the "0" glyph)
// is exact only in a monospace font, since every character shares that
// same advance width. For anything else we can't compute an exact pixel
// width from the extension side (no DOM access), so we fall back to a
// safety buffer instead of guessing a precise number.
const KNOWN_MONOSPACE_FONTS = [
  'consolas', 'menlo', 'monaco', 'courier', 'cascadia', 'fira code',
  'firacode', 'jetbrains mono', 'source code pro', 'hack', 'inconsolata',
  'sf mono', 'roboto mono', 'ubuntu mono', 'dejavu sans mono',
  'droid sans mono', 'lucida console', 'pt mono', 'ibm plex mono',
  'noto sans mono', 'liberation mono', 'anonymous pro', 'space mono',
  'courier new', 'monospace', 'mono'
];

function isLikelyMonospaceFont(fontFamily: string): boolean {
  const lower = fontFamily.toLowerCase();
  // editor.fontFamily is a comma-separated fallback list; the first
  // (primary) entry is what actually renders, so that's what we check.
  const primary = lower.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
  return KNOWN_MONOSPACE_FONTS.some((known) => primary.includes(known));
}

function buildDecorationOptions(
  editor: vscode.TextEditor,
  blame: Map<number, LineBlame>,
  config: vscode.WorkspaceConfiguration
): vscode.DecorationOptions[] {
  const showRevision = config.get<boolean>('showRevision', false);
  const showDate = config.get<boolean>('showDate', true);
  const dateFormat = config.get<string>('dateFormat', 'YYYY-MM-DD');
  const showAuthor = config.get<boolean>('showAuthor', true);
  const authorFormat = config.get<string>('authorFormat', 'First Name');
  const maxAuthorLength = config.get<number>('maxAuthorLength', 12);

  const doc = editor.document;
  const lineCount = doc.lineCount;

  const SEP = '  ';

  // Decide how much safety buffer (in extra "ch" units) to add to the
  // computed column width. In a monospace font, `ch` is exact, so no
  // buffer is needed. In a non-monospace/unknown font, character widths
  // vary, so we pad the box a bit wider than the raw character count to
  // keep the gap before the real code from ever shrinking to zero.
  const editorFontFamily = vscode.workspace
    .getConfiguration('editor', doc)
    .get<string>('fontFamily', '');

  let widthBufferCh: number;
  if (isLikelyMonospaceFont(editorFontFamily)) {
    widthBufferCh = 0;
  } else {
    widthBufferCh = 3;
  }

  const displays: LineDisplay[] = [];
  let maxTextLen = 0;

  for (let line = 0; line < lineCount; line++) {
    const isLastLine = line === lineCount - 1;
    const isTrailingEmptyLine = isLastLine && doc.lineAt(line).text.length === 0 && !blame.has(line);

    if (isTrailingEmptyLine) {
      displays.push({ text: '', info: undefined, isTrailingEmptyLine: true });
      continue;
    }

    const info = blame.get(line);
    if (!info) {
      displays.push({ text: '', info: undefined, isTrailingEmptyLine: false });
      continue;
    }

    const parts: string[] = [];

    if (showRevision) {
      parts.push(info.hash.slice(0, 7));
    }

    if (showDate) {
      if (isUncommitted(info.hash)) {
        parts.push(''.padEnd(formatDate(Math.floor(Date.now() / 1000), dateFormat).length, ' '));
      } else {
        parts.push(formatDate(info.authorTimeSec, dateFormat));
      }
    }

    if (showAuthor) {
      if (isUncommitted(info.hash)) {
        parts.push(truncate('Uncommitted', maxAuthorLength));
      } else {
        const rawAuthor = formatAuthorName(info.authorName, info.authorEmail, authorFormat);
        parts.push(truncate(rawAuthor, maxAuthorLength));
      }
    }

    const text = parts.join(SEP);
    maxTextLen = Math.max(maxTextLen, text.length);
    displays.push({ text, info, isTrailingEmptyLine: false });
  }

  const options: vscode.DecorationOptions[] = [];
  const columnWidthCh = maxTextLen + widthBufferCh;

  for (let line = 0; line < displays.length; line++) {
    const display = displays[line];

    if (display.isTrailingEmptyLine) {
      options.push({
        range: new vscode.Range(line, 0, line, 0),
        renderOptions: {
          before: {
            contentText: '',
            margin: '0 1.5em 0 0',
            width: `${columnWidthCh}ch`
          }
        }
      });
      continue;
    }

    if (!display.info) {
      continue;
    }

    options.push({
      range: new vscode.Range(line, 0, line, 0),
      renderOptions: {
        before: {
          contentText: display.text,
          margin: '0 1.5em 0 0',
          color: new vscode.ThemeColor('editorLineNumber.foreground'),
          fontStyle: 'normal',
          // Officially-typed decoration property (NOT a CSS-injection hack):
          // forces every line's annotation box to occupy identical pixel
          // width, so columns line up even when the editor font isn't a
          // perfectly uniform monospace. The text itself is already
          // ellipsis-truncated (see truncate()/maxAuthorLength), so nothing
          // is clipped by this — it only pads/aligns the box. For
          // non-monospace fonts, `columnWidthCh` already includes a safety
          // buffer (see widthBufferCh above) so overflow lands in the
          // margin gap, never on top of the real code.
          width: `${columnWidthCh}ch`
        }
      },
      hoverMessage: buildHoverMessage(display.info, dateFormat)
    });
  }

  return options;
}

function buildHoverMessage(info: LineBlame, dateFormat: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;

  if (isUncommitted(info.hash)) {
    md.appendMarkdown('**Uncommitted**\n\n');
    md.appendMarkdown('Not committed yet.');
    return md;
  }

  const authorLine = isValidEmail(info.authorEmail)
    ? `${info.authorName} <${info.authorEmail}>`
    : info.authorName || 'Unknown';

  md.appendMarkdown(`**${info.hash.slice(0, 7)}**\n\n`);
  md.appendMarkdown(`${authorLine}\n\n`);
  md.appendMarkdown(`${formatDate(info.authorTimeSec, dateFormat)}\n\n`);
  if (info.summary) {
    md.appendMarkdown(`${info.summary}`);
  }

  return md;
}
