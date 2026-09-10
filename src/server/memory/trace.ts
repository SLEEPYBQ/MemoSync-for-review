

import type { LlmJsonCaller } from './deepseek';
import type { MemoryItem } from './types';
import type { ExperimentLogger } from '../experiment/logger';

export type TraceLabel = 'operational' | 'injected_without_effect' | 'violated' | 'not_applicable';


export type TraceViolationImpact = 'negative' | 'none';

export interface TraceInput {
  sessionId: string;
  engine?: string;
  turn?: number;
  userText: string;
  assistantText: string;

  executionText?: string;

  executionTools?: Array<{ toolId: string; text: string }>;

  usedMemories: MemoryItem[];
}


export type TraceViolationCause = 'not_followed' | 'memory_conflict';

export interface TraceOutcome {


  labels: Array<{ id: string; label: TraceLabel; note?: string; quote?: string; toolId?: string; cause?: TraceViolationCause; missing?: string; impact?: TraceViolationImpact }>;


  summary?: string;
}

export interface TraceService {
  trace(input: TraceInput): Promise<TraceOutcome>;
}

const VALID_LABELS = new Set<TraceLabel>(['operational', 'injected_without_effect', 'violated', 'not_applicable']);

const SYSTEM_PROMPT = [
  'You are the Trace auditor for MemoSync, a memory-augmented coding assistant.',
  'You will be given one turn (the user message and the assistant response) plus the memory items',
  'that were available to the assistant this turn. Label EACH memory by walking this decision tree IN ORDER:',
  '1. Did this turn\'s response or actions contain anything the memory could apply to?',
  '   NO -> "not_applicable" (there was no object or opportunity for it).',
  '2. It had something to apply to. Did the response follow what the memory prescribes?',
  '   NO -> "violated".',
  '3. It followed the memory. Can you point at a visible difference it made?',
  '   YES -> "operational". NO -> "injected_without_effect" (included, but no detectable influence).',
  'Worked example — memory: "generated images must use vivid colors":',
  '- the response produced no image at all -> "not_applicable" (nothing to apply it to), NOT "violated";',
  '- the response produced an image with dull colors -> "violated";',
  '- the response produced a vivid image -> "operational".',
  'Do NOT hunt for conflicts between memories — conflict review happens in a separate checkup;',
  'judge only how each memory related to THIS turn\'s output.',
  'For "not_applicable" entries, ALSO include "missing": one short phrase naming the absent object or',
  'opportunity (e.g. "no image in this output"). A "not_applicable" without "missing" will be rejected.',
  'For "operational" and "violated" entries, ALSO include "quote": the shortest span copied VERBATIM',
  '(character-for-character, do not paraphrase or shorten) from the Assistant response that shows where the',
  'memory took effect or was violated. Omit "quote" for "injected_without_effect" and "not_applicable".',
  'For "violated" entries, ALSO include "cause": "not_followed" (the memory is right; the assistant',
  'simply did not comply) or "memory_conflict" (the memory itself clashes with the task or with another',
  'memory, so complying was impossible or wrong), AND "impact": "negative" (the violation visibly hurt',
  'the outcome) or "none" (violated, but with no visible damage).',
  'ALSO include "summary": ONE plain-English sentence (at most 140 characters) recapping what the',
  'assistant did this turn. The summary renders in a UI where every bracketed [M-NN] becomes a',
  'clickable memory chip, and citing an id ASSERTS that this memory actively shaped or was violated',
  'by this turn — so cite ONLY ids you labeled operational or violated, placed inline at the point',
  'in the sentence where that effect is described, e.g. "Gave the test command per [M-10] but',
  'ignored the port rule [M-14]." Do NOT append a list of citations at the end of the sentence,',
  'do NOT write bare ids without brackets, and do NOT mention no-effect memories at all.',
  'Respond with strict JSON only, no prose:',
  '{"summary":"...","labels":[{"id":"M-01","label":"operational","note":"short reason","quote":"exact text from the response"},{"id":"M-02","label":"not_applicable","note":"short reason","missing":"no image in this output"}]}.',
  'Include exactly one label entry per memory id given, in any order, each with a short (<20 word) note.',
].join('\n');


function formatMemoryForPrompt(m: MemoryItem): string {
  const lines = [`[${m.id}] type=${m.type} scope=${m.scope}`, `content: ${m.content}`];
  if (m.detail) lines.push(`detail: ${m.detail}`);
  return lines.join('\n');
}

function buildUserPrompt(input: TraceInput): string {


  return [
    `Memories used this turn:\n${input.usedMemories.map(formatMemoryForPrompt).join('\n\n')}`,
    `User message:\n${input.userText}`,
    `Assistant response:\n${input.assistantText}`,
    ...(input.executionText ? [`Tool calls and results:\n${input.executionText}`] : []),
  ].join('\n\n');
}


function readLabelEntry(entry: unknown): TraceOutcome['labels'][number] | null {
  if (!entry || typeof entry !== 'object') return null;
  const id = (entry as Record<string, unknown>).id;
  if (typeof id !== 'string') return null;
  const rawLabel = (entry as Record<string, unknown>).label;
  const label = typeof rawLabel === 'string' && VALID_LABELS.has(rawLabel as TraceLabel) ? (rawLabel as TraceLabel) : 'injected_without_effect';
  const rawNote = (entry as Record<string, unknown>).note;
  const note = typeof rawNote === 'string' ? rawNote : undefined;
  const rawQuote = (entry as Record<string, unknown>).quote;
  const quote = typeof rawQuote === 'string' && rawQuote.trim() ? rawQuote : undefined;
  const rawToolId = (entry as Record<string, unknown>).toolId;
  const toolId = typeof rawToolId === 'string' && rawToolId.trim() ? rawToolId.trim() : undefined;
  const rawCause = (entry as Record<string, unknown>).cause;
  const cause = rawCause === 'not_followed' || rawCause === 'memory_conflict' ? rawCause : undefined;
  const rawMissing = (entry as Record<string, unknown>).missing;
  const missing = typeof rawMissing === 'string' && rawMissing.trim() ? rawMissing.trim() : undefined;
  const rawImpact = (entry as Record<string, unknown>).impact;
  const impact = rawImpact === 'negative' || rawImpact === 'none' ? rawImpact : undefined;
  return { id, label, note, quote, toolId, cause, missing, impact };
}


export function createTraceService(opts: { callJson: LlmJsonCaller; logger?: Pick<ExperimentLogger, 'event'> }): TraceService {
  return {
    async trace(input: TraceInput): Promise<TraceOutcome> {
      if (input.usedMemories.length === 0) return { labels: [] };


      const raw = await opts.callJson({ system: SYSTEM_PROMPT, user: buildUserPrompt(input), maxTokens: 6000 });
      return coerceTraceOutcome(raw, input);
    },
  };
}


export function coerceTraceOutcome(
  raw: Record<string, unknown>,
  input: Pick<TraceInput, 'usedMemories' | 'assistantText' | 'executionText' | 'executionTools'>,
): TraceOutcome {
  {
      const validIds = new Set(input.usedMemories.map((m) => m.id));
      const byId = new Map<string, Omit<TraceOutcome['labels'][number], 'id'>>();
      const rawLabels = Array.isArray(raw.labels) ? raw.labels : [];
      for (const entry of rawLabels) {
        const parsed = readLabelEntry(entry);
        if (!parsed || !validIds.has(parsed.id)) continue;


        if (parsed.label === 'not_applicable' && !parsed.missing) {
          byId.set(parsed.id, { label: 'injected_without_effect', note: parsed.note });
          continue;
        }
        byId.set(parsed.id, { label: parsed.label, note: parsed.note, quote: parsed.quote, toolId: parsed.toolId, cause: parsed.cause, missing: parsed.missing, impact: parsed.impact });
      }


      const normalizeQuote = (s: string) => s.replace(/[*_`~#>[\]()]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      const normalizedAssistant = normalizeQuote([input.assistantText, input.executionText ?? '', ...(input.executionTools ?? []).map((tool) => tool.text)].join('\n'));


      const labels = input.usedMemories.map((m) => {
        const found = byId.get(m.id);
        if (found) {


          const keepQuote = found.quote
            && (found.label === 'operational' || found.label === 'violated')
            && normalizeQuote(found.quote).length > 0
            && normalizedAssistant.includes(normalizeQuote(found.quote));


          const matchedTool = keepQuote ? input.executionTools?.find((tool) =>
            (!found.toolId || found.toolId === tool.toolId)
            && normalizeQuote(tool.text).includes(normalizeQuote(found.quote!)),
          ) : undefined;
          return {
            id: m.id,
            label: found.label,
            ...(found.note !== undefined ? { note: found.note } : {}),
            ...(keepQuote ? { quote: found.quote } : {}),
            ...(matchedTool ? { toolId: matchedTool.toolId } : {}),


            ...(found.label === 'violated' && found.cause ? { cause: found.cause } : {}),
            ...(found.label === 'violated' && found.impact ? { impact: found.impact } : {}),

            ...(found.label === 'not_applicable' && found.missing ? { missing: found.missing } : {}),
          };
        }
        return { id: m.id, label: 'injected_without_effect' as TraceLabel, note: 'not labeled by trace model' };
      });


      const citableIds = new Set(labels.filter((l) => l.label === 'operational' || l.label === 'violated').map((l) => l.id));
      const rawSummary = typeof raw.summary === 'string' ? raw.summary.replace(/\s+/g, ' ').trim() : '';
      const decited = rawSummary.replace(/\[(M-\d+)\]/g, (whole, cited: string) =>
        citableIds.has(cited) ? whole : cited,
      );


      const sanitizedSummary = decited.replace(
        /([.!?])((?:\s+(?:\[M-\d+\]|M-\d+))+)\s*$/,
        (_whole, punct: string, tail: string) => {
          const kept = tail.match(/\[M-\d+\]/g) ?? [];
          return kept.length ? `${punct} ${kept.join(' ')}` : punct;
        },
      );
      const summary = sanitizedSummary ? sanitizedSummary.slice(0, 200) : undefined;

      return { labels, ...(summary ? { summary } : {}) };
  }
}
