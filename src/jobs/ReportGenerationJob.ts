import { Job } from './Job';
import { Task } from '../models/Task';
import { TaskStatus } from '../models/statuses';

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

export class ReportGenerationJob implements Job {
    async run(task: Task): Promise<Record<string, unknown>> {
        console.log(`Generating report for workflow ${task.workflow.workflowId}...`);

        const workflowTasks = task.workflow.tasks || [];
        const precedingTasks = workflowTasks
            .filter(workflowTask => workflowTask.taskId !== task.taskId && workflowTask.stepNumber < task.stepNumber)
            .sort((left, right) => left.stepNumber - right.stepNumber);

        const tasks = precedingTasks.map(workflowTask => ({
            taskId: workflowTask.taskId,
            type: workflowTask.taskType,
            status: workflowTask.status,
            output: parseStoredValue(workflowTask.output),
            error: parseStoredValue(workflowTask.error)
        }));

        const failedTasks = tasks.filter(reportTask => reportTask.status === TaskStatus.Failed);

        return {
            workflowId: task.workflow.workflowId,
            tasks,
            finalReport: failedTasks.length > 0
                ? `Aggregated report generated with ${failedTasks.length} failed task(s).`
                : 'Aggregated report generated successfully.'
        };
    }
}
