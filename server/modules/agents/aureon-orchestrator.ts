import { randomUUID } from 'node:crypto';

import { providerRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';

export type AureonAgentRole = 'planner' | 'builder' | 'tester' | 'reviewer' | 'fixer';
export type AureonTaskState = 'queued' | 'planning' | 'building' | 'testing' | 'reviewing' | 'fixing' | 'completed' | 'failed';

export type AureonTask = {
  id: string;
  projectId: string;
  prompt: string;
  provider: string;
  workspacePath?: string;
  state: AureonTaskState;
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
    tester: 'Run relevant tests, type checks, builds, and targeted checks. Fix straightforward failures caused by the implementation when safe.',
    reviewer: 'Review the implementation for correctness, security, regressions, and missing requirements. Make safe corrective changes when necessary.',
    fixer: 'Resolve remaining test, build, or review issues. Verify the final implementation and leave the workspace in a working state.',
  };

  return [
    `You are Aureon's ${role} agent.`,
    instructions[role],
    `Original task: ${task.prompt}`,
    previousOutput ? `Previous stage output:\n${previousOutput.slice(-12000)}` : '',
  ].filter(Boolean).join('\n\n');
};

export class AureonOrchestrator {
  private readonly tasks = new Map<string, AureonTask>();

  createTask(input: Pick<AureonTask, 'projectId' | 'prompt' | 'provider'> & { workspacePath?: string }): AureonTask {
    const now = new Date().toISOString();
    const task: AureonTask = {
      ...input,
      id: randomUUID(),
      state: 'queued',
      createdAt: now,
      updatedAt: now,
      output: [],
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

  async runTask(id: string): Promise<AureonTask> {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Aureon task not found: ${id}`);

    let previousOutput = '';
    try {
      for (const stage of STAGES) {
        this.transition(id, stage.state);
        const stageOutput: unknown[] = [];
        const writer = {
          isSSEStreamWriter: true,
          userId: null,
          send: (data: unknown) => stageOutput.push(data),
          setSessionId: (_sessionId: string) => undefined,
        };

        await providerRuntimeService.run(
          task.provider as 'claude' | 'codex' | 'cursor' | 'opencode',
          rolePrompt(stage.role, task, previousOutput),
          {
            sessionId: `${task.id}-${stage.role}`,
            projectPath: task.workspacePath,
            cwd: task.workspacePath,
            permissionMode: stage.role === 'planner' || stage.role === 'reviewer' ? 'default' : 'acceptEdits',
          },
          writer,
        );

        const serialized = stageOutput
          .map((event) => {
            if (typeof event === 'string') return event;
            try { return JSON.stringify(event); } catch { return String(event); }
          })
          .join('\n');
        previousOutput = serialized;
        task.output.push(`[${stage.role}]\n${serialized.slice(-20000)}`);
        task.updatedAt = new Date().toISOString();
      }

      return this.transition(id, 'completed');
    } catch (error) {
      task.error = error instanceof Error ? error.message : String(error);
      task.updatedAt = new Date().toISOString();
      this.transition(id, 'failed');
      return task;
    }
  }
}

export const aureonOrchestrator = new AureonOrchestrator();
