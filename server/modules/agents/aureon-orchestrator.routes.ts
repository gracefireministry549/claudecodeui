import { Router } from 'express';

import { aureonOrchestrator } from './aureon-orchestrator.js';

export const aureonOrchestratorRouter = Router();

type AuthenticatedRequest = {
  user?: { id?: number | string };
  query: Record<string, unknown>;
  params: Record<string, string>;
  body?: Record<string, unknown>;
};

const getUserId = (req: AuthenticatedRequest): number => {
  const raw = req.user?.id;
  const userId = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(userId) || userId < 1) throw new Error('Authenticated user is required.');
  return userId;
};

aureonOrchestratorRouter.get('/tasks', (req, res) => {
  try {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    return res.json({ tasks: aureonOrchestrator.listTasks(getUserId(req as AuthenticatedRequest), projectId) });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : 'Authentication required' });
  }
});

aureonOrchestratorRouter.get('/tasks/:id', (req, res) => {
  try {
    const task = aureonOrchestrator.getTask(req.params.id, getUserId(req as AuthenticatedRequest));
    if (!task) return res.status(404).json({ error: 'Task not found' });
    return res.json({ task });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : 'Authentication required' });
  }
});

aureonOrchestratorRouter.post('/tasks', (req, res) => {
  try {
    const { projectId, prompt, provider, workspacePath } = req.body ?? {};
    if (typeof projectId !== 'string' || typeof prompt !== 'string' || typeof provider !== 'string') {
      return res.status(400).json({ error: 'projectId, prompt and provider are required' });
    }
    if (!prompt.trim()) return res.status(400).json({ error: 'prompt cannot be empty' });

    const task = aureonOrchestrator.createTask({
      userId: getUserId(req as AuthenticatedRequest),
      projectId,
      prompt,
      provider,
      workspacePath: typeof workspacePath === 'string' ? workspacePath : undefined,
    });

    return res.status(201).json({ task });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create task';
    return res.status(message.includes('Authenticated') ? 401 : 400).json({ error: message });
  }
});

aureonOrchestratorRouter.post('/tasks/:id/run', (req, res) => {
  try {
    const userId = getUserId(req as AuthenticatedRequest);
    const task = aureonOrchestrator.getTask(req.params.id, userId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const queued = aureonOrchestrator.startTask(task.id);
    return res.status(202).json({ task: queued, queued: true });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Unable to run task' });
  }
});

aureonOrchestratorRouter.post('/tasks/:id/resume', (req, res) => {
  try {
    const userId = getUserId(req as AuthenticatedRequest);
    const task = aureonOrchestrator.getTask(req.params.id, userId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    return res.status(202).json({ task: aureonOrchestrator.startTask(task.id), queued: true });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Unable to resume task' });
  }
});

aureonOrchestratorRouter.post('/tasks/:id/transition', (req, res) => {
  const { state } = req.body ?? {};
  if (typeof state !== 'string') return res.status(400).json({ error: 'state is required' });
  try {
    const userId = getUserId(req as AuthenticatedRequest);
    const existing = aureonOrchestrator.getTask(req.params.id, userId);
    if (!existing) return res.status(404).json({ error: 'Task not found' });
    return res.json({ task: aureonOrchestrator.transition(req.params.id, state as never) });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Unable to transition task' });
  }
});
