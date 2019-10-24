import * as fs from 'fs-extra';
import * as unzipper from 'unzipper';
import * as vscode from 'vscode';
import { logger } from './logging';

export class File implements vscode.FileStat {
  type: vscode.FileType;
  ctime: number;
  mtime: number;
  size: number;

  constructor(public name: string, public data: Uint8Array) {
    this.type = vscode.FileType.File;
    this.ctime = Date.now();
    this.mtime = Date.now();
    this.size = data.length;
    this.name = name;
  }
}

export class Directory implements vscode.FileStat {
  type: vscode.FileType;
  ctime: number;
  mtime: number;
  size: number;
  entries: Map<string, Entry> = new Map();

  constructor(public name: string) {
    this.type = vscode.FileType.Directory;
    this.ctime = Date.now();
    this.mtime = Date.now();
    this.size = 0;
  }
}

export type Entry = File | Directory;

import * as path from 'path';

export class ArchiveFileSystemProvider implements vscode.FileSystemProvider {
  private readOnlyError = vscode.FileSystemError.NoPermissions('write operation attempted, but source archive filesystem is readonly');

  root = new Directory('');

  // metadata

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return await this._lookup(uri, false);
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    logger.log(`readdir ${uri}`);
    const entry = this._lookupAsDirectory(uri, false);
    let result: [string, vscode.FileType][] = [];
    for (const [name, child] of entry.entries) {
      result.push([name, child.type]);
    }
    return result;
  }

  // file contents

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const data = (await this._lookupAsFile(uri, false)).data;
    if (data) {
      return data;
    }
    throw vscode.FileSystemError.FileNotFound();
  }

  // write operations, all disabled

  writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }): void {
    throw this.readOnlyError;
  }

  rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): void {
    throw this.readOnlyError;
  }

  delete(uri: vscode.Uri): void {
    throw this.readOnlyError;
  }

  createDirectory(uri: vscode.Uri): void {
    throw this.readOnlyError;
  }

  // content lookup

  private async _lookup(uri: vscode.Uri, silent: boolean): Promise<Entry> {
    if (!fs.existsSync(uri.path))
      throw vscode.FileSystemError.FileNotFound(uri);
    const archive = await unzipper.Open.file(uri.path);
    logger.log(`${JSON.stringify(uri)} ${uri.fragment}`);
    // Depending on the zip there could be a src_archive section to the path or not.
    const file = archive.files.find(f => f.path === uri.fragment || f.path === 'src_archive/' + uri.fragment);
    if (file === undefined)
      throw vscode.FileSystemError.FileNotFound(uri);
    return new File(uri.fragment, await file.buffer());
  }

  private _lookupAsDirectory(uri: vscode.Uri, silent: boolean): Directory {
    let entry = this._lookup(uri, silent);
    if (entry instanceof Directory) {
      return entry;
    }
    throw vscode.FileSystemError.FileNotADirectory(uri);
  }

  private async _lookupAsFile(uri: vscode.Uri, silent: boolean): Promise<File> {
    let entry = await this._lookup(uri, silent);
    if (entry instanceof File) {
      return entry;
    }
    throw vscode.FileSystemError.FileIsADirectory(uri);
  }

  private _lookupParentDirectory(uri: vscode.Uri): Directory {
    const dirname = uri.with({ path: path.posix.dirname(uri.path) });
    return this._lookupAsDirectory(dirname, false);
  }

  // file events

  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private _bufferedEvents: vscode.FileChangeEvent[] = [];
  private _fireSoonHandle?: NodeJS.Timer;

  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

  watch(_resource: vscode.Uri): vscode.Disposable {
    // ignore, fires for all changes...
    return new vscode.Disposable(() => { });
  }

  private _fireSoon(...events: vscode.FileChangeEvent[]): void {
    this._bufferedEvents.push(...events);

    if (this._fireSoonHandle) {
      clearTimeout(this._fireSoonHandle);
    }

    this._fireSoonHandle = setTimeout(() => {
      this._emitter.fire(this._bufferedEvents);
      this._bufferedEvents.length = 0;
    }, 5);
  }
}

/**
 * Custom uri scheme for referring to files inside zip archives stored
 * in the filesystem.
 * For example:
 * `ql-zip-archive:///home/alice/semmle/home/projects/turboencabulator/revision-2019-August-02--08-50-01/output/src_archive.zip#/home/alice/foobar/foobar.c`
 * refers to file `/home/alice/foobar/foobar.c` inside `src_archive.zip`.
 *
 * (cf. https://www.ietf.org/rfc/rfc2396.txt (Appendix A, page 26) for
 * the fact that hyphens are allowed in uri schemes)
 */
export const zipArchiveScheme = 'codeql-zip-archive';

export function activate(ctx: vscode.ExtensionContext) {
  const schemeRootUri = vscode.Uri.parse(zipArchiveScheme + ':/');
  ctx.subscriptions.push(vscode.workspace.registerFileSystemProvider(
    zipArchiveScheme,
    new ArchiveFileSystemProvider(),
    {
      isCaseSensitive: true,
      isReadonly: true,
    }
  ));
}
