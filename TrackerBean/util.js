// Run fn over items with at most n running at once. Errors in one item don't stop the rest.
async function pool(items, n, fn) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const item = items[i++];
      try { await fn(item); } catch { /* ignore */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}
module.exports = { pool };
