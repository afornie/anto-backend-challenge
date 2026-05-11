import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { DataSource } from 'typeorm';
import { Workflow } from '../models/Workflow';
import { Task } from '../models/Task';
import { TaskStatus, WorkflowStatus } from '../models/statuses';

interface WorkflowStep {
    taskType: string;
    stepNumber: number;
    dependsOn?: number | string;
}

interface WorkflowDefinition {
    name: string;
    steps: WorkflowStep[];
}

export class WorkflowFactory {
    constructor(private dataSource: DataSource) {}

    /**
     * Creates a workflow by reading a YAML file and constructing the Workflow and Task entities.
     * @param filePath - Path to the YAML file.
     * @param clientId - Client identifier for the workflow.
     * @param geoJson - The geoJson data string for tasks (customize as needed).
     * @returns A promise that resolves to the created Workflow.
     */
    async createWorkflowFromYAML(filePath: string, clientId: string, geoJson: string): Promise<Workflow> {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const workflowDef = yaml.load(fileContent) as WorkflowDefinition;

        return this.dataSource.transaction(async manager => {
            const workflowRepository = manager.getRepository(Workflow);
            const taskRepository = manager.getRepository(Task);
            const workflow = new Workflow();

            workflow.clientId = clientId;
            workflow.status = WorkflowStatus.Initial;
            workflow.finalResult = null;

            const savedWorkflow = await workflowRepository.save(workflow);

            const tasks: Task[] = workflowDef.steps.map(step => {
                const task = new Task();
                task.clientId = clientId;
                task.geoJson = geoJson;
                task.status = TaskStatus.Queued;
                task.taskType = step.taskType;
                task.stepNumber = step.stepNumber;
                task.workflow = savedWorkflow;
                task.output = null;
                task.error = null;
                return task;
            });

            const savedTasks = await taskRepository.save(tasks);

            for (const [index, step] of workflowDef.steps.entries()) {
                if (step.dependsOn === undefined || step.dependsOn === null) {
                    continue;
                }

                const dependency = this.findDependencyTask(savedTasks, step.dependsOn);
                if (!dependency) {
                    throw new Error(`Dependency ${step.dependsOn} for step ${step.stepNumber} was not found`);
                }

                savedTasks[index].dependency = dependency;
            }

            await taskRepository.save(savedTasks);

            return savedWorkflow;
        });
    }

    private findDependencyTask(tasks: Task[], dependsOn: number | string): Task | undefined {
        if (typeof dependsOn === 'number') {
            return tasks.find(task => task.stepNumber === dependsOn);
        }

        const dependencyStepNumber = Number(dependsOn);
        if (Number.isInteger(dependencyStepNumber)) {
            return tasks.find(task => task.stepNumber === dependencyStepNumber);
        }

        return tasks.find(task => task.taskType === dependsOn);
    }
}
