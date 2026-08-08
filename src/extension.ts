import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';

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

type ToggleableSetting = 'showRevision' | 'showDate' | 'showAuthor' | 'ignoreWhitespace';

// --- Module-level state -----------------------------------------------
// Per-file state, keyed by document URI string. Each file tracks its own
// on/off flag and its own cached blame data, so annotating one file has no
// effect on any other open file.
const fileStates = new Map<string, FileState>();
// Per-file debounce timers for re-running git blame after an edit.
const reblameTimers = new Map<string, ReturnType<typeof setTimeout>>();
// A single shared decoration type. Decorations are applied per editor via
// editor.setDecorations(), so one type can safely serve every annotated file
// at once; it's created once and lives for the extension's lifetime.
let decorationType: vscode.TextEditorDecorationType | undefined;

const CONFIG_SECTION = 'blameTrail';
const REBLAME_DEBOUNCE_MS = 100;

function keyFor(doc: vscode.TextDocument): string {
  return doc.uri.toString();
}

export function activate(context: vscode.ExtensionContext): void {
  decorationType = vscode.window.createTextEditorDecorationType({});

  context.subscriptions.push(
    decorationType,
    vscode.commands.registerCommand('blameTrail.annotate', annotateCommand),
    vscode.commands.registerCommand('blameTrail.close', closeCommand),
    vscode.commands.registerCommand('blameTrail.copyRevision', copyRevisionCommand),
    vscode.commands.registerCommand('blameTrail.toggleRevisionOn', () => toggleSetting('showRevision')),
    vscode.commands.registerCommand('blameTrail.toggleRevisionOff', () => toggleSetting('showRevision')),
    vscode.commands.registerCommand('blameTrail.toggleDateOn', () => toggleSetting('showDate')),
    vscode.commands.registerCommand('blameTrail.toggleDateOff', () => toggleSetting('showDate')),
    vscode.commands.registerCommand('blameTrail.toggleAuthorOn', () => toggleSetting('showAuthor')),
    vscode.commands.registerCommand('blameTrail.toggleAuthorOff', () => toggleSetting('showAuthor')),
    vscode.commands.registerCommand('blameTrail.toggleIgnoreWhitespaceOn', () =>
      toggleSetting('ignoreWhitespace')
    ),
    vscode.commands.registerCommand('blameTrail.toggleIgnoreWhitespaceOff', () =>
      toggleSetting('ignoreWhitespace')
    ),
    vscode.workspace.onDidChangeConfiguration(onConfigChanged),
    vscode.workspace.onDidCloseTextDocument(onDocClosed),
    vscode.workspace.onDidChangeTextDocument(onDocChanged),
    vscode.window.onDidChangeActiveTextEditor(onActiveEditorChanged)
  );

  // Reflect whatever file is active right now (normally nothing yet).
  updateActiveContext(vscode.window.activeTextEditor);
}

export function deactivate(): void {
  for (const timer of reblameTimers.values()) {
    clearTimeout(timer);
  }
  reblameTimers.clear();
  fileStates.clear();
}

// --- Commands -----------------------------------------------------------

async function annotateCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
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
    // Per spec: if the file is not in a git repository, no changes should happen.
    return;
  }

  const key = keyFor(doc);
  const state: FileState = fileStates.get(key) ?? { active: false };
  fileStates.set(key, state);
  state.active = true;

  await refreshBlameForEditor(editor, state);
  updateActiveContext(editor);
}

function closeCommand(): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const key = keyFor(editor.document);
  clearReblameTimer(key);

  const state = fileStates.get(key);
  if (state) {
    state.active = false;
    state.blameMap = undefined;
  }

  if (decorationType) {
    editor.setDecorations(decorationType, []);
  }
  updateActiveContext(editor);
}

async function copyRevisionCommand(uri?: vscode.Uri, lineNumber?: number): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  // If VS Code told us which document this came from, make sure it matches
  // the editor we're about to read from.
  if (uri && editor.document.uri.toString() !== uri.toString()) {
    return;
  }

  const state = fileStates.get(keyFor(editor.document));
  if (!state?.blameMap) {
    return;
  }

  const targetLine = lineNumber ?? editor.selection.active.line + 1;
  const info = state.blameMap.get(targetLine);
  if (!info) {
    return;
  }

  await vscode.env.clipboard.writeText(info.hash);
  vscode.window.setStatusBarMessage(`Copied revision ${info.hash.substring(0, 7)}`, 2000);
}

async function toggleSetting(section: ToggleableSetting): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const current = config.get<boolean>(section, false);
  await config.update(section, !current, vscode.ConfigurationTarget.Global);
}

// --- Configuration / lifecycle listeners --------------------------------

function updateActiveContext(editor: vscode.TextEditor | undefined): void {
  const key = editor ? keyFor(editor.document) : undefined;
  const active = key ? (fileStates.get(key)?.active ?? false) : false;
  void vscode.commands.executeCommand('setContext', 'blameTrail.active', active);
}

function onActiveEditorChanged(editor: vscode.TextEditor | undefined): void {
  updateActiveContext(editor);

  // Guard against a fresh TextEditor instance for an already-annotated
  // document (e.g. after certain view operations) losing its decorations.
  if (editor && decorationType) {
    const state = fileStates.get(keyFor(editor.document));
    if (state?.active && state.blameMap) {
      renderDecorationsForEditor(editor, state);
    }
  }
}

async function onConfigChanged(e: vscode.ConfigurationChangeEvent): Promise<void> {
  if (!e.affectsConfiguration(CONFIG_SECTION)) {
    return;
  }

  const ignoreWhitespaceChanged = e.affectsConfiguration(`${CONFIG_SECTION}.ignoreWhitespace`);

  // Settings are global (not per file), so every currently visible,
  // currently-active file needs to reflect the change.
  for (const editor of vscode.window.visibleTextEditors) {
    const state = fileStates.get(keyFor(editor.document));
    if (!state?.active) {
      continue;
    }
    if (ignoreWhitespaceChanged) {
      // Whitespace handling changes the actual blame result, so re-run git blame.
      await refreshBlameForEditor(editor, state);
    } else {
      // Only display options changed; re-render from the cached blame data.
      renderDecorationsForEditor(editor, state);
    }
  }
}

function onDocClosed(doc: vscode.TextDocument): void {
  const key = keyFor(doc);
  clearReblameTimer(key);
  fileStates.delete(key);
}

// Roughly distinguishes "someone reformatted/rewrote a big chunk of the
// file" from ordinary typing. Only the former needs an immediate decoration
// clear (see onDocChanged) -- normal edits can just let the existing
// decorations ride along, since VS Code tracks their positions through edits
// automatically.
const BULK_EDIT_LINE_THRESHOLD = 5;

function isBulkEdit(e: vscode.TextDocumentChangeEvent): boolean {
  const totalLines = e.document.lineCount;
  for (const change of e.contentChanges) {
    const spanLines = change.range.end.line - change.range.start.line + 1;
    if (spanLines > BULK_EDIT_LINE_THRESHOLD || spanLines >= totalLines * 0.5) {
      return true;
    }
  }
  return false;
}

// A single, pure newline insertion with no other text (e.g. pressing Enter
// to start a new line) doesn't touch any existing line's content, so there's
// nothing to lose by refreshing right away instead of waiting for the
// debounce -- it's cheap and gives instant feedback for the common "add a
// new line" case.
function isPureNewlineInsertion(e: vscode.TextDocumentChangeEvent): boolean {
  if (e.contentChanges.length !== 1) {
    return false;
  }
  const change = e.contentChanges[0];
  const isPureInsertion = change.rangeLength === 0;
  // A bare newline (pressing Enter with no auto-indent), or a newline
  // followed only by leading whitespace (auto-indent inheriting the
  // previous line's indentation) -- either way, no real content was added.
  return isPureInsertion && /^\r?\n[ \t]*$/.test(change.text);
}

function onDocChanged(e: vscode.TextDocumentChangeEvent): void {
  if (e.contentChanges.length === 0) {
    return;
  }

  const key = keyFor(e.document);
  const state = fileStates.get(key);
  if (!state?.active) {
    return;
  }

  const bulkEdit = isBulkEdit(e);

  if (bulkEdit) {
    // A large-scale rewrite (e.g. a whole-file formatter run). Existing
    // decorations are anchored to positions that may not survive a big
    // structural change cleanly, so clear them immediately rather than risk
    // a corrupted-looking overlay, then re-run git blame once things settle.
    state.blameMap = undefined;
    if (decorationType) {
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document === e.document) {
          editor.setDecorations(decorationType, []);
        }
      }
    }
  }
  // For small, incremental edits (ordinary typing), deliberately leave the
  // existing annotations in place. VS Code shifts decoration positions along
  // with the text as you type, so they stay roughly correct rather than the
  // whole annotated column flickering away on every keystroke. They'll be
  // fully refreshed once you pause, below.

  clearReblameTimer(key);

  if (!bulkEdit && isPureNewlineInsertion(e)) {
    // Refresh immediately rather than waiting for the debounce. Note this
    // still recomputes blame for the whole file under the hood (the
    // decoration API has no way to update just one line), but since every
    // other line's content is unchanged, nothing visibly changes for them --
    // only the new line goes from blank to showing its info.
    const editor = vscode.window.visibleTextEditors.find((ed) => ed.document === e.document);
    if (editor) {
      void refreshBlameForEditor(editor, state);
    }
    return;
  }

  const timer = setTimeout(() => {
    reblameTimers.delete(key);
    const stillActive = fileStates.get(key);
    if (!stillActive?.active) {
      return;
    }
    const editor = vscode.window.visibleTextEditors.find((ed) => ed.document.uri.toString() === key);
    if (editor) {
      void refreshBlameForEditor(editor, stillActive);
    }
  }, REBLAME_DEBOUNCE_MS);
  reblameTimers.set(key, timer);
}

function clearReblameTimer(key: string): void {
  const timer = reblameTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    reblameTimers.delete(key);
  }
}

// --- Git blame ------------------------------------------------------------

function execFileP(cmd: string, args: string[], opts: cp.ExecFileOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile(cmd, args, { ...opts, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout.toString());
    });
  });
}

// Like execFileP, but also writes `input` to the child process's stdin. Used
// for `git blame --contents -`, which reads the content to blame from stdin
// instead of from the file on disk.
function execFileWithStdin(cmd: string, args: string[], opts: cp.ExecFileOptions, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = cp.execFile(cmd, args, { ...opts, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout.toString());
    });
    if (!child.stdin) {
      reject(new Error('Unable to write to git blame stdin.'));
      return;
    }
    child.stdin.on('error', reject);
    child.stdin.write(input, 'utf8');
    child.stdin.end();
  });
}

async function isFileTrackedByGit(filePath: string, cwd: string): Promise<boolean> {
  try {
    await execFileP('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  } catch {
    return false;
  }
  try {
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
): Promise<Map<number, LineBlame>> {
  // Blame against the live editor buffer (via stdin) rather than the file on
  // disk. This means unsaved edits — including brand-new lines that don't
  // exist on disk yet — still get sensible blame info (they'll show up as
  // uncommitted) instead of being silently missing from the results.
  const args = ['blame', '--line-porcelain', '--contents', '-'];
  if (ignoreWhitespace) {
    args.push('-w');
  }
  args.push('--', path.basename(filePath));

  const stdout = await execFileWithStdin('git', args, { cwd }, contents);
  return parseGitBlamePorcelain(stdout);
}

function parseGitBlamePorcelain(output: string): Map<number, LineBlame> {
  const result = new Map<number, LineBlame>();
  const lines = output.split('\n');
  let i = 0;

  while (i < lines.length) {
    const header = lines[i];
    if (!header || header.trim().length === 0) {
      i++;
      continue;
    }

    const headerParts = header.split(' ');
    if (headerParts.length < 3) {
      i++;
      continue;
    }

    const hash = headerParts[0];
    const finalLine = parseInt(headerParts[2], 10);
    i++;

    let authorName = '';
    let authorEmail = '';
    let authorTimeSec = 0;
    let summary = '';

    while (i < lines.length && !lines[i].startsWith('\t')) {
      const line = lines[i];
      if (line.startsWith('author ')) {
        authorName = line.slice('author '.length);
      } else if (line.startsWith('author-mail ')) {
        authorEmail = line.slice('author-mail '.length).replace(/^<|>$/g, '');
      } else if (line.startsWith('author-time ')) {
        authorTimeSec = parseInt(line.slice('author-time '.length), 10) || 0;
      } else if (line.startsWith('summary ')) {
        summary = line.slice('summary '.length);
      }
      i++;
    }

    // Skip the content line, which starts with a tab.
    if (i < lines.length && lines[i].startsWith('\t')) {
      i++;
    }

    if (!isNaN(finalLine)) {
      result.set(finalLine, { hash, authorName, authorEmail, authorTimeSec, summary });
    }
  }

  return result;
}

// --- Rendering ------------------------------------------------------------

async function refreshBlameForEditor(editor: vscode.TextEditor, state: FileState): Promise<void> {
  const doc = editor.document;
  const filePath = doc.uri.fsPath;
  const cwd = path.dirname(filePath);
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const ignoreWhitespace = config.get<boolean>('ignoreWhitespace', true);
  const contents = doc.getText();

  try {
    state.blameMap = await runGitBlame(filePath, cwd, ignoreWhitespace, contents);
  } catch {
    vscode.window.showErrorMessage('BlameTrail: failed to run "git blame" on this file.');
    return;
  }

  renderDecorationsForEditor(editor, state);
}

function renderDecorationsForEditor(editor: vscode.TextEditor, state: FileState): void {
  if (!state.blameMap || !decorationType) {
    return;
  }

  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const options = buildDecorationOptions(editor, state.blameMap, config);
  editor.setDecorations(decorationType, options);
}

function buildDecorationOptions(
  editor: vscode.TextEditor,
  blame: Map<number, LineBlame>,
  config: vscode.WorkspaceConfiguration
): vscode.DecorationOptions[] {
  const doc = editor.document;
  const showRevision = config.get<boolean>('showRevision', false);
  const showDate = config.get<boolean>('showDate', true);
  const dateFormat = config.get<string>('dateFormat', 'YYYY-MM-DD');
  const showAuthor = config.get<boolean>('showAuthor', true);
  const authorFormat = config.get<string>('authorFormat', 'First Name');
  const maxAuthorLength = config.get<number>('maxAuthorLength', 12);

  // First pass: compute formatted parts per line, and the widest author
  // string, so authors line up in a column.
  const perLine: { revision?: string; date?: string; author?: string }[] = new Array(doc.lineCount);
  let maxAuthorLen = 0;

  for (let line = 0; line < doc.lineCount; line++) {
    const info = blame.get(line + 1);
    if (!info) {
      continue;
    }
    const entry: { revision?: string; date?: string; author?: string } = {};
    if (showRevision) {
      entry.revision = isUncommitted(info.hash) ? '-------' : info.hash.substring(0, 7);
    }
    if (showDate) {
      entry.date = formatDate(info.authorTimeSec, dateFormat);
    }
    if (showAuthor) {
      const rawAuthor = isUncommitted(info.hash)
        ? 'Uncommitted'
        : formatAuthorName(info.authorName, info.authorEmail, authorFormat);
      // Cap the length regardless of how long the real name/email is -- one
      // outlier shouldn't be able to widen every line's annotation and shove
      // all the code far to the right.
      entry.author = truncate(rawAuthor, maxAuthorLength);
      if (entry.author.length > maxAuthorLen) {
        maxAuthorLen = entry.author.length;
      }
    }
    perLine[line] = entry;
  }

  // Second pass: build the actual annotation text per line, and track the
  // widest one. Padding the author name to a common width (above) already
  // keeps every real line's text the same character count, which lines up
  // consistently in a monospace font without needing to force an explicit
  // CSS width; we still track the max here for the trailing-line placeholder
  // below.
  const textPerLine: (string | undefined)[] = new Array(doc.lineCount);
  let maxTextLen = 0;

  // A regular space gets collapsed/trimmed by the browser's default text
  // layout, which would silently undo our padding and break alignment. A
  // non-breaking space is never collapsed, regardless of CSS mode, so we use
  // it for all padding and inter-field spacing instead — no CSS needed.
  const NBSP = '\u00A0';

  for (let line = 0; line < doc.lineCount; line++) {
    const entry = perLine[line];
    if (!entry) {
      continue;
    }
    const segments: string[] = [];
    if (entry.revision) {
      segments.push(entry.revision);
    }
    if (entry.date) {
      segments.push(entry.date);
    }
    if (entry.author) {
      const padLen = Math.max(0, maxAuthorLen - entry.author.length);
      segments.push(entry.author + NBSP.repeat(padLen));
    }
    if (segments.length === 0) {
      continue;
    }
    const text = segments.join(NBSP + NBSP);
    textPerLine[line] = text;
    if (text.length > maxTextLen) {
      maxTextLen = text.length;
    }
  }

  const options: vscode.DecorationOptions[] = [];
  for (let line = 0; line < doc.lineCount; line++) {
    const text = textPerLine[line];
    if (text === undefined) {
      // No real blame data for this line. The one case worth reserving
      // visual space for anyway is VS Code's implicit empty line after a
      // file's final newline -- it isn't real content, so git has nothing
      // to report for it, but leaving it abruptly flush-left (no gap at
      // all) looks broken next to every other line's aligned annotation.
      // Reserve the same width with blank space; no hover, since there's
      // genuinely no info to show.
      const isTrailingEmptyLine = line === doc.lineCount - 1 && doc.lineAt(line).text.length === 0;
      if (isTrailingEmptyLine && maxTextLen > 0) {
        options.push({
          range: new vscode.Range(line, 0, line, 0),
          renderOptions: {
            before: {
              contentText: NBSP.repeat(maxTextLen),
              margin: '0 1.5em 0 0'
            }
          }
        });
      }
      continue;
    }

    const info = blame.get(line + 1);
    if (!info) {
      continue;
    }

    const range = new vscode.Range(line, 0, line, 0);
    options.push({
      range,
      renderOptions: {
        before: {
          contentText: text,
          margin: '0 1.5em 0 0',
          color: new vscode.ThemeColor('editorLineNumber.foreground'),
          fontStyle: 'normal'
          // Deliberately NOT setting fontFamily/fontSize here. The decoration
          // API has no official field for that, and piggy-backing extra CSS
          // through `textDecoration` (an old unofficial trick) corrupted
          // styling for the whole file, not just this annotation text. Not
          // worth the risk for a purely cosmetic font match.
        }
      },
      hoverMessage: buildHoverMessage(info, dateFormat)
    });
  }

  return options;
}

// Git's placeholder commit hash for lines with uncommitted local changes.
const UNCOMMITTED_HASH = '0'.repeat(40);

function truncate(text: string, maxLen: number): string {
  if (maxLen <= 0 || text.length <= maxLen) {
    return text;
  }
  if (maxLen === 1) {
    return '…';
  }
  return text.slice(0, maxLen - 1) + '…';
}

function isUncommitted(hash: string): boolean {
  return hash === UNCOMMITTED_HASH;
}

function isValidEmail(value: string): boolean {
  // Deliberately simple: just enough to catch "this clearly isn't an email"
  // cases (like a stray config value such as "password"), not full RFC 5322
  // validation.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function buildHoverMessage(info: LineBlame, dateFormat: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const uncommitted = isUncommitted(info.hash);
  const hashLabel = uncommitted ? 'Uncommitted' : info.hash.substring(0, 7);
  md.appendMarkdown(`**${hashLabel}**  \n`);
  const authorLine = uncommitted
    ? 'Uncommitted'
    : isValidEmail(info.authorEmail)
      ? `${info.authorName} <${info.authorEmail}>`
      : info.authorName;
  md.appendMarkdown(`${authorLine}  \n`);
  md.appendMarkdown(`${formatDate(info.authorTimeSec, dateFormat)}  \n\n`);
  if (info.summary) {
    md.appendText(info.summary);
  }
  return md;
}

function formatDate(epochSeconds: number, format: string): string {
  const date = new Date(epochSeconds * 1000);
  const yyyy = date.getUTCFullYear().toString().padStart(4, '0');
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = date.getUTCDate().toString().padStart(2, '0');

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

function formatAuthorName(name: string, email: string, format: string): string {
  const trimmedName = (name || '').trim();
  // Only fall back to the email if it actually looks like one. Git blame
  // will happily report whatever string was in `user.email` at commit time
  // (e.g. a placeholder like "password"), which isn't useful or safe to
  // display as if it were a real email address.
  const safeEmail = isValidEmail(email) ? email.trim() : '';

  switch (format) {
    case 'Initials': {
      if (!trimmedName) {
        return safeEmail;
      }
      const initials = trimmedName
        .split(/\s+/)
        .map((part) => part.charAt(0).toUpperCase())
        .join('');
      return initials || safeEmail;
    }
    case 'Last Name': {
      const parts = trimmedName.split(/\s+/).filter(Boolean);
      const last = parts.length > 0 ? parts[parts.length - 1] : '';
      return last || safeEmail;
    }
    case 'E-mail':
      // If the "email" isn't actually a valid email, show the author's name
      // instead rather than displaying a raw, potentially sensitive value.
      return safeEmail || trimmedName;
    case 'First Name':
    default: {
      const parts = trimmedName.split(/\s+/).filter(Boolean);
      const first = parts.length > 0 ? parts[0] : '';
      return first || safeEmail;
    }
  }
}
