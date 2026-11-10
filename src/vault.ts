import { readPrivateJson, writePrivateFile } from './files.js';
import { withLock } from './lock.js';
import type { AppPaths } from './paths.js';

export type VaultKind = 'keyring' | 'file';

export interface Vault {
  readonly kind: VaultKind | 'memory';
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const KEYRING_SERVICE = 'twake-ai';

export class MemoryVault implements Vault {
  readonly kind = 'memory' as const;
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

/** Fallback when the OS has no usable keychain (Linux server without a session bus…): one 0600 JSON file. */
export class FileVault implements Vault {
  readonly kind = 'file' as const;

  constructor(private readonly paths: AppPaths) {}

  async get(key: string): Promise<string | undefined> {
    return (await this.read())[key];
  }

  async set(key: string, value: string): Promise<void> {
    await this.update((values) => {
      values[key] = value;
    });
  }

  async delete(key: string): Promise<void> {
    await this.update((values) => {
      delete values[key];
    });
  }

  private async read(): Promise<Record<string, string>> {
    return ((await readPrivateJson(this.paths.vaultFile)) ?? {}) as Record<string, string>;
  }

  private async update(change: (values: Record<string, string>) => void): Promise<void> {
    await withLock(this.paths.locksDir, 'vault-file', async () => {
      const values = await this.read();
      change(values);
      await writePrivateFile(this.paths.vaultFile, `${JSON.stringify(values, null, 2)}\n`);
    });
  }
}

export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

export type KeyringEntryFactory = (service: string, account: string) => KeyringEntry;

/** macOS Keychain, Windows Credential Manager, Secret Service on Linux. */
export class KeyringVault implements Vault {
  readonly kind = 'keyring' as const;

  constructor(private readonly entry: KeyringEntryFactory) {}

  async get(key: string): Promise<string | undefined> {
    return this.entry(KEYRING_SERVICE, key).getPassword() ?? undefined;
  }

  async set(key: string, value: string): Promise<void> {
    this.entry(KEYRING_SERVICE, key).setPassword(value);
  }

  async delete(key: string): Promise<void> {
    try {
      this.entry(KEYRING_SERVICE, key).deletePassword();
    } catch {
      // nothing stored under this key: already deleted
    }
  }
}

async function loadKeyring(): Promise<KeyringEntryFactory> {
  const { Entry } = await import('@napi-rs/keyring');
  return (service, account) => new Entry(service, account);
}

/** Picks the vault once, at login: the OS keychain when it works, else the 0600 file. TWAKE_AI_VAULT=file forces the file. */
export async function chooseVault(
  paths: AppPaths,
  env: NodeJS.ProcessEnv = process.env,
  load: () => Promise<KeyringEntryFactory> = loadKeyring,
): Promise<Vault> {
  if (env.TWAKE_AI_VAULT === 'file') return new FileVault(paths);
  try {
    const vault = new KeyringVault(await load());
    await vault.set('probe', 'ok');
    const works = (await vault.get('probe')) === 'ok';
    await vault.delete('probe');
    if (works) return vault;
  } catch {
    // no usable keychain here: fall back to the file
  }
  return new FileVault(paths);
}

/** Opens the vault recorded in the configuration, without probing (the token command runs often). */
export async function openVault(kind: VaultKind, paths: AppPaths, load: () => Promise<KeyringEntryFactory> = loadKeyring): Promise<Vault> {
  return kind === 'keyring' ? new KeyringVault(await load()) : new FileVault(paths);
}
