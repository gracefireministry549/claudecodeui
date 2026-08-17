import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { aureonTasksDb, projectsDb } from '@/modules/database/index.js';
import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import { providerRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import { taskMasterService } from '@/modules/taskmaster/task-master.service.js';
import type { LLMProvider } from '@/shared/types.js';

export type AureonAgentRole = 'planner' | 'builder' | 'tester' | 'reviewer' | 'fixer';
export type AureonTaskState = 'queued' | 'planning' | 'building' | 'testing' | 'reviewing' | 'fixing' | 'completed' | 'failed';
export type AureonTask = {
  id: string; userId: number; projectId: string; prompt: string; provider: LLMProvider;
  workspacePath: string; state: AureonTaskState; stageIndex: number;
  createdAt: string; updatedAt: string; output: string[]; error?: string;
};

const STAGES: Array<{ role: AureonAgentRole; state: AureonTaskState }> = [
  { role: 'planner', state: 'planning' },
  { role: 'builder', state: 'building' },
  { role: 'tester', state: 'testing' },
  { role: 'reviewer', state: 'reviewing' },
  { role: 'fixer', state: 'fixing' },
];

const taskMasterStatusFor = (state: AureonTaskState): string | null => {
  if (state === 'completed') return 'done';
  if (state === 'reviewing') return 'review';
  if (state === 'failed') return 'deferred';
  if (state === 'planning' || state === 'building' || state === 'testing' || state === 'fixing') return 'in-progress';
  return null;
};

const extractTaskMasterId = (text: string): string | undefined => {
  const jsonMatch = text.match(/(?:"id"|\bid)\s*[:=]\s*["']?(\d+(?:\.\d+)?)/i);
  if (jsonMatch?.[1]) return jsonMatch[1];
  const taskMatch = text.match(/(?:task\s*)?#?(\d+(?:\.\d+)?)/i);
  return taskMatch?.[1];
};

const rolePrompt = (role: AureonAgentRole, task: AureonTask, previousOutput: string) => {
  const instructions: Record<AureonAgentRole, string> = {
    planner: 'Analyze the request and codebase, produce a concrete implementation plan, and identify risks. Do not make changes.',
    builder: 'Implement the requested changes in the workspace. Inspect existing code first, preserve working functionality, and make the smallest safe changes.',
    tester: 'Run relevant tests, type checks, builds, and targeted checks. Record every failure. Only make a small corrective change when it is clearly caused by this task.',
    reviewer: 'Review the implementation and diff for correctness, security, regressions, and missing requirements. Record any issue that must be fixed.',
    fixer: 'Resolve remaining test, build, or review issues. If no fix is required, verify that and report no changes were necessary. Never modify files outside the selected workspace.',
  };
  return [
    `You are Aureon's ${role} agent.`, instructions[role], `Original task: ${task.prompt}`,
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
  } catch { output = []; }
  return {
    id: row.id, userId: row.user_id, projectId: row.project_id, prompt: row.prompt,
    provider: row.provider, workspacePath: row.workspace_path, state: row.state,
    stageIndex: row.stage_index, createdAt: row.created_at, updatedAt: row.updated_at,
    output, ...(row.error ? { error: row.error } : {}),
  };
};

/**
 * Durable Aureon pipeline with Task Master acting as the external task planner/status board.
 * Aureon remains responsible for provider execution; Task Master mirrors the lifecycle.
 */
export class AureonOrchestrator {
  private readonly running = new Set<string>();
  private readonly taskMasterIds = new Map<string, string>();

  createTask(input: { userId: number; projectId: string; prompt: string; provider: string; workspacePath?: string }): AureonTask {
    if (!isProvider(input.provider)) throw new Error(`Unsupported provider "${input.provider}".`);
    if (!input.prompt?.trim()) throw new Error('Aureon task prompt is required.');
    const project = projectsDb.getProjectById(input.projectId);
    if (!project) throw new Error('Project not found.');
    const workspacePath = input.workspacePath ? path.resolve(input.workspacePath) : path.resolve(project.project_path);
    if (!isInsideWorkspace(workspacePath, project.project_path)) throw new Error('Workspace must be inside the selected project.');
    return fromRow(aureonTasksDb.create({
      id: randomUUID(), userId: input.userId, projectId: input.projectId,
      prompt: input.prompt.trim(), provider: input.provider, workspacePath, state: 'queued',
    }))!;
  }

  getTask(id: string, userId: number) { return fromRow(aureonTasksDb.getByIdForUser(id, userId)); }
  listTasks(userId: number, projectId?: string) { return aureonTasksDb.list(userId, projectId).map(fromRow).filter((task): task is AureonTask => Boolean(task)); }

  transition(id: string, state: AureonTaskState): AureonTask {
    const updated = aureonTasksDb.update(id, { state });
    const task = fromRow(updated);
    if (!task) throw new Error(`Aureon task not found: ${id}`);
    void this.syncTaskMasterStatus(task);
    return task;
  }

  startTask(id: string): AureonTask {
    const task = fromRow(aureonTasksDb.getById(id));
    if (!task) throw new Error(`Aureon task not found: ${id}`);
    if (!this.running.has(id) && task.state !== 'completed') void Promise.resolve().then(() => this.runTask(id));
    return task;
  }

  recoverTasks(): void {
    for (const row of aureonTasksDb.listRecoverable()) {
      if (row.state === 'failed') continue;
      void Promise.resolve().then(() => this.runTask(row.id));
    }
  }

  private async ensureTaskMasterTask(task: AureonTask): Promise<void> {
    if (this.taskMasterIds.has(task.id)) return;
    try {
      if (!(await taskMasterService.isAvailable(task.workspacePath))) return;
      const result = await taskMasterService.addTask(task.workspacePath, `[Aureon ${task.id}] ${task.prompt}`);
      const id = extractTaskMasterId(`${result.stdout}\n${result.stderr}`);
      if (id) this.taskMasterIds.set(task.id, id);
    } catch (error) {
      // Task Master is an orchestration aid; its failure must not destroy the durable Aureon run.
      const message = error instanceof Error ? error.message : String(error);
      const current = fromRow(aureonTasksDb.getById(task.id));
      if (current) aureonTasksDb.update(task.id, {
        output_json: JSON.stringify([...current.output, `[task-master-warning] ${message}`].slice(-20)),
      });
    }
  }

  private async syncTaskMasterStatus(task: AureonTask): Promise<void> {
    const taskMasterId = this.taskMasterIds.get(task.id);
    const status = taskMasterStatusFor(task.state);
    if (!taskMasterId || !status) return;
    try {
      await taskMasterService.setStatus(task.workspacePath, taskMasterId, status);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = fromRow(aureonTasksDb.getById(task.id));
      if (current) aureonTasksDb.update(task.id, {
        output_json: JSON.stringify([...current.output, `[task-master-warning] status sync failed: ${message}`].slice(-20)),
      });
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
      await this.ensureTaskMasterTask(initial);
      const auth = await providerAuthService.getProviderAuthStatus(initial.provider);
      if (!auth.authenticated) {
        aureonTasksDb.update(id, { state: 'failed', error: auth.error || `${initial.provider} is not authenticated.` });
        const failed = fromRow(aureonTasksDb.getById(id))!;
        await this.syncTaskMasterStatus(failed);
        return failed;
      }

      let task = fromRow(aureonTasksDb.getById(id))!;
      let previousOutput = task.output.join('\n').slice(-12000);

      for (let index = task.stageIndex; index < STAGES.length; index += 1) {
        const stage = STAGES[index];
        aureonTasksDb.update(id, { state: stage.state, stage_index: index });
        task = fromRow(aureonTasksDb.getById(id))!;
        await this.syncTaskMasterStatus(task);

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
        aureonTasksDb.update(id, {
          stage_index: index + 1,
          output_json: JSON.stringify(output),
          error: null,
        });

        // Keep Task Master useful between agents: the latest stage result becomes the next task's context.
        const taskMasterId = this.taskMasterIds.get(id);
        if (taskMasterId && serialized) {
          try {
            await taskMasterService.updateSubtask(task.workspacePath, taskMasterId, `${stage.role} completed. Next stage context:\n${serialized.slice(-6000)}`);
          } catch {
            // Status/output persistence in Aureon remains authoritative if Task Master cannot be updated.
          }
        }
      }

      return this.transition(id, 'completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      aureonTasksDb.update(id, { state: 'failed', error: message });
      const failed = fromRow(aureonTasksDb.getById(id))!;
      await this.syncTaskMasterStatus(failed);
      return failed;
    } finally {
      this.running.delete(id);
    }
  }
}

export const aureonOrchestrator = new AureonOrchestrator();
