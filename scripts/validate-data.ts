/**
 * CI gate for the political data files (ADR 0003).
 *
 * A merge request carrying data that breaks §12, §14, §16, §17, §20 or §24
 * fails here, before the data ever reaches a database.
 */
import { loadAllElections } from '../src/data/load';

try {
  const elections = loadAllElections();
  for (const e of elections) {
    const confirmed = e.positions.filter((p) => p.status === 'confirmed').length;
    console.log(
      `${e.election.slug}: ${e.themes.length} themes, ${e.questions.length} questions, ` +
        `${e.candidates.length} candidates, ${confirmed}/${e.positions.length} confirmed positions`,
    );
  }
  console.log('political data OK');
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
