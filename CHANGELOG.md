# Changelog

## 0.1.1

- Removed the repository link from the Marketplace listing (the source repository is private).

## 0.1.0 — first preview

- Auto-discovery of databases in Docker containers (credentials from the container env), on local ports (protocol probing) and SQLite files in the workspace. Paste `docker inspect`, compose, `docker run`, `.env` or a URL for anything else.
- PostgreSQL, MySQL/MariaDB, SQLite and MongoDB.
- Editable grid: inline editing (IME-friendly), add/duplicate/delete rows, copy/paste with spreadsheets, undo, one-transaction saves with row-count checks.
- Made for non-specialists: type badges and required markers in headers, plain-text search, filters from menus, a row-details form, foreign-key navigation, validation before saving and database errors in plain language.
- Safety modes per connection: Dev, Protected (confirm every change) and Read-only (blocked in DockDB and, for Postgres/MySQL, on the server).
- Query editor for SQL and mongo shell syntax with ⌘Enter, CodeLens and a results panel.
