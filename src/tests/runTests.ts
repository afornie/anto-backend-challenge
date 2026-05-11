import 'reflect-metadata';
import assert from 'assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { PolygonAreaJob } from '../jobs/PolygonAreaJob';
import { ReportGenerationJob } from '../jobs/ReportGenerationJob';
import { Result } from '../models/Result';
import { TaskStatus, WorkflowStatus } from '../models/statuses';
import { Task } from '../models/Task';
import { Workflow } from '../models/Workflow';
import { TaskRunner } from '../workers/taskRunner';
import { WorkflowFactory } from '../workflows/WorkflowFactory';

type TestCase = {
    name: string;
    run: () => Promise<void> | void;
};

const tests: TestCase[] = [];

function test(name: string, run: TestCase['run']): void {
    tests.push({ name, run });
}

function createTestDataSource(): Promise<DataSource> {
    return new DataSource({
        type: 'sqlite',
        database: ':memory:',
        dropSchema: true,
        entities: [Task, Result, Workflow],
        synchronize: true,
        logging: false
    }).initialize();
}

const samplePolygon = JSON.stringify({
    type: 'Polygon',
    coordinates: [[
        [-63.624885020050996, -10.311050368263523],
        [-63.624885020050996, -10.367865108370523],
        [-63.61278302732815, -10.367865108370523],
        [-63.61278302732815, -10.311050368263523],
        [-63.624885020050996, -10.311050368263523]
    ]]
});

const invalidPoint = JSON.stringify({
    type: 'Point',
    coordinates: [0, 0]
});

function writeTempWorkflowYaml(content: string): string {
    const filePath = path.join(os.tmpdir(), `workflow-${process.pid}-${Date.now()}-${Math.random()}.yml`);
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
}

async function runQueuedTasks(dataSource: DataSource): Promise<void> {
    const taskRepository = dataSource.getRepository(Task);
    const taskRunner = new TaskRunner(taskRepository);

    for (let attempts = 0; attempts < 10; attempts += 1) {
        const queuedTasks = await taskRepository.find({
            where: { status: TaskStatus.Queued },
            relations: ['workflow', 'dependency'],
            order: { stepNumber: 'ASC' }
        });

        if (queuedTasks.length === 0) {
            return;
        }

        for (const task of queuedTasks) {
            try {
                await taskRunner.run(task);
            } catch {
                // TaskRunner persists failed task state; the worker also swallows job errors.
            }
        }
    }

    throw new Error('Queued tasks did not finish within the test attempt limit');
}

function parseStoredJson<T>(value?: string | null): T {
    assert.ok(value, 'Expected a stored JSON value');
    return JSON.parse(value) as T;
}

test('PolygonAreaJob stores a positive area for valid polygon GeoJSON', async () => {
    const task = new Task();
    task.taskId = 'polygon-area-test';
    task.geoJson = samplePolygon;

    const result = await new PolygonAreaJob().run(task);

    assert.ok(result.areaInSquareMeters > 0);
});

test('PolygonAreaJob rejects non-polygon GeoJSON with a useful error', async () => {
    const task = new Task();
    task.taskId = 'invalid-polygon-test';
    task.geoJson = invalidPoint;

    await assert.rejects(
        () => new PolygonAreaJob().run(task),
        /expected a Polygon or MultiPolygon/
    );
});

test('WorkflowFactory creates task dependencies from dependsOn step numbers', async () => {
    const dataSource = await createTestDataSource();
    const workflowFile = writeTempWorkflowYaml(`
name: dependency_test
steps:
  - taskType: polygonArea
    stepNumber: 1
  - taskType: analysis
    stepNumber: 2
    dependsOn: 1
  - taskType: reportGeneration
    stepNumber: 3
    dependsOn: 2
`);

    try {
        const workflow = await new WorkflowFactory(dataSource).createWorkflowFromYAML(
            workflowFile,
            'client-1',
            samplePolygon
        );

        const tasks = await dataSource.getRepository(Task).find({
            where: { workflow: { workflowId: workflow.workflowId } },
            relations: ['dependency'],
            order: { stepNumber: 'ASC' }
        });

        assert.equal(tasks.length, 3);
        assert.equal(tasks[0].dependency, null);
        assert.equal(tasks[1].dependency?.taskId, tasks[0].taskId);
        assert.equal(tasks[2].dependency?.taskId, tasks[1].taskId);
    } finally {
        fs.unlinkSync(workflowFile);
        await dataSource.destroy();
    }
});

test('TaskRunner completes a dependent workflow and saves aggregated finalResult', async () => {
    const dataSource = await createTestDataSource();
    const workflowFile = writeTempWorkflowYaml(`
name: full_success_test
steps:
  - taskType: polygonArea
    stepNumber: 1
  - taskType: analysis
    stepNumber: 2
    dependsOn: 1
  - taskType: reportGeneration
    stepNumber: 3
    dependsOn: 2
  - taskType: notification
    stepNumber: 4
    dependsOn: 3
`);

    try {
        const workflow = await new WorkflowFactory(dataSource).createWorkflowFromYAML(
            workflowFile,
            'client-1',
            samplePolygon
        );

        await runQueuedTasks(dataSource);

        const savedWorkflow = await dataSource.getRepository(Workflow).findOneOrFail({
            where: { workflowId: workflow.workflowId },
            relations: ['tasks']
        });

        assert.equal(savedWorkflow.status, WorkflowStatus.Completed);
        const finalResult = parseStoredJson<{
            workflowId: string;
            status: WorkflowStatus;
            tasks: Array<{ type: string; status: TaskStatus; output: unknown }>;
        }>(savedWorkflow.finalResult);

        assert.equal(finalResult.workflowId, workflow.workflowId);
        assert.equal(finalResult.status, WorkflowStatus.Completed);
        assert.deepEqual(
            finalResult.tasks.map(task => task.type),
            ['polygonArea', 'analysis', 'reportGeneration', 'notification']
        );

        const polygonAreaTask = finalResult.tasks.find(task => task.type === 'polygonArea');
        assert.ok(polygonAreaTask);
        assert.equal(polygonAreaTask.status, TaskStatus.Completed);
        assert.ok((polygonAreaTask.output as { areaInSquareMeters: number }).areaInSquareMeters > 0);

        const analysisTask = finalResult.tasks.find(task => task.type === 'analysis');
        assert.ok(analysisTask);
        assert.equal(analysisTask.output, 'Brazil');
    } finally {
        fs.unlinkSync(workflowFile);
        await dataSource.destroy();
    }
});

test('TaskRunner saves failure details in workflow finalResult', async () => {
    const dataSource = await createTestDataSource();

    try {
        const workflowRepository = dataSource.getRepository(Workflow);
        const taskRepository = dataSource.getRepository(Task);
        const workflow = await workflowRepository.save({
            clientId: 'client-1',
            status: WorkflowStatus.Initial,
            finalResult: null
        });

        const task = await taskRepository.save({
            clientId: 'client-1',
            geoJson: invalidPoint,
            status: TaskStatus.Queued,
            taskType: 'polygonArea',
            stepNumber: 1,
            workflow
        });

        const originalConsoleError = console.error;
        console.error = () => undefined;
        try {
            await assert.rejects(() => new TaskRunner(taskRepository).run(task));
        } finally {
            console.error = originalConsoleError;
        }

        const savedWorkflow = await workflowRepository.findOneOrFail({
            where: { workflowId: workflow.workflowId },
            relations: ['tasks']
        });

        assert.equal(savedWorkflow.status, WorkflowStatus.Failed);
        const finalResult = parseStoredJson<{
            status: WorkflowStatus;
            tasks: Array<{ status: TaskStatus; error: { message: string } }>;
        }>(savedWorkflow.finalResult);

        assert.equal(finalResult.status, WorkflowStatus.Failed);
        assert.equal(finalResult.tasks[0].status, TaskStatus.Failed);
        assert.match(finalResult.tasks[0].error.message, /expected a Polygon or MultiPolygon/);
    } finally {
        await dataSource.destroy();
    }
});

test('ReportGenerationJob includes outputs and errors from preceding tasks', async () => {
    const workflow = new Workflow();
    workflow.workflowId = 'workflow-1';
    workflow.tasks = [];

    const completedTask = new Task();
    completedTask.taskId = 'task-1';
    completedTask.taskType = 'polygonArea';
    completedTask.stepNumber = 1;
    completedTask.status = TaskStatus.Completed;
    completedTask.output = JSON.stringify({ areaInSquareMeters: 123 });

    const failedTask = new Task();
    failedTask.taskId = 'task-2';
    failedTask.taskType = 'analysis';
    failedTask.stepNumber = 2;
    failedTask.status = TaskStatus.Failed;
    failedTask.error = JSON.stringify({ message: 'analysis failed' });

    const reportTask = new Task();
    reportTask.taskId = 'task-3';
    reportTask.taskType = 'reportGeneration';
    reportTask.stepNumber = 3;
    reportTask.status = TaskStatus.Queued;
    reportTask.workflow = workflow;

    workflow.tasks = [completedTask, failedTask, reportTask];

    const report = await new ReportGenerationJob().run(reportTask);

    assert.equal(report.workflowId, workflow.workflowId);
    assert.match(String(report.finalReport), /1 failed task/);
    assert.deepEqual(report.tasks, [
        {
            taskId: 'task-1',
            type: 'polygonArea',
            status: TaskStatus.Completed,
            output: { areaInSquareMeters: 123 },
            error: null
        },
        {
            taskId: 'task-2',
            type: 'analysis',
            status: TaskStatus.Failed,
            output: null,
            error: { message: 'analysis failed' }
        }
    ]);
});

async function main(): Promise<void> {
    let failedTests = 0;

    for (const { name, run } of tests) {
        try {
            await run();
            console.log(`ok - ${name}`);
        } catch (error) {
            failedTests += 1;
            console.error(`not ok - ${name}`);
            console.error(error);
        }
    }

    if (failedTests > 0) {
        process.exitCode = 1;
        return;
    }

    console.log(`\n${tests.length} tests passed`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
