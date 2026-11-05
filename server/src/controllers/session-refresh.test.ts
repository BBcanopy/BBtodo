import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.js";
import { createDatabase, createSession, upsertUser } from "../db.js";
import { createMutableMockOidcProvider, testConfig } from "../test-helpers.js";
import { encryptOidcTokenForStorage } from "./controller-support.js";

type TokenResponder = (response: ServerResponse) => void;

const hang: TokenResponder = () => {};

function json(status: number, body: unknown): TokenResponder {
  return (response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
}

function html(status: number): TokenResponder {
  return (response) => {
    response.writeHead(status, { "content-type": "text/html" });
    response.end("<html><body>Gateway page</body></html>");
  };
}

const refreshedTokens = json(200, {
  access_token: "refreshed-access-token",
  expires_in: 3600,
  refresh_token: "refreshed-refresh-token",
  token_type: "Bearer"
});

// These tests use the real @fastify/oauth2 and simple-oauth2 clients against a local provider,
// so they fail if a library upgrade changes the shape of the errors the session logic relies on.
describe("session refresh against a real OAuth client", () => {
  let app: ReturnType<typeof buildApp>;
  let directory: string;
  let provider: Server;
  let respondToTokenRequest: TokenResponder;
  let sqlitePath: string;

  async function closeProvider() {
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "bbtodo-refresh-"));
    sqlitePath = join(directory, "bbtodo.sqlite");

    provider = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        if (request.url === "/token") {
          respondToTokenRequest(response);
          return;
        }

        const { port } = provider.address() as AddressInfo;
        json(200, {
          authorization_endpoint: `http://127.0.0.1:${port}/authorize`,
          issuer: `http://127.0.0.1:${port}`,
          token_endpoint: `http://127.0.0.1:${port}/token`
        })(response);
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));

    const { port } = provider.address() as AddressInfo;
    const { jwtVerifier } = createMutableMockOidcProvider({
      displayName: "Refresh",
      email: "refresh@example.com",
      subject: "refresh"
    }).authTesting;

    app = buildApp({
      authTesting: { jwtVerifier, requestTimeoutMs: 200 },
      config: { ...testConfig, oidcIssuer: `http://127.0.0.1:${port}` },
      sqlitePath
    });
    await app.ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (provider.listening) {
      await closeProvider();
    }
    await app.close();
    rmSync(directory, { force: true, recursive: true });
  });

  async function createExpiredSession() {
    const services = createDatabase(sqlitePath);

    try {
      const user = await upsertUser(services.db, {
        displayName: "Refresh",
        email: "refresh@example.com",
        issuer: testConfig.oidcIssuer,
        subject: "refresh"
      });
      const session = createSession(services.db, {
        expiresAt: "2000-01-01T00:00:00.000Z",
        oidcToken: encryptOidcTokenForStorage(app, {
          access_token: "stored-access-token",
          expires_at: new Date("2000-01-01T00:00:00.000Z"),
          expires_in: 3600,
          refresh_token: "stored-refresh-token",
          token_type: "Bearer"
        }),
        userId: user.id
      });

      return { cookie: app.signCookie(session.id), id: session.id };
    } finally {
      services.database.close();
    }
  }

  function readSession(sessionId: string) {
    const database = new Database(sqlitePath);

    try {
      return database
        .prepare("SELECT expires_at, oidc_token FROM sessions WHERE id = ?")
        .get(sessionId) as { expires_at: string; oidc_token: string } | undefined;
    } finally {
      database.close();
    }
  }

  function requestMe(cookie: string) {
    return app.inject({
      cookies: { bbtodo_session: cookie },
      method: "GET",
      url: "/api/v1/me"
    });
  }

  it.each<[string, TokenResponder]>([
    ["a 503 from the provider", json(503, { error: "temporarily_unavailable" })],
    ["an HTML error page", html(500)],
    ["a non-JSON success page", html(200)],
    ["rate limiting", json(429, { error: "slow_down" })],
    ["a rejected client credential", json(401, { error: "invalid_client" })],
    ["a provider that never answers", hang]
  ])("keeps the session through %s", async (_label, responder) => {
    respondToTokenRequest = responder;
    const session = await createExpiredSession();
    const before = readSession(session.id);

    const response = await requestMe(session.cookie);

    expect(response.statusCode).toBe(503);
    expect(response.json().message).toMatch(/temporarily unavailable/i);
    expect(response.cookies.some((cookie) => cookie.name === "bbtodo_session")).toBe(false);
    expect(readSession(session.id)).toEqual(before);
  });

  it("keeps the session when the provider is unreachable", async () => {
    const session = await createExpiredSession();
    await closeProvider();

    const response = await requestMe(session.cookie);

    expect(response.statusCode).toBe(503);
    expect(readSession(session.id)).toBeDefined();
  });

  it("renews the session once the provider recovers", async () => {
    respondToTokenRequest = html(502);
    const session = await createExpiredSession();
    const before = readSession(session.id);

    expect((await requestMe(session.cookie)).statusCode).toBe(503);

    respondToTokenRequest = refreshedTokens;
    const response = await requestMe(session.cookie);

    expect(response.statusCode).toBe(200);
    expect(response.cookies.some((cookie) => cookie.name === "bbtodo_session" && cookie.value !== "")).toBe(true);
    expect(new Date(readSession(session.id)!.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(readSession(session.id)!.oidc_token).not.toBe(before!.oidc_token);
  });

  it.each<[string, TokenResponder]>([
    ["invalid_grant", json(400, { error: "invalid_grant" })],
    ["invalid_request", json(400, { error: "invalid_request" })]
  ])("ends the session when the provider rejects the grant with %s", async (_label, responder) => {
    respondToTokenRequest = responder;
    const session = await createExpiredSession();

    const response = await requestMe(session.cookie);

    expect(response.statusCode).toBe(401);
    expect(readSession(session.id)).toBeUndefined();
    expect(response.cookies).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "bbtodo_session", value: "" })])
    );
  });

  it("does not log the client credentials when a refresh fails", async () => {
    respondToTokenRequest = json(400, { error: "invalid_grant" });
    const session = await createExpiredSession();
    const warn = vi.spyOn(app.log, "warn");

    await requestMe(session.cookie);

    const logged = inspect(warn.mock.calls, { depth: 12 });
    expect(warn).toHaveBeenCalled();
    expect(logged).not.toContain("Authorization");
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      failure: { oauthError: "invalid_grant", statusCode: 400 }
    });
  });
});
