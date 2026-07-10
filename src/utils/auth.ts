import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type { OAuthRecord, RawAuthJson } from "../types.ts";

function getDataHome(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

export function getAuthJsonPath(): string {
  return join(getDataHome(), "opencode", "auth.json");
}

export function getCodexAuthJsonPath(): string {
  return join(homedir(), ".codex", "auth.json");
}

export function getStorePath(): string {
  return join(getDataHome(), "opencode", "codex-switch.json");
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const content = await readFile(path, "utf-8");
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export async function getRawAuthJson(): Promise<RawAuthJson> {
  return ((await readJsonObject(getAuthJsonPath())) as RawAuthJson | undefined) ?? {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function expiryValue(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function expiryFromAccessToken(access: string): number | undefined {
  const payload = decodeJwtPayload(access);
  return expiryValue(payload?.exp);
}

export function normalizeOAuthRecord(value: unknown): OAuthRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const type = typeof candidate.type === "string" ? candidate.type : undefined;
  const access = typeof candidate.access === "string" ? candidate.access : undefined;
  const refresh = typeof candidate.refresh === "string" ? candidate.refresh : undefined;
  const expires = typeof candidate.expires === "number" ? candidate.expires : undefined;

  if (type !== "oauth" || !access || !refresh || !Number.isFinite(expires)) {
    return undefined;
  }

  return {
    type: "oauth",
    access,
    refresh,
    expires: expires as number,
    accountId: typeof candidate.accountId === "string" ? candidate.accountId : undefined,
    enterpriseUrl: typeof candidate.enterpriseUrl === "string" ? candidate.enterpriseUrl : undefined,
  };
}

function normalizeCodexOAuthRecord(value: unknown): OAuthRecord | undefined {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  const tokens = candidate?.tokens && typeof candidate.tokens === "object" ? (candidate.tokens as Record<string, unknown>) : undefined;
  if (!tokens) {
    return undefined;
  }

  const access = stringValue(tokens.access_token);
  const refresh = stringValue(tokens.refresh_token);
  if (!access || !refresh) {
    return undefined;
  }

  const expires = expiryValue(tokens.expires_at) ?? expiryValue(tokens.expires) ?? expiryFromAccessToken(access);
  if (!expires) {
    return undefined;
  }

  return {
    type: "oauth",
    access,
    refresh,
    expires,
    accountId: stringValue(tokens.account_id),
  };
}

export async function getCurrentOpenAIOAuth(): Promise<OAuthRecord | undefined> {
  const rawAuth = await getRawAuthJson();
  return normalizeOAuthRecord(rawAuth.openai) ?? normalizeCodexOAuthRecord(await readJsonObject(getCodexAuthJsonPath()));
}

export function sameOAuthRecord(left: OAuthRecord | undefined, right: OAuthRecord | undefined): boolean {
  if (!left || !right) {
    return left === right;
  }

  return (
    left.type === right.type &&
    left.access === right.access &&
    left.refresh === right.refresh &&
    left.expires === right.expires &&
    left.accountId === right.accountId &&
    left.enterpriseUrl === right.enterpriseUrl
  );
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  const payload = parts[1];
  if (!payload) {
    return undefined;
  }

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const json = Buffer.from(padded, "base64").toString("utf-8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function inferEmailFromOAuth(record: OAuthRecord): string | undefined {
  const payload = decodeJwtPayload(record.access);
  if (!payload) {
    return undefined;
  }

  const keys = ["email", "preferred_username", "upn", "unique_name"] as const;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.includes("@")) {
      return value;
    }
  }

  const profile = payload["https://api.openai.com/profile"];
  if (profile && typeof profile === "object") {
    const email = (profile as Record<string, unknown>).email;
    if (typeof email === "string" && email.includes("@")) {
      return email;
    }
  }

  return undefined;
}

export function sameAccountIdentity(left: OAuthRecord | undefined, right: OAuthRecord | undefined): boolean {
  if (!left || !right) {
    return false;
  }

  if (left.accountId && right.accountId) {
    return left.accountId === right.accountId;
  }

  return sameOAuthRecord(left, right);
}
