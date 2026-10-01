# Changelog

## 1.1.1

- Improved: annotation column width now adapts to the editor's font. Known monospace fonts (Consolas, Menlo, Cascadia Code, Fira Code, JetBrains Mono, etc.) use an exact width; any other font gets a small safety buffer so columns still stay aligned and never visually overlap the code.

## 1.1.0

- Fixed: an unusually long author name could widen the whole annotation column and push code far to the right. Added `blameTrail.maxAuthorLength` (default 12) to cap and ellipsis-truncate the author field; the hover tooltip still shows the full name.
- Fixed: inline annotation columns (revision / date / author) now occupy identical pixel width on every line, using the decoration API's `width` property, with an ellipsis for anything that doesn't fit. Full untruncated details remain visible in the hover popup.

## 1.0.0

- Initial release.
- Right-click a line number or anywhere in the editor to annotate the file with inline git blame info (date + author's first name by default).
- "Annotation view" submenu to toggle Revision / Date / Author / Ignore Whitespaces, with checkbox state kept in sync with Settings.
- Author display format setting: Initials / First Name / Last Name / E-mail, with automatic fallback.
- Date format setting: ISO (`YYYY-MM-DD`, `YYYY/MM/DD`) or American (`MM/DD/YYYY`, `MM-DD-YYYY`).
- Per-file annotation state (toggling one file doesn't affect others).
- Live re-blame of unsaved edits via `git blame --contents -`.
- "Copy Revision Number" command.
