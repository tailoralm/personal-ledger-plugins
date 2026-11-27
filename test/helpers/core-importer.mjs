import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { packagePlugin } from '../../scripts/package-plugin.mjs';

const coreSnapshot = process.env.PERSONAL_LEDGER_CORE_SNAPSHOT;
export const coreImporterTestOptions = {
  skip: coreSnapshot ? false : 'Run npm run provider:test:core for pinned core importer parity',
};

export function importCore(relative) {
  return import(pathToFileURL(path.join(coreSnapshot, 'dist', relative)));
}

// The original parsers were retired from current core in #61.
export function importLegacyOracle(relative) {
  return import(pathToFileURL(path.join(process.env.PERSONAL_LEDGER_ORACLE_SNAPSHOT, 'dist', relative)));
}

export async function configureCoreImporter(repository, root, folder) {
  const [{ PluginManager }, { Ledger }] = await Promise.all([
    importCore('application/plugins/manager.js'),
    importCore('application/ledger/service.js'),
  ]);
  const manager = new PluginManager(path.join(root, 'plugins'), root);
  const pkg = packagePlugin(folder);
  const source = { kind: 'zip', bytes: pkg.bytes, sha256: pkg.sha256 };
  const { digest } = await manager.inspect(source);
  const actor = 'Synthetic parity reviewer';
  await manager.installCandidate(source, digest, actor);
  manager.setEnabled(pkg.id, digest, true, actor);
  const ledger = new Ledger(repository, root, manager);
  ledger.imports.linkImporter(pkg.id);
  return { ledger, importerId: pkg.id, expectedDigest: digest };
}
