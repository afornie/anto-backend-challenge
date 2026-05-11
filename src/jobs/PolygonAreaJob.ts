import area from '@turf/area';
import { Feature, GeoJsonProperties, Polygon, MultiPolygon } from 'geojson';
import { Job } from './Job';
import { Task } from '../models/Task';

type PolygonInput = Feature<Polygon | MultiPolygon, GeoJsonProperties> | Polygon | MultiPolygon;

function parsePolygonInput(geoJson: string): PolygonInput {
    let parsed: unknown;

    try {
        parsed = JSON.parse(geoJson);
    } catch {
        throw new Error('Invalid GeoJSON: input is not valid JSON');
    }

    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid GeoJSON: input must be an object');
    }

    const candidate = parsed as { type?: string; geometry?: { type?: string } };
    const geometryType = candidate.type === 'Feature' ? candidate.geometry?.type : candidate.type;

    if (geometryType !== 'Polygon' && geometryType !== 'MultiPolygon') {
        throw new Error('Invalid GeoJSON: expected a Polygon or MultiPolygon');
    }

    return parsed as PolygonInput;
}

export class PolygonAreaJob implements Job {
    async run(task: Task): Promise<{ areaInSquareMeters: number }> {
        console.log(`Calculating polygon area for task ${task.taskId}...`);

        const polygon = parsePolygonInput(task.geoJson);
        const areaInSquareMeters = area(polygon);

        if (!Number.isFinite(areaInSquareMeters)) {
            throw new Error('Invalid GeoJSON: area calculation did not produce a finite number');
        }

        return { areaInSquareMeters };
    }
}
