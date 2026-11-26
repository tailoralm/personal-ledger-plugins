import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FALLBACK_TSC_PATH = '/media/second/workspace/projects/statement-processor/node_modules/typescript/lib/typescript.js';

function toImportTarget(specifierOrPath) {
  if (/^(?:file:|https?:|data:|node:)/.test(specifierOrPath)) {
    return specifierOrPath;
  }
  if (path.isAbsolute(specifierOrPath) || specifierOrPath.startsWith('.')) {
    return pathToFileURL(path.resolve(specifierOrPath)).href;
  }
  return specifierOrPath;
}

export async function loadTypeScript() {
  const override = process.env.PERSONAL_LEDGER_TSC_PATH;
  let mod;
  if (override) {
    mod = await import(toImportTarget(override));
  } else {
    try {
      mod = await import('typescript');
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' && !/Cannot find package 'typescript'/.test(String(error?.message))) {
        throw error;
      }
      mod = await import(pathToFileURL(FALLBACK_TSC_PATH).href);
    }
  }
  return mod.default ?? mod;
}

function formatDiagnostics(ts, diagnostics) {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => process.cwd(),
    getCanonicalFileName: fileName => fileName,
    getNewLine: () => '\n',
  });
}

function compileProject(templateDir, ts) {
  const resolvedDir = path.resolve(templateDir);
  const tsconfigPath = path.join(resolvedDir, 'tsconfig.json');
  const configFile = ts.readConfigFile(tsconfigPath, file => fs.readFileSync(file, 'utf8'));
  if (configFile.error) {
    throw new Error(formatDiagnostics(ts, [configFile.error]));
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    resolvedDir,
    undefined,
    tsconfigPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(formatDiagnostics(ts, parsed.errors));
  }

  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });

  const preEmitDiagnostics = ts.getPreEmitDiagnostics(program);
  if (preEmitDiagnostics.length > 0) {
    throw new Error(formatDiagnostics(ts, preEmitDiagnostics));
  }

  const emitted = [];
  const emitResult = program.emit(undefined, (fileName, text) => {
    const outPath = fileName.endsWith('.js')
      ? `${fileName.slice(0, -3)}.mjs`
      : fileName.endsWith('.js.map')
        ? `${fileName.slice(0, -7)}.mjs.map`
        : fileName;
    emitted.push({
      outPath,
      relPath: path.relative(resolvedDir, outPath).split(path.sep).join('/'),
      text,
    });
  });

  if (emitResult.diagnostics.length > 0) {
    throw new Error(formatDiagnostics(ts, emitResult.diagnostics));
  }
  if (emitResult.emitSkipped) {
    throw new Error(`TypeScript emit skipped for "${templateDir}".`);
  }

  return emitted;
}

export async function compileTemplateProjectInMemory(templateDir, ts) {
  const resolvedTs = ts ?? await loadTypeScript();
  return compileProject(templateDir, resolvedTs);
}

export async function buildTemplateProject(templateDir, ts) {
  const resolvedTs = ts ?? await loadTypeScript();
  const emitted = compileProject(templateDir, resolvedTs);
  const writtenFiles = [];
  for (const file of emitted) {
    fs.mkdirSync(path.dirname(file.outPath), { recursive: true });
    fs.writeFileSync(file.outPath, file.text, 'utf8');
    writtenFiles.push(file.outPath);
  }
  return writtenFiles;
}

export async function buildTemplates(rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')) {
  const ts = await loadTypeScript();
  const templatesDir = path.join(rootDir, 'templates');
  if (!fs.existsSync(templatesDir)) {
    return [];
  }

  const built = [];
  const entries = fs.readdirSync(templatesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const templateDir = path.join(templatesDir, entry.name);
    if (!fs.existsSync(path.join(templateDir, 'tsconfig.json'))) {
      continue;
    }
    const files = await buildTemplateProject(templateDir, ts);
    built.push(...files);
  }
  return built;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const built = await buildTemplates();
  for (const file of built) {
    console.log(`Built ${path.relative(process.cwd(), file)}`);
  }
}
