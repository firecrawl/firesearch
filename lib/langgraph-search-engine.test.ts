import test from 'node:test';
import assert from 'node:assert/strict';
import { LangGraphSearchEngine, SearchEvent, Source } from './langgraph-search-engine';
import type { FirecrawlClient } from './firecrawl';

process.env.OPENAI_API_KEY = 'test-key';

interface TestState {
  finalAnswer?: string;
  sources: Source[];
  processedSources?: Source[];
}

interface TestNode {
  invoke(state: TestState, config?: { configurable?: { eventCallback?: (event: SearchEvent) => void } }): Promise<Partial<TestState>>;
}

test('complete emits processed sources in order', async () => {
  const a: Source = { url: 'https://a.test', title: 'A' };
  const b: Source = { url: 'https://b.test', title: 'B' };
  const engine = new LangGraphSearchEngine({} as FirecrawlClient);
  const complete = (engine as unknown as { graph: { nodes: Record<string, TestNode> } }).graph.nodes.complete;
  const events: SearchEvent[] = [];

  await complete.invoke(
    { finalAnswer: 'answer', sources: [a, b], processedSources: [b, a] },
    { configurable: { eventCallback: (event) => events.push(event) } }
  );

  const finalResult = events.find((event) => event.type === 'final-result');
  assert.ok(finalResult);
  if (finalResult.type !== 'final-result') throw new Error('final-result event not emitted');
  assert.deepEqual(finalResult.sources, [b, a]);
});
