import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { aureonTasksDb } from '@/modules/database/index.js';
import { projectsDb } from '@/modules/database/index.js';
import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import { providerRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import type { LLMProvider } from '@/shared/types.js';

export type AureonAgentRole = 'planner' | 'builder' | 'tester' | 'reviewer' | 'fixer';
export type AureonTaskState = 'queued' | 'planning' | 'building' | 'testing' | 'reviewing' | 'fixing' | 'completed' | 'failed';

export type AureonTask = {
  id: string;
  userId: number;
  projectId: string;
  prompt: string;
  provider: LLMProvider;
  workspacePath: string;
  state: AureonTaskState;
  stageIndex: number;
  createdAt: string;
  updatedAt: string;
  output: string[];
  error?: string;
};

const STAGES: Array<{ role: AureonAgentRole; state: AureonTaskState }> = [
  { role: 'planner', state: 'planning' },
  { role: 'builder', state: 'building' },
  { role: 'tester', state: 'testing' },
  { role: 'reviewer', state: 'reviewing' },
  { role: 'fixer', state: 'fixing' },
];

const rolePrompt = (role: AureonAgentRole, task: AureonTask, previousOutput: string) => {
  const instructions: Record<AureonAgentRole, string> = {
    planner: 'Analyze the request and codebase, produce a concrete implementation plan, and identify risks. Do not make changes.',
    builder: 'Implement the requested changes in the workspace. Inspect existing code first, preserve working functionality, and make the smallest safe changes.',
    tester: 'Run relevant tests, type checks, builds, and targeted checks. Record every failure. Only make a small corrective change when it is clearly caused by this task.',
    reviewer: 'Review the implementation and diff for correctness, security, regressions, and missing requirements. Record any issue that must be fixed.',
    fixer: 'Resolve remaining test, build, or review issues. If no fix is required, verify that and report no changes were necessary. Never modify files outside the selected workspace.',
  };

  return [
    `You are Aureon's ${role} agent.`,
    instructions[role],
    `Original task: ${task.prompt}`,
    `Workspace: ${task.workspacePath}`,
    previousOutput ? `Previous stage output:\n${previousOutput.slice(-12000)}` : '',
  ].filter(Boolean).join('\n\n');
};

const isProvider = (value: string): value is LLMProvider =>
  value === 'claude' || value === 'codex' || value === 'cursor' || value === 'opencode';

const isInsideWorkspace = (workspacePath: string, projectPath: string): boolean => {
  const relative = path.relative(path.resolve(projectPath), path.resolve(workspacePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const fromRow = (row: ReturnType<typeof aureonTasksDb.getById>): AureonTask | undefined => {
  if (!row || !isProvider(row.provider)) return undefined;
  let output: string[] = [];
  try {
    const parsed = JSON.parse(row.output_json);
    if (Array.isArray(parsed)) output = parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    output = [];
  }
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    prompt: row.prompt,
    provider: row.provider,
    workspacePath: row.workspace_path,
    state: row.state,
    stageIndex: row.stage_index,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    output,
    ...(row.error ? { error: row.error } : {}),
  };
};

export class AureonOrchestrator {
  private readonly running = new Set<string>();

  createTask(input: {
    userId: number;
    projectId: string;
    prompt: string;
    provider: string;
    workspacePath?: string;
  }): AureonTask {
    if (!isProvider(input.provider)) throw new Error(`Unsupported provider "${input.provider}".`);
    const project = projectsDb.getProjectById(input.projectId);
    if (!project) throw new Error('Project not found.');
    const workspacePath = input.workspacePath ? path.resolve(input.workspacePath) : path.resolve(project.project_path);
    if (!isInsideWorkspace(workspacePath, project.project_path)) {
      throw new Error('Workspace must be inside the selected project.');
    }

    const id = randomUUID();
    const row = aureonTasksDb.create({
      id,
      userId: input.userId,
      projectId: input.projectId,
      prompt: input.prompt.trim(),
      provider: input.provider,
      workspacePath,
      state: 'queued',
    });
    return fromRow(row)!;
  }

  getTask(id: string, userId: number): AureonTask | undefined {
    return fromRow(aureonTasksDb.getByIdForUser(id, userId));
  }

  listTasks(userId: number, projectId?: string): AureonTask[] {
    return aureonTasksDb.list(userId, projectId).map(fromRow).filter((task): task is AureonTask => Boolean(task));
  }

  transition(id: string, state: AureonTaskState): AureonTask {
    const updated = aureonTasksDb.update(id, { state });
    const task = fromRow(updated);
    if (!task) throw new Error(`Aureon task not found: ${id}`);
    return task;
  }

  /** Queue execution and return immediately; the task is durable in SQLite. */
  startTask(id: string): AureonTask {
    const task = fromRow(aureonTasksDb.getById(id));
    if (!task) throw new Error(`Aureon task not found: ${id}`);
    if (!this.running.has(id) && task.state !== 'completed') {
      void Promise.resolve().then(() => this.runTask(id));
    }
    return task;
  }

  /** Resume non-terminal tasks after a process restart. */
  recoverTasks(): void {
    for (const row of aureonTasksDb.listRecoverable()) {
      if (row.state === 'failed') continue;
      void Promise.resolve().then(() => this.runTask(row.id));
    }
  }

  async runTask(id: string): Promise<AureonTask> {
    if (this.running.has(id)) {
      const existing = fromRow(aureonTasksDb.getById(id));
      if (!existing) throw new Error(`Aureon task not found: ${id}`);
      return existing;
    }

    const initial = fromRow(aureonTasksDb.getById(id));
    if (!initial) throw new Error(`Aureon task not found: ${id}`);
    if (initial.state === 'completed') return initial;

    this.running.add(id);
    try {
      const auth = await providerAuthService.getProviderAuthStatus(initial.provider);
      if (!auth.authenticated) {
        aureonTasksDb.update(id, { state: 'failed', error: auth.error || `${initial.provider} is not authenticated.` });
        return fromRow(aureonTasksDb.getById(id))!;
      }

      let task = fromRow(aureonTasksDb.getById(id))!;
      let previousOutput = task.output.join('\n').slice(-12000);

      for (let index = task.stageIndex; index < STAGES.length; index += 1) {
        const stage = STAGES[index];
        aureonTasksDb.update(id, { state: stage.state, stage_index: index });
        task = fromRow(aureonTasksDb.getById(id))!;

        const stageOutput: unknown[] = [];
        const writer = {
          isSSEStreamWriter: true,
          userId: task.userId,
          send: (data: unknown) => stageOutput.push(data),
          setSessionId: (_sessionId: string) => undefined,
        };

        await providerRuntimeService.run(
          task.provider,
          rolePrompt(stage.role, task, previousOutput),
          {
            sessionId: `${task.id}-${stage.role}`,
            projectPath: task.workspacePath,
            cwd: task.workspacePath,
            permissionMode: stage.role === 'planner' || stage.role === 'reviewer' ? 'default' : 'acceptEdits',
          },
          writer,
        );

        const serialized = stageOutput.map((event) => {
          if (typeof event === 'string') return event;
          try { return JSON.stringify(event); } catch { return String(event); }
        }).join('\n');
        previousOutput = serialized;
        const output = [...task.output, `[${stage.role}]\n${serialized.slice(-20000)}`].slice(-20);
        aureonTasksDb.update(id, { stage_index: index + 1, output_json: JSON.stringify(output), error: null });
      }

      return this.transition(id, 'completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      aureonTasksDb.update(id, { state: 'failed', error: message });
      return fromRow(aureonTasksDb.getById(id))!;
    } finally {
      this.running.delete(id);
    }
  }
}

export const aureonOrchestrator = new AureonOrchestrator();
