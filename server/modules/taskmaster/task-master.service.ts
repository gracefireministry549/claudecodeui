import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type TaskMasterCommandResult = {
  stdout: string;
  stderr: string;
};

type TaskMasterExecutor = (
  cwd: string,
  args: string[],
) => Promise<TaskMasterCommandResult>;

const defaultExecutor: TaskMasterExecutor = async (cwd, args) => {
  const result = await execFileAsync('task-master', args, {
    cwd,
    shell: false,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });

  return {
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
};

const assertWorkspace = (workspacePath: string): string => {
  if (!workspacePath || !workspacePath.trim()) {
    throw new Error('Task Master workspace is required.');
  }

  return workspacePath.trim();
};

/**
 * Application-facing adapter for Task Master.
 *
 * Aureon deliberately talks to Task Master through its CLI instead of importing
 * Task Master's internal source. This keeps Aureon provider-neutral and lets
 * users install/update Task Master independently. Arguments are passed through
 * execFile with shell disabled so task text can never become shell syntax.
 */
export function createTaskMasterService(
  executor: TaskMasterExecutor = defaultExecutor,
) {
  const run = async (
    workspacePath: string,
    args: string[],
  ): Promise<TaskMasterCommandResult> => {
    const cwd = assertWorkspace(workspacePath);
    return executor(cwd, args);
  };

  return {
    run,

    async isAvailable(workspacePath: string): Promise<boolean> {
      try {
        await run(workspacePath, ['--version']);
        return true;
      } catch {
        return false;
      }
    },

    initialize(workspacePath: string) {
      return run(workspacePath, ['init']);
    },

    list(workspacePath: string, options: { status?: string; withSubtasks?: boolean } = {}) {
      const args = ['list'];
      if (options.status) args.push(`--status=${options.status}`);
      if (options.withSubtasks) args.push('--with-subtasks');
      return run(workspacePath, args);
    },

    next(workspacePath: string) {
      return run(workspacePath, ['next']);
    },

    show(workspacePath: string, id: string) {
      if (!id.trim()) throw new Error('Task Master task id is required.');
      return run(workspacePath, ['show', id.trim()]);
    },

    setStatus(workspacePath: string, id: string, status: string) {
      if (!id.trim()) throw new Error('Task Master task id is required.');
      if (!status.trim()) throw new Error('Task Master status is required.');
      return run(workspacePath, [
        'set-status',
        `--id=${id.trim()}`,
        `--status=${status.trim()}`,
      ]);
    },

    updateSubtask(workspacePath: string, id: string, prompt: string) {
      if (!id.trim()) throw new Error('Task Master subtask id is required.');
      if (!prompt.trim()) throw new Error('Task Master update prompt is required.');
      return run(workspacePath, [
        'update-subtask',
        `--id=${id.trim()}`,
        `--prompt=${prompt}`,
      ]);
    },
  };
}

export const taskMasterService = createTaskMasterService();
