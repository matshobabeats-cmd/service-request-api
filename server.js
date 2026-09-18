import express from 'express';
import { Pool } from 'pg';

const app = express();
const pool = new Pool();
const PORT = 3000;

const CATEGORIES = ['facilities', 'it', 'hr', 'other'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const STATUSES = ['open', 'in_progress', 'resolved', 'closed'];

// Secret Mission: only these forward moves are allowed. Anything else
// (skipping a stage, moving backward, or reopening a closed request)
// is rejected with 409 Conflict. Setting the same status again is a no-op.
const ALLOWED_TRANSITIONS = {
  open: ['in_progress'],
  in_progress: ['resolved'],
  resolved: ['closed'],
  closed: [],
};

const hasText = (value) => typeof value === 'string' && value.trim().length > 0;

app.disable('x-powered-by');
app.use(express.json());

// ---------- Health ----------
app.get('/health', async (_req, res, next) => {
  try {
    const result = await pool.query('SELECT CURRENT_TIMESTAMP AS database_time');
    res.json({ status: 'ok', databaseTime: result.rows[0].database_time });
  } catch (error) {
    next(error);
  }
});

// ---------- List + filter + search ----------
app.get('/api/requests', async (req, res, next) => {
  try {
    const { status, priority, category, search } = req.query;

    if (status && !STATUSES.includes(status)) {
      return res.status(400).json({ error: 'status is invalid' });
    }
    if (priority && !PRIORITIES.includes(priority)) {
      return res.status(400).json({ error: 'priority is invalid' });
    }
    if (category && !CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'category is invalid' });
    }

    const clauses = [];
    const values = [];

    const addFilter = (sql, value) => {
      values.push(value);
      clauses.push(sql.replace('?', `$${values.length}`));
    };

    if (status) addFilter('status = ?', status);
    if (priority) addFilter('priority = ?', priority);
    if (category) addFilter('category = ?', category);

    if (hasText(search)) {
      const term = `%${search.trim()}%`;
      values.push(term);
      const titleParam = `$${values.length}`;
      values.push(term);
      const descParam = `$${values.length}`;
      clauses.push(`(title ILIKE ${titleParam} OR description ILIKE ${descParam})`);
    }

    const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT * FROM requests ${whereClause} ORDER BY created_at DESC`,
      values,
    );

    return res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

// ---------- Dashboard ----------
app.get('/api/dashboard', async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
         count(*) FILTER (WHERE status IN ('open', 'in_progress'))::integer AS open,
         count(*) FILTER (WHERE status = 'resolved')::integer AS resolved,
         count(*) FILTER (WHERE status = 'closed')::integer AS closed,
         count(*)::integer AS total
       FROM requests`,
    );

    return res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

// ---------- Create ----------
app.post('/api/requests', async (req, res, next) => {
  try {
    const { title, description, category, priority = 'medium', requesterName } = req.body ?? {};

    if (![title, description, category, requesterName].every(hasText)) {
      return res.status(400).json({
        error: 'title, description, category, and requesterName are required',
      });
    }

    if (!CATEGORIES.includes(category) || !PRIORITIES.includes(priority)) {
      return res.status(400).json({ error: 'category or priority is invalid' });
    }

    const result = await pool.query(
      `INSERT INTO requests (title, description, category, priority, requester_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [title.trim(), description.trim(), category, priority, requesterName.trim()],
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

// ---------- Partial update (assignment, edits, status transitions) ----------
app.patch('/api/requests/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { title, description, category, priority, assignedTo, status } = req.body ?? {};

    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'id must be a positive integer' });
    }

    if ([title, description, category, priority, assignedTo, status].every((value) => value === undefined)) {
      return res.status(400).json({ error: 'provide at least one field to update' });
    }

    if ((title !== undefined && !hasText(title)) || (description !== undefined && !hasText(description))) {
      return res.status(400).json({ error: 'title and description cannot be empty' });
    }
    if (category !== undefined && !CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'category is invalid' });
    }
    if (priority !== undefined && !PRIORITIES.includes(priority)) {
      return res.status(400).json({ error: 'priority is invalid' });
    }
    if (status !== undefined && !STATUSES.includes(status)) {
      return res.status(400).json({ error: 'status is invalid' });
    }
    if (assignedTo !== undefined && !hasText(assignedTo)) {
      return res.status(400).json({ error: 'assignedTo cannot be empty' });
    }

    // Secret Mission: enforce the controlled status workflow.
    // Look up the current status before allowing any requested transition.
    if (status !== undefined) {
      const current = await pool.query('SELECT status FROM requests WHERE id = $1', [id]);

      if (current.rowCount === 0) {
        return res.status(404).json({ error: 'request not found' });
      }

      const currentStatus = current.rows[0].status;
      const isSameStatus = status === currentStatus;
      const isAllowedForward = ALLOWED_TRANSITIONS[currentStatus]?.includes(status);

      if (!isSameStatus && !isAllowedForward) {
        return res.status(409).json({
          error: `cannot move status from '${currentStatus}' to '${status}'`,
          allowedNextStatuses: ALLOWED_TRANSITIONS[currentStatus] ?? [],
        });
      }
    }

    const result = await pool.query(
      `UPDATE requests
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           category = COALESCE($3, category),
           priority = COALESCE($4, priority),
           assigned_to = COALESCE($5, assigned_to),
           status = COALESCE($6, status),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $7
       RETURNING *`,
      [
        title?.trim() ?? null,
        description?.trim() ?? null,
        category ?? null,
        priority ?? null,
        assignedTo?.trim() ?? null,
        status ?? null,
        id,
      ],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'request not found' });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

// ---------- Fallback + error handling ----------
app.use((_req, res) => {
  res.status(404).json({ error: 'route not found' });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'internal server error' });
});

app.listen(PORT, () => {
  console.log(`Service request API listening on port ${PORT}`);
});