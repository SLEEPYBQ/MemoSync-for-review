import { createHash } from 'node:crypto';
import type { BaselineProjectCopyAdapter } from '../experiment/baseline-project-copy';
import { createAutoProjectCopyService } from './auto-project-copy';
import type { MemoryService } from './index';
import type { SummaryService } from './summary';

export interface AutoProjectCopyAdapterOptions {
  memory: MemoryService;
  summaries: Pick<SummaryService, 'get'>;

  resolveProject(projectSlug: string): { projectId: string; starterReady: boolean } | undefined;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}


export function createAutoProjectCopyAdapter(
  options: AutoProjectCopyAdapterOptions,
): BaselineProjectCopyAdapter {
  const copy = createAutoProjectCopyService({ memory: options.memory });

  const resolve = (slug: string): string => {
    const project = options.resolveProject(slug);
    if (!project) throw new Error(`Auto Project Copy has no registered study project for ${slug}`);
    if (!project.starterReady) {
      throw new Error(`Auto Project Copy registered study project ${slug} is not ready`);
    }
    return project.projectId;
  };

  return {
    condition: 'auto',

    async prepare(input) {
      const sourceProjectId = resolve(input.fromProjectSlug);
      const targetProjectId = resolve(input.toProjectSlug);


      const receipt = copy.copyOnce({
        transitionKey: input.transitionKey,
        sourceTaskId: input.fromTaskId,
        targetTaskId: input.toTaskId,
        sourceProjectId,
        targetProjectId,
      });
      const sourceSummary = options.summaries.get(sourceProjectId);
      if (sourceSummary.stale) {
        throw new Error(`Auto Project Copy source summary remained stale for ${input.fromProjectSlug}`);
      }
      const targetSummary = options.summaries.get(targetProjectId);
      if (
        targetSummary.stale
        || targetSummary.text !== sourceSummary.text
        || targetSummary.updatedAt !== sourceSummary.updatedAt
      ) {
        throw new Error(`Auto Project Copy did not preserve the source summary for ${input.toProjectSlug}`);
      }

      return {
        sourceRepresentationHash: receipt.sourceRepresentationHash,
        targetRepresentationHash: receipt.targetRepresentationHash,
        manifest: {
          schemaVersion: 1,
          kind: 'auto_project_memory_block',
          outcome: receipt.created ? 'copied' : 'already_present',
          sourceProjectId,
          targetProjectId,
          sourceSnapshotId: input.sourceFreezeRef.snapshotId,
          copiedAt: receipt.copiedAt,
          clones: receipt.clones,
          summaryTextHash: sha256(sourceSummary.text),
        },
      };
    },
  };
}
