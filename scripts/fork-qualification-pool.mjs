/** Run every qualification task, preserve failures, and never cancel peers. */
export async function runQualificationTasks(tasks, execute, concurrency = 2) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new Error('Qualification concurrency must be 1 or 2');
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const index = next++, task = tasks[index], started = Date.now();
      try { await execute(task, index); results[index] = { index, ok: true, durationMs: Date.now() - started }; }
      catch (error) { results[index] = { index, ok: false, durationMs: Date.now() - started, error }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}
