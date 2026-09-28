import { createApp, consoleLogger } from './http/app';
import { loadAllElections } from './data/load';

/**
 * Entry point.
 *
 * Political data is loaded from the files at startup (ADR 0003) and held in
 * memory. Nothing writes political data at runtime, so there is no cache to
 * invalidate and no write path to secure.
 */

const port = Number(process.env.PORT ?? 3001);

// A failure here must stop the process rather than serve an election with
// missing or unsourced positions (§16, §42).
const elections = loadAllElections();

createApp(elections, consoleLogger).listen(port, () => {
  console.log(
    JSON.stringify({
      at: 'startup',
      port,
      elections: elections.map((e) => e.election.slug),
    }),
  );
});
