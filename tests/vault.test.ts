import { stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { chooseVault, FileVault, KeyringVault, openVault, type KeyringEntry, type KeyringEntryFactory } from '../src/vault.js';
import { tempPaths } from './helpers/tmp.js';

function fakeKeyring(): { factory: KeyringEntryFactory; store: Map<string, string> } {
  const store = new Map<string, string>();
  const factory: KeyringEntryFactory = (service, account): KeyringEntry => {
    const key = `${service}/${account}`;
    return {
      getPassword: () => store.get(key) ?? null,
      setPassword: (password) => {
        store.set(key, password);
      },
      deletePassword: () => store.delete(key),
    };
  };
  return { factory, store };
}

describe('FileVault', () => {
  it('stores, reads and deletes secrets in a 0600 file', async () => {
    const { paths } = await tempPaths();
    const vault = new FileVault(paths);
    expect(await vault.get('oidc.refresh_token')).toBeUndefined();
    await vault.set('oidc.refresh_token', 'r1');
    await vault.set('other', 'x');
    expect(await vault.get('oidc.refresh_token')).toBe('r1');
    await vault.delete('oidc.refresh_token');
    expect(await vault.get('oidc.refresh_token')).toBeUndefined();
    expect(await vault.get('other')).toBe('x');
    if (process.platform !== 'win32') expect((await stat(paths.vaultFile)).mode & 0o777).toBe(0o600);
  });

  it('keeps every key when two writes race', async () => {
    const { paths } = await tempPaths();
    const vault = new FileVault(paths);
    await Promise.all(['a', 'b', 'c', 'd'].map((key) => vault.set(key, key)));
    expect(await Promise.all(['a', 'b', 'c', 'd'].map((key) => vault.get(key)))).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('KeyringVault', () => {
  it('stores secrets under the twake-ai service', async () => {
    const { factory, store } = fakeKeyring();
    const vault = new KeyringVault(factory);
    await vault.set('oidc.refresh_token', 'r1');
    expect(store.get('twake-ai/oidc.refresh_token')).toBe('r1');
    expect(await vault.get('oidc.refresh_token')).toBe('r1');
    await vault.delete('oidc.refresh_token');
    await vault.delete('oidc.refresh_token');
    expect(await vault.get('oidc.refresh_token')).toBeUndefined();
  });
});

describe('chooseVault', () => {
  it('uses the keyring when it works, and removes its probe', async () => {
    const { paths } = await tempPaths();
    const { factory, store } = fakeKeyring();
    const vault = await chooseVault(paths, {}, async () => factory);
    expect(vault.kind).toBe('keyring');
    expect(store.size).toBe(0);
  });

  it('falls back to the file when the keyring cannot load (no session bus, unsupported OS)', async () => {
    const { paths } = await tempPaths();
    const vault = await chooseVault(paths, {}, async () => {
      throw new Error('Platform secure storage failure');
    });
    expect(vault.kind).toBe('file');
  });

  it('falls back to the file when the keyring does not keep what it is given', async () => {
    const { paths } = await tempPaths();
    const forgetful: KeyringEntryFactory = () => ({ getPassword: () => null, setPassword: () => undefined, deletePassword: () => false });
    expect((await chooseVault(paths, {}, async () => forgetful)).kind).toBe('file');
  });

  it('obeys TWAKE_AI_VAULT=file', async () => {
    const { paths } = await tempPaths();
    const { factory } = fakeKeyring();
    expect((await chooseVault(paths, { TWAKE_AI_VAULT: 'file' }, async () => factory)).kind).toBe('file');
  });
});

describe('openVault', () => {
  it('opens the kind recorded in the configuration', async () => {
    const { paths } = await tempPaths();
    const { factory } = fakeKeyring();
    expect((await openVault('file', paths)).kind).toBe('file');
    expect((await openVault('keyring', paths, async () => factory)).kind).toBe('keyring');
  });
});
