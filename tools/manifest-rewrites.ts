// tools/manifest-rewrites.ts — in-place rewrites of committed
// apps/<app>/pocket.app.json files for the length of one build
// (tools/psp-svelte.ts, tools/3ds-svelte.ts, tests/e2e/azahar.ts).
//
// tools/build.ts checks a plan against the manifest beside its entry, so a
// build for another framework or viewport rewrites that file and writes the
// original bytes back afterwards. Three mechanisms keep the committed bytes:
//
//   - One lock, .pocket-build/locks/app-manifests.lock, serializes every
//     rewriting build in a checkout, so no build reads another build's
//     rewrite as its original. A lock whose process died is recovered
//     (tools/targets/lock.ts).
//   - A journal entry under .pocket-build/manifest-rewrites/ holds each
//     file's original and rewritten text from before the write until the
//     restore. The next rewriting build restores a file that an interrupted
//     build (SIGKILL, a crash) left rewritten, and leaves alone a file that
//     changed after the rewrite.
//   - SIGINT, SIGTERM and SIGHUP restore every open rewrite and exit 1.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withArtifactLock } from "./targets/lock.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export interface ManifestRewrites {
  /** Journals `path`'s current text, then writes `text` to it. A second
   *  rewrite of the same file keeps the first original. */
  rewrite(path: string, text: string): void;
  /** Writes the original back to `path` (to every rewritten file when
   *  omitted) and drops its journal entry. */
  restore(path?: string): void;
}

export interface ManifestRewriteOptions {
  /** The checkout whose .pocket-build/ holds the lock and the journal. */
  readonly root?: string;
  /** Runs on SIGINT, SIGTERM or SIGHUP after the restore, before the exit. */
  readonly onInterrupt?: () => void;
  /** How long to wait for another rewriting build (default one hour). */
  readonly timeoutMs?: number;
}

interface JournalEntry {
  readonly path: string;
  readonly original: string;
  readonly rewritten: string;
}

function journalDirectory(root: string): string {
  return join(root, ".pocket-build", "manifest-rewrites");
}

function journalFile(root: string, file: string): string {
  return join(journalDirectory(root), `${relative(root, file).replaceAll("\\", "/").replaceAll("/", "__")}.json`);
}

function writeJournal(root: string, file: string, entry: JournalEntry): void {
  mkdirSync(journalDirectory(root), { recursive: true });
  const target = journalFile(root, file);
  writeFileSync(`${target}.tmp`, JSON.stringify(entry));
  renameSync(`${target}.tmp`, target);
}

/** Restores the files an interrupted rewriting build left behind. The caller
 *  holds the lock, so no live build owns an entry it finds. */
function recover(root: string, label: string): void {
  const directory = journalDirectory(root);
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory).sort()) {
    const entryFile = join(directory, name);
    if (!name.endsWith(".json")) {
      rmSync(entryFile, { force: true });
      continue;
    }
    let entry: JournalEntry;
    try {
      entry = JSON.parse(readFileSync(entryFile, "utf8")) as JournalEntry;
    } catch {
      rmSync(entryFile, { force: true });
      continue;
    }
    const file = resolve(root, entry.path);
    const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    if (current === entry.rewritten) {
      writeFileSync(file, entry.original);
      console.log(`${label}: restored ${entry.path}, left rewritten by an interrupted build`);
    } else if (current !== entry.original) {
      console.warn(`${label}: ${entry.path} changed after an interrupted build rewrote it; left as it is`);
    }
    rmSync(entryFile, { force: true });
  }
}

/** Runs `operation` holding the manifest lock, with journaled rewrites that
 *  are restored when it returns, throws or is interrupted. */
export async function withManifestRewrites<T>(
  label: string,
  operation: (rewrites: ManifestRewrites) => Promise<T>,
  options: ManifestRewriteOptions = {},
): Promise<T> {
  const root = resolve(options.root ?? ROOT);
  return await withArtifactLock(
    join(root, ".pocket-build", "locks", "app-manifests.lock"),
    async () => {
      recover(root, label);
      const open = new Map<string, string>();
      const restore = (path?: string): void => {
        const files = path === undefined ? [...open.keys()] : [resolve(path)];
        for (const file of files) {
          const original = open.get(file);
          if (original === undefined) continue;
          writeFileSync(file, original);
          rmSync(journalFile(root, file), { force: true });
          open.delete(file);
        }
        if (path === undefined && files.length > 0) {
          console.log(`${label}: restored ${files.length} manifest(s)`);
        }
      };
      const rewrite = (path: string, text: string): void => {
        const file = resolve(path);
        const original = open.get(file) ?? readFileSync(file, "utf8");
        writeJournal(root, file, { path: relative(root, file), original, rewritten: text });
        open.set(file, original);
        writeFileSync(file, text);
      };
      const interrupted = (): void => {
        restore();
        options.onInterrupt?.();
        process.exit(1);
      };
      for (const signal of SIGNALS) process.on(signal, interrupted);
      try {
        return await operation({ rewrite, restore });
      } finally {
        restore();
        for (const signal of SIGNALS) process.off(signal, interrupted);
      }
    },
    { timeoutMs: options.timeoutMs ?? 60 * 60_000, staleMs: 2 * 60 * 60_000 },
  );
}
