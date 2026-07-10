import { refreshTestCtr, refreshAllRunningTests } from '../services/reach-refresh';
(async () => {
  const arg = process.argv[2];
  if (arg && arg !== 'all') { console.log(JSON.stringify(await refreshTestCtr(parseInt(arg)), null, 2)); }
  else { for (const r of await refreshAllRunningTests()) console.log(JSON.stringify(r)); }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
