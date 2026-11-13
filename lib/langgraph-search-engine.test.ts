import test from 'node:test';
import assert from 'node:assert/strict';
import { LangGraphSearchEngine, SearchEvent, Source } from './langgraph-search-engine';
import type { FirecrawlClient } from './firecrawl';

process.env.OPENAI_API_KEY = 'test-key';

interface CompleteState {
  query?: string;
  finalAnswer?: string;
  sources: Source[];
  processedSources?: Source[];
  followUpQuestions?: string[];
  phase?: string;
}

interface CompleteConfig {
  configurable?: {
    eventCallback?: (event: SearchEvent) => void;
  };
}

interface CompleteNode {
  invoke(state: CompleteState, config?: CompleteConfig): Promise<Partial<CompleteState>>;
}

interface GraphWithNodes {
  nodes: Record<string, CompleteNode>;
}

function getCompleteNode(): CompleteNode {
  const engine = new LangGraphSearchEngine({} as FirecrawlClient);
  const graph = (engine as unknown as { graph: GraphWithNodes }).graph;
  return graph.nodes.complete;
}

async function runComplete(state: CompleteState): Promise<SearchEvent[]> {
  const events: SearchEvent[] = [];
  await getCompleteNode().invoke(state, {
    configurable: {
      eventCallback: (event) => events.push(event)
    }
  });
  return events;
}

function getFinalResult(events: SearchEvent[]): Extract<SearchEvent, { type: 'final-result' }> {
  const event = events.find((candidate) => candidate.type === 'final-result');
  assert.ok(event);
  if (event.type !== 'final-result') {
    throw new Error('final-result event not emitted');
  }
  return event;
}

const alpha: Source = { url: 'https://alpha.test', title: 'Alpha' };
const beta: Source = { url: 'https://beta.test', title: 'Beta' };
const gamma: Source = { url: 'https://gamma.test', title: 'Gamma' };

test('complete emits processed sources in the exact synthesis order', async () => {
  const events = await runComplete({
    query: 'reordered sources',
    finalAnswer: 'answer',
    sources: [alpha, beta, gamma],
    processedSources: [gamma, alpha]
  });

  const finalResult = getFinalResult(events);
  assert.deepEqual(finalResult.sources, [gamma, alpha]);
});

test('complete emits only the processed subset when sources are filtered', async () => {
  const events = await runComplete({
    query: 'filtered sources',
    finalAnswer: 'answer',
    sources: [alpha, beta, gamma],
    processedSources: [beta]
  });

  const finalResult = getFinalResult(events);
  assert.deepEqual(finalResult.sources, [beta]);
});

test('complete emits no sources when processed sources is empty', async () => {
  const events = await runComplete({
    query: 'empty processed sources',
    finalAnswer: 'answer',
    sources: [alpha, beta, gamma],
    processedSources: []
  });

  const finalResult = getFinalResult(events);
  assert.deepEqual(finalResult.sources, []);
});

test('complete falls back to sources when processed sources is undefined', async () => {
  const events = await runComplete({
    query: 'no processed sources',
    finalAnswer: 'answer',
    sources: [alpha, beta, gamma],
    processedSources: undefined
  });

  const finalResult = getFinalResult(events);
  assert.deepEqual(finalResult.sources, [alpha, beta, gamma]);
});
