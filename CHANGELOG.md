# Changelog

All notable changes to the "BlameTrail" extension are documented in this file.

## [1.0.0] - 2026-08-06

Initial release.

### Added

- **Annotate with git blame** — right-click a line number (or right-click within the code itself) to show inline blame info before each line: revision, date, and author, each independently toggleable.
- **Per-file state** — annotating one file has no effect on any other open file; each file remembers its own on/off state as you switch tabs.
- **Annotation view submenu** — checkbox-style toggles (☐/☑) for Revision, Date, Author, and Ignore Whitespaces, available both from the right-click menu and in Settings, kept in sync either way.
- **Copy Revision Number** — copies the full commit hash for the line you right-clicked.
- **Author display formats** — Initials, First Name, Last Name, or E-mail, with a safe fallback to name/e-mail when the chosen format can't be derived. Detects and skips clearly-invalid e-mail values (e.g. a stray config placeholder) rather than displaying them.
- **Date display formats** — `YYYY-MM-DD`, `YYYY/MM/DD`, `MM/DD/YYYY`, or `MM-DD-YYYY`; the hover tooltip always matches whichever format is selected.
- **Ignore Whitespaces** — toggles `git blame -w` and re-blames automatically when changed.
- **Live-buffer blame** — blames against your actual editor content (via `git blame --contents -`) rather than only the last-saved file, so unsaved edits (including brand-new lines) get sensible, immediate blame info instead of appearing blank.
- **Responsive updates while editing** — small edits keep existing annotations in place and refresh quickly after a short pause (100ms); a plain newline insertion (e.g. pressing Enter) refreshes instantly; large-scale changes (e.g. a whole-file formatter run) clear and re-blame cleanly to avoid stale/corrupted overlays.
- **Uncommitted line handling** — lines with local, uncommitted changes clearly show "Uncommitted" instead of git's raw placeholder values.
- **Trailing empty line handling** — the implicit empty line after a file's final newline gets blank aligned space reserved (no fake info), keeping the code column consistent even there.
- **Non-git files are left untouched** — if a file isn't inside a git repository, "Annotate with git blame" does nothing, as expected.
