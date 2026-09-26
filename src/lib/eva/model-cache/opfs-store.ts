import { ModelIntegrityError, verifyBlobIntegrity } from './integrity';
import {
  isMissingOpfsEntry, opfsDirectory, opfsOpaqueName, opfsPackagePath,
  promoteOpfsFile, removeOpfsFile, writeOpfsStream, type OpfsDirectory,
} from './opfs-files';
import type {
  ModelCacheBlobBackend, ModelCacheBodySource, ModelCacheFileRecord,
  ModelCacheMetadataRepository, ModelCacheTemporaryRecord, ModelCacheWriteOptions,
} from './store';

function splitLocator(locator: string): [string, string] | null {
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,199}\/[a-f0-9]{64})\/([a-f0-9]{64}\.blob|\.tmp-[A-Za-z0-9-]+)$/.exec(locator);
  return match ? [match[1], match[2]] : null;
}

export class OpfsModelCacheBackend implements ModelCacheBlobBackend {
  readonly kind = 'opfs' as const;

  constructor(
    readonly root: OpfsDirectory,
    readonly repository: ModelCacheMetadataRepository,
    readonly now: () => number = Date.now,
  ) {}

  async writeVerifiedFile(
    record: Omit<ModelCacheFileRecord, 'backend' | 'locator' | 'state'>,
    source: ModelCacheBodySource,
    options: ModelCacheWriteOptions = {},
  ): Promise<ModelCacheFileRecord> {
    const path = await opfsPackagePath(record.packageKey);
    const finalName = `${await opfsOpaqueName(record.key)}.blob`;
    const resumableId = await opfsOpaqueName(record.key);
    const temporaryName = options.acquire ? `.tmp-resume-${resumableId}` : `.tmp-${crypto.randomUUID()}`;
    const temporaryId = options.acquire ? `resume-${resumableId}` : `opfs-${crypto.randomUUID()}`;
    const directory = await opfsDirectory(this.root, path, true);
    const temporaryHandle = await directory.getFileHandle(temporaryName, { create: true });
    const temporary: ModelCacheTemporaryRecord = {
      id: temporaryId, packageKey: record.packageKey, fileKey: record.key,
      backend: this.kind, locator: `${path}/${temporaryName}`, createdAt: this.now(),
    };
    let offset = 0;
    if (options.acquire) {
      const previous = (await this.repository.listTemporary()).find((item) => item.id === temporaryId);
      if (previous?.locator === temporary.locator && previous.packageKey === record.packageKey && previous.fileKey === record.key
        && previous.resume?.bytes === record.bytes && previous.resume.sha256 === record.sha256
        && Number.isSafeInteger(previous.resume.offset) && previous.resume.offset >= 0 && previous.resume.offset <= record.bytes
        && (await temporaryHandle.getFile()).size >= previous.resume.offset) offset = previous.resume.offset;
      if (previous?.resume && previous.resume.offset > 0 && offset === 0) await options.onPartialEvicted?.();
      // Resume identity comes from the manifest SHA-256, never per-file host ETags.
      // Reserved marker: even a closed prefix cannot be served before whole-file SHA.
      temporary.resume = { bytes: record.bytes, sha256: record.sha256, offset, verifiedPrefix: false };
    }
    let promoted = false;
    try {
      await this.repository.putTemporary(temporary);
      if (options.acquire) {
        if (offset > 0) {
          await options.onResumeProgress?.(0, offset);
        }
        await options.acquire(temporaryHandle, offset, async (completed) => {
          if (!Number.isSafeInteger(completed) || completed < offset || completed > record.bytes) throw new Error('Invalid OPFS download checkpoint.');
          options.assertCanCommit?.();
          temporary.resume!.offset = completed;
          temporary.createdAt = this.now();
          await this.repository.putTemporary(temporary);
          offset = completed;
        });
      } else await writeOpfsStream(temporaryHandle, source);
      // Hash the on-disk temp file once before atomic promotion.
      await verifyBlobIntegrity(await temporaryHandle.getFile(), { bytes: record.bytes, sha256: record.sha256 },
        { onProgress: options.onVerifyProgress });
      options.assertCanCommit?.();
      await promoteOpfsFile(temporaryHandle, finalName);
      promoted = true;
      await options.onCommitProgress?.(record.bytes, record.bytes);
      options.assertCanCommit?.();
      const complete: ModelCacheFileRecord = {
        ...record, backend: this.kind, locator: `${path}/${finalName}`, state: 'complete',
      };
      await this.repository.putFile(complete);
      await this.repository.deleteTemporary(temporaryId);
      return complete;
    } catch (error) {
      const quota = error instanceof DOMException && error.name === 'QuotaExceededError';
      const needed = Math.max(1, record.bytes - offset);
      const freed = quota && !promoted ? await options.onQuotaFailure?.(needed).catch(() => 0) ?? 0 : 0;
      // Quota prefixes survive ONLY if cache-owned eviction actually freed enough.
      // Corrupt bytes and any promoted-but-uncommitted artifact are discarded.
      const keepPrefix = options.acquire && !promoted && !(error instanceof ModelIntegrityError)
        && (!quota || freed >= needed) && offset > 0;
      if (!keepPrefix) await removeOpfsFile(directory, temporaryName).catch(() => undefined);
      if (promoted) await removeOpfsFile(directory, finalName).catch(() => undefined);
      if (!keepPrefix) await this.repository.deleteTemporary(temporaryId).catch(() => undefined);
      throw error;
    }
  }

  async readFile(record: ModelCacheFileRecord): Promise<Blob | null> {
    const parts = splitLocator(record.locator);
    if (record.backend !== this.kind || record.state !== 'complete' || !parts
      || parts[0] !== await opfsPackagePath(record.packageKey)) return null;
    try {
      const directory = await opfsDirectory(this.root, parts[0]);
      return await (await directory.getFileHandle(parts[1])).getFile();
    } catch (error) {
      if (isMissingOpfsEntry(error)) return null;
      throw error;
    }
  }

  async #remove(record: ModelCacheFileRecord | ModelCacheTemporaryRecord): Promise<void> {
    const parts = splitLocator(record.locator);
    if (record.backend !== this.kind || !parts || parts[0] !== await opfsPackagePath(record.packageKey)) return;
    try {
      await removeOpfsFile(await opfsDirectory(this.root, parts[0]), parts[1]);
    } catch (error) {
      if (!isMissingOpfsEntry(error)) throw error;
    }
  }

  deleteFile(record: ModelCacheFileRecord): Promise<void> { return this.#remove(record); }
  deleteTemporary(record: ModelCacheTemporaryRecord): Promise<void> { return this.#remove(record); }

  async corruptFileForDevelopment(record: ModelCacheFileRecord): Promise<void> {
    const parts = splitLocator(record.locator);
    if (!parts || record.bytes > 8 * 1024 * 1024) throw new Error('Only small OPFS fixtures may be corrupted.');
    const directory = await opfsDirectory(this.root, parts[0]);
    await writeOpfsStream(await directory.getFileHandle(parts[1]), new Blob([new ArrayBuffer(record.bytes)]));
  }

  async reconcile(validFiles: ModelCacheFileRecord[], _now: number): Promise<{ missing: Set<string>; bytesReclaimed: number }> {
    let bytesReclaimed = 0;
    const missing = new Set<string>();
    const validByLocator = new Map(validFiles.map((file) => [file.locator, file]));
    for (const file of validFiles) {
      const blob = await this.readFile(file);
      if (!blob || blob.size !== file.bytes) {
        missing.add(file.key);
        await this.deleteFile(file);
      }
    }
    for await (const [modelId, modelHandle] of this.root.entries()) {
      if (modelHandle.kind === 'file') {
        if (modelId.startsWith('.tmp-') || modelId.endsWith('.crswap')) {
          try {
            const file = await (modelHandle as FileSystemFileHandle).getFile();
            bytesReclaimed += file.size;
          } catch { /* ignore */ }
          await removeOpfsFile(this.root, modelId);
        }
        continue;
      }
      // Old flat OPFS packages remain untouched and are never served.
      if (/^[a-f0-9]{64}$/.test(modelId)) continue;
      for await (const [version, versionHandle] of (modelHandle as OpfsDirectory).entries()) {
        if (versionHandle.kind === 'file') {
          if (version.startsWith('.tmp-') || version.endsWith('.crswap')) {
            try {
              const file = await (versionHandle as FileSystemFileHandle).getFile();
              bytesReclaimed += file.size;
            } catch { /* ignore */ }
            await removeOpfsFile(modelHandle as OpfsDirectory, version);
          }
          continue;
        }
        if (!/^[a-f0-9]{64}$/.test(version)) continue;
        const directory = versionHandle as OpfsDirectory;
        for await (const [name, handle] of directory.entries()) {
          if (handle.kind === 'directory' && name === '_metadata') {
            const metadata = handle as OpfsDirectory;
            for await (const [temporaryName, temporary] of metadata.entries()) {
              if (temporary.kind === 'file' && (temporaryName.startsWith('.tmp-') || temporaryName.endsWith('.crswap'))) {
                try {
                  const file = await (temporary as FileSystemFileHandle).getFile();
                  bytesReclaimed += file.size;
                } catch { /* ignore */ }
                await removeOpfsFile(metadata, temporaryName);
              }
            }
            continue;
          }
          if (handle.kind !== 'file') continue;
          if (name.startsWith('.tmp-') || name.endsWith('.crswap')) {
            try {
              const file = await (handle as FileSystemFileHandle).getFile();
              bytesReclaimed += file.size;
            } catch { /* ignore */ }
            await removeOpfsFile(directory, name);
          } else if (/^[a-f0-9]{64}\.blob$/.test(name) && !validByLocator.has(`${modelId}/${version}/${name}`)) {
            try {
              const file = await (handle as FileSystemFileHandle).getFile();
              bytesReclaimed += file.size;
            } catch { /* ignore */ }
            await removeOpfsFile(directory, name);
          }
        }
      }
    }
    return { missing, bytesReclaimed };
  }
}
