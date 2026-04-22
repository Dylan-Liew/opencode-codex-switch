export interface OAuthRecord {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  enterpriseUrl?: string;
}

export interface StoredAccount {
  id: string;
  email?: string;
  auth: OAuthRecord;
  createdAt: string;
  updatedAt: string;
}

export interface AccountStore {
  version: 1;
  provider: "openai";
  activeAccountID?: string;
  accounts: StoredAccount[];
}

export interface RawAuthJsonProvider {
  [key: string]: unknown;
}

export interface RawAuthJson {
  [key: string]: RawAuthJsonProvider | undefined;
}

export interface AccountView {
  account: StoredAccount;
  isActive: boolean;
}
