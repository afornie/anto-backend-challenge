import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from 'typeorm';
import { Task } from './Task';
import { WorkflowStatus } from './statuses';

@Entity({ name: 'workflows' })
export class Workflow {
    @PrimaryGeneratedColumn('uuid')
    workflowId!: string;

    @Column()
    clientId!: string;

    @Column({ default: WorkflowStatus.Initial })
    status!: WorkflowStatus;

    @Column({ nullable: true, type: 'text' })
    finalResult?: string | null;

    @OneToMany(() => Task, task => task.workflow)
    tasks!: Task[];
}
