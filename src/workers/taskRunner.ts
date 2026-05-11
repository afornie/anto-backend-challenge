import { Repository } from 'typeorm';
import { Task } from '../models/Task';
import { getJobForTaskType } from '../jobs/JobFactory';
import {WorkflowStatus} from "../workflows/WorkflowFactory";
import {Workflow} from "../models/Workflow";
import {Result} from "../models/Result";

export enum TaskStatus {
    Queued = 'queued',
    InProgress = 'in_progress',
    Completed = 'completed',
    Failed = 'failed'
}

export class TaskRunner {
    constructor(
        private taskRepository: Repository<Task>,
    ) {}

    /**
     * Runs the appropriate job based on the task's type, managing the task's status.
     * @param task - The task entity that determines which job to run.
     * @throws If the job fails, it rethrows the error.
     */
    async run(task: Task): Promise<void> {
        const taskToRun = await this.taskRepository.findOne({
            where: { taskId: task.taskId },
            relations: ['workflow', 'workflow.tasks', 'dependency']
        });

        if (!taskToRun) {
            return;
        }

        const dependency = taskToRun.dependency;
        if (dependency?.status === TaskStatus.Failed && taskToRun.taskType !== 'reportGeneration') {
            await this.failTask(taskToRun, `Dependency task ${dependency.taskId} failed.`);
            await this.updateWorkflowStatus(taskToRun.workflow.workflowId);
            return;
        }

        if (dependency && dependency.status !== TaskStatus.Completed && dependency.status !== TaskStatus.Failed) {
            taskToRun.progress = `waiting for dependency task ${dependency.taskId}...`;
            await this.taskRepository.save(taskToRun);
            return;
        }

        if (taskToRun.taskType === 'reportGeneration' && !this.arePrecedingTasksFinished(taskToRun)) {
            taskToRun.progress = 'waiting for preceding tasks...';
            await this.taskRepository.save(taskToRun);
            return;
        }

        taskToRun.status = TaskStatus.InProgress;
        taskToRun.progress = 'starting job...';
        taskToRun.error = null;
        await this.taskRepository.save(taskToRun);

        try {
            const job = getJobForTaskType(taskToRun.taskType);
            console.log(`Starting job ${taskToRun.taskType} for task ${taskToRun.taskId}...`);
            const resultRepository = this.taskRepository.manager.getRepository(Result);
            const taskResult = await job.run(taskToRun);
            console.log(`Job ${taskToRun.taskType} for task ${taskToRun.taskId} completed successfully.`);
            const serializedResult = JSON.stringify(taskResult ?? null);
            const result = new Result();
            result.taskId = taskToRun.taskId!;
            result.data = serializedResult;
            await resultRepository.save(result);
            taskToRun.resultId = result.resultId!;
            taskToRun.output = serializedResult;
            taskToRun.status = TaskStatus.Completed;
            taskToRun.progress = null;
            await this.taskRepository.save(taskToRun);

        } catch (error: any) {
            console.error(`Error running job ${taskToRun.taskType} for task ${taskToRun.taskId}:`, error);

            await this.failTask(taskToRun, error?.message || 'Unknown task error');
            await this.updateWorkflowStatus(taskToRun.workflow.workflowId);

            throw error;
        }

        await this.updateWorkflowStatus(taskToRun.workflow.workflowId);
    }

    private arePrecedingTasksFinished(task: Task): boolean {
        return task.workflow.tasks
            .filter(workflowTask => workflowTask.taskId !== task.taskId && workflowTask.stepNumber < task.stepNumber)
            .every(workflowTask => workflowTask.status === TaskStatus.Completed || workflowTask.status === TaskStatus.Failed);
    }

    private async failTask(task: Task, message: string): Promise<void> {
        task.status = TaskStatus.Failed;
        task.progress = null;
        task.error = JSON.stringify({ message });
        await this.taskRepository.save(task);
    }

    private async updateWorkflowStatus(workflowId: string): Promise<void> {
        const workflowRepository = this.taskRepository.manager.getRepository(Workflow);
        const currentWorkflow = await workflowRepository.findOne({ where: { workflowId }, relations: ['tasks'] });

        if (currentWorkflow) {
            const allCompleted = currentWorkflow.tasks.every(t => t.status === TaskStatus.Completed);
            const anyFailed = currentWorkflow.tasks.some(t => t.status === TaskStatus.Failed);
            const allFinished = currentWorkflow.tasks.every(t => t.status === TaskStatus.Completed || t.status === TaskStatus.Failed);

            if (anyFailed) {
                currentWorkflow.status = WorkflowStatus.Failed;
            } else if (allCompleted) {
                currentWorkflow.status = WorkflowStatus.Completed;
            } else {
                currentWorkflow.status = WorkflowStatus.InProgress;
            }

            if (allFinished) {
                currentWorkflow.finalResult = JSON.stringify(this.buildFinalResult(currentWorkflow));
            }

            await workflowRepository.save(currentWorkflow);
        }
    }

    private buildFinalResult(workflow: Workflow): Record<string, unknown> {
        const sortedTasks = [...workflow.tasks].sort((left, right) => left.stepNumber - right.stepNumber);

        return {
            workflowId: workflow.workflowId,
            status: workflow.status,
            tasks: sortedTasks.map(task => ({
                taskId: task.taskId,
                type: task.taskType,
                status: task.status,
                output: this.parseStoredValue(task.output),
                error: this.parseStoredValue(task.error)
            }))
        };
    }

    private parseStoredValue(value?: string | null): unknown {
        if (!value) {
            return null;
        }

        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    }
}
