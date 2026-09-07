import { compactHistoricalManifests, generateManifest } from '../install/src/manifest';
import { getCurrentRepoVersion } from '../install/src/installer';

const repoDir = process.cwd();
const version = getCurrentRepoVersion(repoDir);
const manifest = generateManifest(repoDir, version);

console.log(`Generated manifest for v${version} (${manifest.count} files) -> ${manifest.path}`);

const compact = compactHistoricalManifests(repoDir);
if (compact.archived.length > 0) {
  console.log(`Compacted ${compact.archived.length} manifest(s) below the supported floor -> ${compact.historyPath}`);
}
