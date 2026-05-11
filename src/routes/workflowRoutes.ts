import { Router } from 'express';
import { AppDataSource } from '../data-source';
import { Workflow } from '../models/Workflow';
import { TaskStatus, WorkflowStatus } from '../models/statuses';

const router = Router();

function parseStoredValue(value?: string | null): unknown {
    if (!value) {
        return null;
    }

    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

router.get('/:id/status', async (req, res) => {
    const workflowRepository = AppDataSource.getRepository(Workflow);
    const workflow = await workflowRepository.findOne({
        where: { workflowId: req.params.id },
        relations: ['tasks']
    });

    if (!workflow) {
        res.status(404).json({ message: 'Workflow not found' });
        return;
    }

    res.json({
        workflowId: workflow.workflowId,
        status: workflow.status,
        completedTasks: workflow.tasks.filter(task => task.status === TaskStatus.Completed).length,
        totalTasks: workflow.tasks.length
    });
});

router.get('/:id/results', async (req, res) => {
    const workflowRepository = AppDataSource.getRepository(Workflow);
    const workflow = await workflowRepository.findOne({
        where: { workflowId: req.params.id },
        relations: ['tasks']
    });

    if (!workflow) {
        res.status(404).json({ message: 'Workflow not found' });
        return;
    }

    if (workflow.status !== WorkflowStatus.Completed) {
        res.status(400).json({ message: 'Workflow is not completed yet' });
        return;
    }

    res.json({
        workflowId: workflow.workflowId,
        status: workflow.status,
        finalResult: parseStoredValue(workflow.finalResult)
    });
});

export default router;
