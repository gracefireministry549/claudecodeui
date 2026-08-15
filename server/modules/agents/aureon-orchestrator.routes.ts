import { Router } from 'express';

import { aureonOrchestrator } from './aureon-orchestrator.js';

export const aureonOrchestratorRouter = Router();

aureonOrchestratorRouter.get('/tasks', (req, res) => {
  res.json({ tasks: aureonOrchestrator.listTasks(typeof req.query.projectId === 'string' ? req.query.projectId : undefined) });
});

aureonOrchestratorRouter.get('/tasks/:id', (req, res) => {
  const task = aureonOrchestrator.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  return res.json({ task });
});

aureonOrchestratorRouter.post('/tasks', (req, res) => {
  const { projectId, prompt, provider, workspacePath } = req.body ?? {};
  if (typeof projectId !== 'string' || typeof prompt !== 'string' || typeof provider !== 'string') {
    return res.status(400).json({ error: 'projectId, prompt and provider are required' });
  }

  const task = aureonOrchestrator.createTask({
    projectId,
    prompt,
    provider,
    workspacePath: typeof workspacePath === 'string' ? workspacePath : undefined,
  });

  return res.status(201).json({ task });
});

aureonOrchestratorRouter.post('/tasks/:id/run', async (req, res) => {
  try {
    const task = await aureonOrchestrator.runTask(req.params.id);
    return res.json({ task });
  } catch (error) {
    return res.status(404).json({ error: error instanceof Error ? error.message : 'Task not found' });
  }
});

aureonOrchestratorRouter.post('/tasks/:id/transition', (req, res) => {
  const { state } = req.body ?? {};
  if (typeof state !== 'string') return res.status(400).json({ error: 'state is required' });
  try {
    return res.json({ task: aureonOrchestrator.transition(req.params.id, state as never) });
  } catch (error) {
    return res.status(404).json({ error: error instanceof Error ? error.message : 'Task not found' });
  }
});
