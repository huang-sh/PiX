import { readFileSync } from 'node:fs';

// The visible snapshot contains the selected branch's entries only. Read each
// run's own journal, excluding copied ancestors from its execution evidence.
export function graphToolEvidence(snapshot) {
  const entries = [], seen = new Set();
  for (const run of snapshot.graph.runs) {
    const path = run.runtime?.sessionFile;
    if (!path) continue;
    for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
      const entry = JSON.parse(line);
      if (!entry.id || seen.has(entry.id)) continue;
      seen.add(entry.id);
      entries.push({ ...entry, branchId: run.branchId });
    }
  }
  const calls = entries.flatMap(entry => entry.message?.role === 'assistant' && Array.isArray(entry.message.content)
    ? entry.message.content.filter(part => part.type === 'toolCall').map(part => ({
      branchId: entry.branchId, entryId: entry.id, id: part.id, name: part.name, arguments: part.arguments,
    })) : []);
  return { entries, calls };
}
