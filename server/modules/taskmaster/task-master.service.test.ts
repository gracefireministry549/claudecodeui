import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskMasterService } from './task-master.service.js';

test('Task Master service passes arguments without shell interpolation', async () => {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const service = createTaskMasterService(async (cwd, args) => {
    calls.push({ cwd, args });
    return { stdout: 'ok', stderr: '' };
  });

  await service.updateSubtask('/workspace/project', '2.1', 'keep $(touch /tmp/should-not-run) literal');

  assert.deepEqual(calls, [
    {
      cwd: '/workspace/project',
      args: [
        'update-subtask',
        '--id=2.1',
        '--prompt=keep $(touch /tmp/should-not-run) literal',
      ],
    },
  ]);
});

test('Task Master availability is false when the CLI cannot execute', async () => {
  const service = createTaskMasterService(async () => {
    throw new Error('command not found');
  });

  assert.equal(await service.isAvailable('/workspace/project'), false);
});

test('Task Master list builds only the requested flags', async () => {
  const calls: string[][] = [];
  const service = createTaskMasterService(async (_cwd, args) => {
    calls.push(args);
    return { stdout: '', stderr: '' };
  });

  await service.list('/workspace/project', { status: 'in-progress', withSubtasks: true });

  assert.deepEqual(calls, [['list', '--status=in-progress', '--with-subtasks']]);
});
