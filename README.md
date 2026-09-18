# Service Request API

An Express + PostgreSQL REST API for managing an internal service desk queue.
Requests persist across server restarts, support filtering and search, and
move through a controlled status workflow that rejects skipped stages.

Built as part of a NextWork guided project.

## Features

- **Persistent storage** — every request is written to PostgreSQL, so it
  survives a server restart (tested by stopping and restarting the API and
  confirming the data was still there).
- **Full CRUD workflow** — create, list, and partially update requests.
- **Search and filtering** — narrow the queue by `status`, `priority`,
  `category`, or a free-text `search` across title and description.
- **Dashboard endpoint** — live `open`, `resolved`, `closed`, and `total`
  counts computed in a single query.
- **Enforced status workflow** — requests must move through
  `open → in_progress → resolved → closed` one stage at a time. Skipping a
  stage or moving backward returns `409 Conflict`.
- **SQL injection protection** — every query uses numbered placeholders
  (`$1`, `$2`, ...) with values passed separately, never concatenated into
  the SQL string.

## Setup

```bash
npm install
cp .env.example .env      # then fill in your local PostgreSQL password
psql -U postgres -c "CREATE DATABASE service_requests;"
psql -U postgres -d service_requests -f schema.sql
npm start                  # runs: node --env-file=.env server.js
```

Server listens on `http://localhost:3000`.

## Data model

`requests` table columns: `id, title, description, category, priority,
status, requester_name, assigned_to, created_at, updated_at`.

- `category`: `facilities` | `it` | `hr` | `other`
- `priority`: `low` | `medium` | `high` | `urgent` (default `medium`)
- `status`: `open` | `in_progress` | `resolved` | `closed` (default `open`)

All four fields are enforced with database-level `CHECK` constraints, not
just application-level validation.

## Endpoints

### `GET /health`
Confirms the API can reach PostgreSQL.

```json
{ "status": "ok", "databaseTime": "2026-09-18T08:24:25.827Z" }
```

### `POST /api/requests`
Create a request.

Body: `{ title, description, category, priority?, requesterName }`
(`title`, `description`, `category`, `requesterName` are required text;
`priority` defaults to `medium`.)

Returns `201` with the created row, or `400` on missing/invalid fields.

### `GET /api/requests`
List requests, newest first. Optional query params, all combinable:

| Param      | Description                                                |
|------------|--------------------------------------------------------------|
| `status`   | one of `open`, `in_progress`, `resolved`, `closed`           |
| `priority` | one of `low`, `medium`, `high`, `urgent`                      |
| `category` | one of `facilities`, `it`, `hr`, `other`                      |
| `search`   | case-insensitive substring match on title OR description      |

Example:
```
GET /api/requests?priority=urgent&search=VPN
```

### `GET /api/dashboard`
```json
{ "open": 1, "resolved": 0, "closed": 1, "total": 2 }
```
`open` includes both `open` and `in_progress` requests.

### `PATCH /api/requests/:id`
Partial update. Body may include any of: `title, description, category,
priority, assignedTo, status`. Omitted fields keep their current value
(implemented with `COALESCE` in the SQL). Requires at least one field.

| Result | Condition                                                   |
|--------|----------------------------------------------------------------|
| `200`  | update succeeded, returns the updated row                       |
| `400`  | invalid `id`, empty body, invalid enum value, or blank text      |
| `404`  | no request with that `id`                                       |
| `409`  | `status` requests an illegal transition (see below)              |

## Status workflow (skip-stage protection)

Status may only move forward one stage at a time:

```
open → in_progress → resolved → closed
```

Skipping a stage (`open → closed`), moving backward (`closed → open`), or
changing a `closed` request's status at all is rejected with **`409
Conflict`**:

```json
{
  "error": "cannot move status from 'open' to 'closed'",
  "allowedNextStatuses": ["in_progress"]
}
```

Setting `status` to the request's current value is a no-op and always
allowed. Before applying any update that includes `status`, the route
re-reads the row's current status from PostgreSQL and checks it against an
`ALLOWED_TRANSITIONS` map before the `UPDATE` runs.

## Example: full lifecycle

```
# create
POST /api/requests
{ "title": "Leaking tap", "description": "Drips after being shut off.",
  "category": "facilities", "priority": "high", "requesterName": "Alex Morgan" }

# assign + start work
PATCH /api/requests/1
{ "assignedTo": "Jordan Lee", "status": "in_progress" }

# rejected — skips a stage
PATCH /api/requests/1
{ "status": "closed" }
# -> 409 { "error": "cannot move status from 'in_progress' to 'closed'", "allowedNextStatuses": ["resolved"] }

# resolve, then close
PATCH /api/requests/1  { "status": "resolved" }
PATCH /api/requests/1  { "status": "closed" }
```

## Notes

- `.env` is git-ignored — never commit real database credentials.
- All SQL uses numbered placeholders with values passed separately,
  protecting against injection in both the filter/search route and the
  create/update routes.
- Aggregate counts on `/api/dashboard` use `count(*) FILTER (WHERE ...)` so
  all four totals come from a single database round trip.
