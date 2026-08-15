import { Router } from 'express';

import { aureonOrchestrator } from './aureon-orchestrator.js';

export const aureonOrchestratorRouter = Router();

aureonOrchestratorRouter.get('/tasks', (req, res) => {
  res.json({ tasks: aureonOrchestrator.listTasks(typeof req.query.projectId === 'string' ? req.query.projectId : undefined) });
});

aureonOrchestratorRouter.post('/tasks', (req, res) => {
  const { projectId, prompt, provider } = req.body ?? {};
  if (typeof projectId !== 'string' || typeof prompt !== 'string' || typeof provider !== 'string') {
    return res.status(400).json({ error: 'projectId, prompt and provider are required' });
  }
  return res.status(201).json({ task: aureonOrchestrator.createTask({ projectId, prompt, provider }) });
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
