import { getConnection } from '@/modules/database/connection.js';
import type { AureonTaskState } from '@/modules/agents/aureon-orchestrator.js';

export type AureonTaskRow = {
  id: string;
  user_id: number;
  project_id: string;
  prompt: string;
  provider: string;
  workspace_path: string;
  state: AureonTaskState;
  stage_index: number;
  output_json: string;
  error: string | null;
  created_at: string;
  updated_at: string;
};

const ensureTable = () => {
  const db = getConnection();
  db.exec(`
    CREATE TABLE IF NOT EXISTS aureon_tasks (
      id TEXT PRIMARY KEY NOT NULL,
      user_id INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      provider TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      state TEXT NOT NULL,
      stage_index INTEGER NOT NULL DEFAULT 0,
      output_json TEXT NOT NULL DEFAULT '[]',
      error TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_aureon_tasks_user ON aureon_tasks(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_aureon_tasks_project ON aureon_tasks(user_id, project_id, updated_at DESC);
  `);
  return db;
};

export const aureonTasksDb = {
  create(input: {
    id: string;
    userId: number;
    projectId: string;
    prompt: string;
    provider: string;
    workspacePath: string;
    state: AureonTaskState;
  }): AureonTaskRow {
    const db = ensureTable();
    db.prepare(`
      INSERT INTO aureon_tasks
        (id, user_id, project_id, prompt, provider, workspace_path, state, stage_index, output_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, '[]')
    `).run(
      input.id,
      input.userId,
      input.projectId,
      input.prompt,
      input.provider,
      input.workspacePath,
      input.state,
    );
    return this.getByIdForUser(input.id, input.userId)!;
  },

  getByIdForUser(id: string, userId: number): AureonTaskRow | null {
    const db = ensureTable();
    return (db.prepare('SELECT * FROM aureon_tasks WHERE id = ? AND user_id = ?').get(id, userId) as AureonTaskRow | undefined) ?? null;
  },

  getById(id: string): AureonTaskRow | null {
    const db = ensureTable();
    return (db.prepare('SELECT * FROM aureon_tasks WHERE id = ?').get(id) as AureonTaskRow | undefined) ?? null;
  },

  list(userId: number, projectId?: string): AureonTaskRow[] {
    const db = ensureTable();
    if (projectId) {
      return db.prepare('SELECT * FROM aureon_tasks WHERE user_id = ? AND project_id = ? ORDER BY updated_at DESC').all(userId, projectId) as AureonTaskRow[];
    }
    return db.prepare('SELECT * FROM aureon_tasks WHERE user_id = ? ORDER BY updated_at DESC').all(userId) as AureonTaskRow[];
  },

  listRecoverable(): AureonTaskRow[] {
    const db = ensureTable();
    return db.prepare(`
      SELECT * FROM aureon_tasks
      WHERE state NOT IN ('completed', 'failed')
      ORDER BY updated_at ASC
    `).all() as AureonTaskRow[];
  },

  update(id: string, patch: Partial<Pick<AureonTaskRow, 'state' | 'stage_index' | 'output_json' | 'error'>>): AureonTaskRow | null {
    const db = ensureTable();
    const current = this.getById(id);
    if (!current) return null;
    const next = {
      state: patch.state ?? current.state,
      stage_index: patch.stage_index ?? current.stage_index,
      output_json: patch.output_json ?? current.output_json,
      error: patch.error === undefined ? current.error : patch.error,
    };
    db.prepare(`
      UPDATE aureon_tasks
      SET state = ?, stage_index = ?, output_json = ?, error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(next.state, next.stage_index, next.output_json, next.error, id);
    return this.getById(id);
  },
};
