import { randomUUID } from 'node:crypto';

export type AureonAgentRole = 'planner' | 'builder' | 'tester' | 'reviewer' | 'fixer';

export type AureonTaskState = 'queued' | 'planning' | 'building' | 'testing' | 'reviewing' | 'fixing' | 'completed' | 'failed';

export type AureonTask = {
  id: string;
  projectId: string;
  prompt: string;
  provider: string;
  state: AureonTaskState;
  createdAt: string;
  updatedAt: string;
};

/**
 * Provider-neutral orchestration state machine.
 * Actual provider execution remains in Aureon's existing provider layer.
 * This keeps orchestration independent from Claude/Codex/OpenCode/Gemini.
 */
export class AureonOrchestrator {
  private readonly tasks = new Map<string, AureonTask>();

  createTask(input: Pick<AureonTask, 'projectId' | 'prompt' | 'provider'>): AureonTask {
    const now = new Date().toISOString();
    const task: AureonTask = {
      ...input,
      id: randomUUID(),
      state: 'queued',
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  getTask(id: string): AureonTask | undefined {
    return this.tasks.get(id);
  }

  transition(id: string, state: AureonTaskState): AureonTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Aureon task not found: ${id}`);
    task.state = state;
    task.updatedAt = new Date().toISOString();
    return task;
  }

  listTasks(projectId?: string): AureonTask[] {
    return [...this.tasks.values()].filter((task) => !projectId || task.projectId === projectId);
  }
}

export const aureonOrchestrator = new AureonOrchestrator();
