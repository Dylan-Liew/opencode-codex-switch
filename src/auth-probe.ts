import type { AuthHook, PluginInput } from "@opencode-ai/plugin";
import { createServer } from "http";
import { addAccount, readStore, writeStore } from "./store.ts";

export interface CodexSwitchOptions {
  probeOpenAIAuthHook?: boolean;
}

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const OAUTH_PORT = 1455;
const BROWSER_METHOD_LABEL = "Codex Switch Add Account (browser)";

interface PkceCodes {
  verifier: string;
  challenge: string;
}

interface TokenResponse {
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

interface IdTokenClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
}

interface PendingOAuth {
  pkce: PkceCodes;
  state: string;
  resolve: (tokens: TokenResponse) => void;
  reject: (error: Error) => void;
}

let oauthServer: ReturnType<typeof createServer> | undefined;
let pendingOAuth: PendingOAuth | undefined;

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("");
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(43);
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return {
    verifier,
    challenge: base64UrlEncode(hash),
  };
}

function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    return undefined;
  }

  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString()) as IdTokenClaims;
  } catch {
    return undefined;
  }
}

function extractAccountId(tokens: TokenResponse): string | undefined {
  const idClaims = tokens.id_token ? parseJwtClaims(tokens.id_token) : undefined;
  const accessClaims = tokens.access_token ? parseJwtClaims(tokens.access_token) : undefined;

  return (
    idClaims?.chatgpt_account_id ||
    idClaims?.["https://api.openai.com/auth"]?.chatgpt_account_id ||
    idClaims?.organizations?.[0]?.id ||
    accessClaims?.chatgpt_account_id ||
    accessClaims?.["https://api.openai.com/auth"]?.chatgpt_account_id ||
    accessClaims?.organizations?.[0]?.id
  );
}

function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "opencode-codex-switch",
  });
  return `${ISSUER}/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForTokens(code: string, redirectUri: string, pkce: PkceCodes): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  return (await response.json()) as TokenResponse;
}

const HTML_SUCCESS = `<!doctype html><html><body><h1>Authorization Successful</h1><p>You can close this window and return to OpenCode.</p><script>setTimeout(()=>window.close(),2000)</script></body></html>`;
const HTML_ERROR = (error: string) =>
  `<!doctype html><html><body><h1>Authorization Failed</h1><p>${error}</p></body></html>`;

async function startOAuthServer(): Promise<string> {
  if (oauthServer) {
    return `http://localhost:${OAUTH_PORT}/auth/callback`;
  }

  oauthServer = createServer((request, response) => {
    const url = new URL(request.url || "/", `http://localhost:${OAUTH_PORT}`);

    if (url.pathname === "/auth/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");

      if (error) {
        pendingOAuth?.reject(new Error(errorDescription || error));
        pendingOAuth = undefined;
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(HTML_ERROR(errorDescription || error));
        return;
      }

      if (!code) {
        pendingOAuth?.reject(new Error("Missing authorization code"));
        pendingOAuth = undefined;
        response.writeHead(400, { "Content-Type": "text/html" });
        response.end(HTML_ERROR("Missing authorization code"));
        return;
      }

      if (!pendingOAuth || state !== pendingOAuth.state) {
        pendingOAuth?.reject(new Error("Invalid state"));
        pendingOAuth = undefined;
        response.writeHead(400, { "Content-Type": "text/html" });
        response.end(HTML_ERROR("Invalid state"));
        return;
      }

      const current = pendingOAuth;
      pendingOAuth = undefined;

      exchangeCodeForTokens(code, `http://localhost:${OAUTH_PORT}/auth/callback`, current.pkce)
        .then((tokens) => current.resolve(tokens))
        .catch((err) => current.reject(err instanceof Error ? err : new Error(String(err))));

      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(HTML_SUCCESS);
      return;
    }

    response.writeHead(404);
    response.end("Not found");
  });

  await new Promise<void>((resolve, reject) => {
    oauthServer!.listen(OAUTH_PORT, () => resolve());
    oauthServer!.on("error", reject);
  });

  return `http://localhost:${OAUTH_PORT}/auth/callback`;
}

function waitForOAuthCallback(pkce: PkceCodes, state: string): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!pendingOAuth) {
        return;
      }

      pendingOAuth = undefined;
      reject(new Error("OAuth callback timeout"));
    }, 5 * 60 * 1000);

    pendingOAuth = {
      pkce,
      state,
      resolve: (tokens) => {
        clearTimeout(timeout);
        resolve(tokens);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    };
  });
}

async function saveAccount(tokens: TokenResponse): Promise<void> {
  const auth = {
    type: "oauth" as const,
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId: extractAccountId(tokens),
  };
  const next = addAccount(await readStore(), auth);
  await writeStore(next.store);
}

export function getOpenAIAuthProbe(
  input: PluginInput,
  options: CodexSwitchOptions | undefined,
): AuthHook | undefined {
  if (!options?.probeOpenAIAuthHook) {
    return undefined;
  }

  return {
    provider: "openai",
    methods: [
      {
        type: "oauth",
        label: BROWSER_METHOD_LABEL,
        async authorize() {
          const redirectUri = await startOAuthServer();
          const pkce = await generatePKCE();
          const state = generateState();
          const authUrl = buildAuthorizeUrl(redirectUri, pkce, state);
          const callbackPromise = waitForOAuthCallback(pkce, state);

          return {
            url: authUrl,
            instructions: "Complete authorization in your browser. This window will close automatically.",
            method: "auto" as const,
            callback: async () => {
              const tokens = await callbackPromise;
              await saveAccount(tokens);
              return {
                type: "success" as const,
                refresh: tokens.refresh_token,
                access: tokens.access_token,
                expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                accountId: extractAccountId(tokens),
                provider: "openai",
              };
            },
          };
        },
      },
    ],
  };
}

export const openAIAuthMethodLabel = BROWSER_METHOD_LABEL;
