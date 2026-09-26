/**
 * ddlforge - Zero-dependency Declarative Config Loader
 *
 * Discovers and parses `.ddlforgerc.json` or `.ddlforge.json` in the project root.
 * Schema:
 *   {
 *     "targetVersion": "16",
 *     "rules": {
 *       "lock-access-exclusive": "error",
 *       "non-concurrent-index": "error",
 *       "unvalidated-foreign-key": "error"
 *     },
 *     "ignore": ["db/migrate/legacy/**"]
 *   }
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DdlforgeConfig {
  targetVersion?: string | number;
  rules?: Record<string, string | boolean>;
  ignore?: string[];
}

export interface LoadedConfig {
  config: DdlforgeConfig | null;
  configPath: string | null;
}

export const CONFIG_FILENAMES = ['.ddlforgerc.json', '.ddlforge.json'];

/**
 * Discovers the configuration file in the specified directory root.
 * Prioritizes `.ddlforgerc.json`, falling back to `.ddlforge.json`.
 */
export function findConfigFile(dir: string = process.cwd()): string | null {
  for (const filename of CONFIG_FILENAMES) {
    const candidate = path.resolve(dir, filename);
    if (fs.existsSync(candidate)) {
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) {
          return candidate;
        }
      } catch {
        // Ignore filesystem check errors
      }
    }
  }
  return null;
}

/**
 * Loads and parses `.ddlforgerc.json` or `.ddlforge.json`.
 * If a custom path is provided, it attempts to load that specific file.
 */
export function loadConfig(
  dir: string = process.cwd(),
  customPath?: string
): LoadedConfig {
  const resolvedPath = customPath
    ? (path.isAbsolute(customPath) ? customPath : path.resolve(dir, customPath))
    : findConfigFile(dir);

  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    return { config: null, configPath: null };
  }

  try {
    const rawContent = fs.readFileSync(resolvedPath, 'utf-8');
    const parsed = JSON.parse(rawContent) as DdlforgeConfig;
    return { config: parsed, configPath: resolvedPath };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse config file at "${resolvedPath}": ${msg}`);
  }
}

/**
 * Zero-dependency glob matcher supporting:
 * - `**` for recursive directories
 * - `*` for single path segments
 * - `?` for single characters
 * - Exact path prefix / suffix matches
 */
export function matchesIgnorePattern(
  filePath: string,
  pattern: string,
  rootDir: string = process.cwd()
): boolean {
  // Normalize Windows separators to standard forward slashes
  const normFile = filePath.replace(/\\/g, '/');
  const normRoot = rootDir.replace(/\\/g, '/').replace(/\/+$/, '');

  // Calculate relative path from root directory
  let relPath = normFile;
  if (normFile.startsWith(normRoot + '/')) {
    relPath = normFile.slice(normRoot.length + 1);
  }
  relPath = relPath.replace(/^\.\//, '');

  let cleanPattern = pattern.replace(/\\/g, '/').replace(/^\.\//, '');

  // Convert pattern to regex
  const escaped = cleanPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '___GLOBSTAR___')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/___GLOBSTAR___/g, '.*');

  const regex = new RegExp(`^${escaped}$`);
  if (regex.test(relPath) || regex.test(normFile)) {
    return true;
  }

  // Segment / prefix matching for patterns without leading slash
  if (!cleanPattern.startsWith('/') && !cleanPattern.startsWith('./')) {
    const prefixRegex = new RegExp(`(^|/)${escaped}$`);
    if (prefixRegex.test(relPath) || prefixRegex.test(normFile)) {
      return true;
    }
  }

  return false;
}

/**
 * Filters an array of file paths against an array of ignore patterns.
 */
export function filterIgnoredFiles(
  files: string[],
  ignorePatterns: string[],
  rootDir: string = process.cwd()
): string[] {
  if (!ignorePatterns || ignorePatterns.length === 0) {
    return files;
  }

  return files.filter(
    (file) => !ignorePatterns.some((pattern) => matchesIgnorePattern(file, pattern, rootDir))
  );
}
