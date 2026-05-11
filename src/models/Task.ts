import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Workflow } from './Workflow';
import {TaskStatus} from "../workers/taskRunner";

@Entity({ name: 'tasks' })
export class Task {
    @PrimaryGeneratedColumn('uuid')
    taskId!: string;

    @Column()
    clientId!: string;

    @Column('text')
    geoJson!: string;

    @Column()
    status!: TaskStatus;

    @Column({ nullable: true, type: 'text' })
    progress?: string | null;

    @Column({ nullable: true })
    resultId?: string;

    @Column({ nullable: true, type: 'text' })
    output?: string | null;

    @Column({ nullable: true, type: 'text' })
    error?: string | null;

    @Column()
    taskType!: string;

    @Column({ default: 1 })
    stepNumber!: number;

    @ManyToOne(() => Workflow, workflow => workflow.tasks)
    workflow!: Workflow;

    @ManyToOne(() => Task, { nullable: true })
    @JoinColumn({ name: 'dependencyTaskId' })
    dependency?: Task | null;
}
