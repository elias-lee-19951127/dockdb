# Changelog

## 0.3.0

- Grid values are coloured by type — booleans (green/red), dates, JSON, UUID/ObjectId and foreign keys — with subtle zebra rows. Empty strings show as *empty*, distinct from `NULL`. All colours come from your theme and meet 4.5:1 contrast in light and dark themes.
- The filter box suggests an example built from the table's own columns (SQL and MongoDB).
- Narrow editors: the table name stays visible, Save/Discard/Review stay together in the status bar, and notifications no longer cover it.
- The right-click menu is compact and opens at the cursor.
- The error banner flashes when Save or Review is pressed with cells that still need fixing.

## 0.2.0

- Microsoft SQL Server support (`mssql`/tedious): auto-detected from the official Docker image and Azure SQL Edge, or add one manually. Browse databases/schemas/tables/views, edit rows, foreign-key navigation and a SQL query editor, on par with Postgres/MySQL.
- Port scanning now also probes for SQL Server (TDS PRELOGIN) on top of Postgres/MySQL/MongoDB.
- Paste a `sqlserver://` URL to add a connection (semicolon-style JDBC/ADO.NET connection strings are not parsed yet — add those manually).

## 0.1.1

- Removed the repository link from the Marketplace listing (the source repository is private).

## 0.1.0 — first preview

- Auto-discovery of databases in Docker containers (credentials from the container env), on local ports (protocol probing) and SQLite files in the workspace. Paste `docker inspect`, compose, `docker run`, `.env` or a URL for anything else.
- PostgreSQL, MySQL/MariaDB, SQLite and MongoDB.
- Editable grid: inline editing (IME-friendly), add/duplicate/delete rows, copy/paste with spreadsheets, undo, one-transaction saves with row-count checks.
- Made for non-specialists: type badges and required markers in headers, plain-text search, filters from menus, a row-details form, foreign-key navigation, validation before saving and database errors in plain language.
- Safety modes per connection: Dev, Protected (confirm every change) and Read-only (blocked in DockDB and, for Postgres/MySQL, on the server).
- Query editor for SQL and mongo shell syntax with ⌘Enter, CodeLens and a results panel.
