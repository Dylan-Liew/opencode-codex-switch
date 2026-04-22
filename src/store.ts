import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";
import type { AccountStore, OAuthRecord, StoredAccount } from "./types.ts";
import { getStorePath, inferEmailFromOAuth, sameAccountIdentity } from "./utils/auth.ts";

const STORE_VERSION = 1;

function createEmptyStore(): AccountStore {
  return {
    version: STORE_VERSION,
    provider: "openai",
    accounts: [],
  };
}

function isStoredAccount(value: unknown): value is StoredAccount {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string" &&
    typeof candidate.auth === "object"
  );
}

export async function readStore(): Promise<AccountStore> {
  const path = getStorePath();

  try {
    const content = await readFile(path, "utf-8");
    const parsed = JSON.parse(content) as Partial<AccountStore>;
    if (parsed.version !== STORE_VERSION || parsed.provider !== "openai" || !Array.isArray(parsed.accounts)) {
      return createEmptyStore();
    }

    return {
      version: STORE_VERSION,
      provider: "openai",
      activeAccountID: typeof parsed.activeAccountID === "string" ? parsed.activeAccountID : undefined,
      accounts: parsed.accounts.filter(isStoredAccount),
    };
  } catch {
    return createEmptyStore();
  }
}

export async function writeStore(store: AccountStore): Promise<void> {
  const path = getStorePath();
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, path);
}

export function addAccount(store: AccountStore, auth: OAuthRecord): { store: AccountStore; account: StoredAccount } {
  const now = new Date().toISOString();
  const existing = store.accounts.find((account) => sameAccountIdentity(account.auth, auth));
  if (existing) {
    const updated: StoredAccount = {
      ...existing,
      auth,
      email: existing.email ?? inferEmailFromOAuth(auth),
      updatedAt: now,
    };

    return {
      account: updated,
      store: {
        ...store,
        activeAccountID: updated.id,
        accounts: store.accounts.map((account) => (account.id === updated.id ? updated : account)),
      },
    };
  }

  const account: StoredAccount = {
    id: crypto.randomUUID(),
    email: inferEmailFromOAuth(auth),
    auth,
    createdAt: now,
    updatedAt: now,
  };

  return {
    account,
    store: {
      ...store,
      activeAccountID: account.id,
      accounts: [...store.accounts, account],
    },
  };
}

export function removeAccount(store: AccountStore, accountID: string): AccountStore {
  const remaining = store.accounts.filter((account) => account.id !== accountID);
  const activeAccountID = store.activeAccountID === accountID ? remaining[0]?.id : store.activeAccountID;

  return {
    ...store,
    activeAccountID,
    accounts: remaining,
  };
}

export function setActiveAccount(store: AccountStore, accountID: string): AccountStore {
  if (!store.accounts.some((account) => account.id === accountID)) {
    return store;
  }

  return {
    ...store,
    activeAccountID: accountID,
  };
}

export function getAccountByID(store: AccountStore, accountID: string | undefined): StoredAccount | undefined {
  if (!accountID) {
    return undefined;
  }

  return store.accounts.find((account) => account.id === accountID);
}

export function syncCurrentAuth(store: AccountStore, auth: OAuthRecord | undefined): AccountStore {
  if (!auth) {
    return store;
  }

  const existing = store.accounts.find((account) => sameAccountIdentity(account.auth, auth));
  if (existing) {
    if (store.activeAccountID === existing.id && existing.email) {
      return store;
    }

    const now = new Date().toISOString();
    return {
      ...store,
      activeAccountID: existing.id,
      accounts: store.accounts.map((account) =>
        account.id === existing.id
          ? {
              ...account,
              email: account.email ?? inferEmailFromOAuth(auth),
              updatedAt: now,
            }
          : account,
      ),
    };
  }

  return addAccount(store, auth).store;
}
