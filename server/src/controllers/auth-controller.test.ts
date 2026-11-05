import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import {
  OIDC_NONCE_COOKIE,
  OIDC_STATE_COOKIE,
  OIDC_VERIFIER_COOKIE
} from "../oidc.js";
import { SESSION_COOKIE_MAX_AGE_SECONDS } from "./controller-support.js";
import {
  decryptSessionToken,
  deriveSessionTokenEncryptionKey
} from "../session-token-crypto.js";
import {
  createMutableMockOidcProvider,
  loginWithOidc,
  testConfig
} from "../test-helpers.js";

const createdApps: ReturnType<typeof buildApp>[] = [];
const tempDirectories: string[] = [];

afterEach(async () => {
  while (createdApps.length > 0) {
    const app = createdApps.pop();
    if (app) {
      await app.close();
    }
  }

  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory) {
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

function createTempSqlitePath() {
  const directory = mkdtempSync(join(tmpdir(), "bbtodo-auth-"));
  tempDirectories.push(directory);
  return join(directory, "bbtodo.sqlite");
}

function withDatabase<T>(sqlitePath: string, callback: (database: Database.Database) => T) {
  const database = new Database(sqlitePath);

  try {
    return callback(database);
  } finally {
    database.close();
  }
}

function getSessionId(app: ReturnType<typeof buildApp>, rawSessionCookie: string) {
  const sessionCookie = app.unsignCookie(rawSessionCookie);
  if (!sessionCookie.valid) {
    throw new Error("Expected a valid signed session cookie.");
  }

  return sessionCookie.value;
}

function getPersistedSession(sqlitePath: string, sessionId: string) {
  return withDatabase(sqlitePath, (database) => {
    return (
      (database
        .prepare("SELECT id, expires_at, oidc_token FROM sessions WHERE id = ?")
        .get(sessionId) as {
        expires_at: string;
        id: string;
        oidc_token: string | null;
      } | undefined) ?? null
    );
  });
}

function getDecryptedPersistedToken(sqlitePath: string, sessionId: string) {
  const persistedSession = getPersistedSession(sqlitePath, sessionId);
  if (!persistedSession?.oidc_token) {
    return null;
  }

  return decryptSessionToken(
    persistedSession.oidc_token,
    deriveSessionTokenEncryptionKey(testConfig.sessionSecret)
  );
}

function expireSession(sqlitePath: string, sessionId: string) {
  withDatabase(sqlitePath, (database) => {
    database
      .prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", sessionId);
  });
}

describe("auth routes", () => {
  it("rejects /api/v1/me without a session", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "user-123",
      email: "hello@example.com",
      displayName: "bbtodo Tester"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/me"
    });

    expect(response.statusCode).toBe(401);
  });

  it("starts login with plugin cookies and a nonce-bearing redirect", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "user-123",
      email: "hello@example.com",
      displayName: "bbtodo Tester"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const loginResponse = await app.inject({
      method: "GET",
      url: "/auth/login"
    });

    expect(loginResponse.statusCode).toBe(302);
    expect(
      loginResponse.cookies.map((cookie) => cookie.name).sort()
    ).toEqual([
      OIDC_NONCE_COOKIE,
      OIDC_STATE_COOKIE,
      OIDC_VERIFIER_COOKIE
    ]);

    const redirectUrl = new URL(loginResponse.headers.location ?? "");
    expect(redirectUrl.origin + redirectUrl.pathname).toBe(
      "https://issuer.example.com/authorize"
    );
    expect(redirectUrl.searchParams.get("state")).toBe("test-state");
    expect(redirectUrl.searchParams.get("nonce")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it("creates a renewable session after the OIDC callback and clears it on logout", async () => {
    const sqlitePath = createTempSqlitePath();
    const oidc = createMutableMockOidcProvider({
      subject: "user-123",
      email: "hello@example.com",
      displayName: "bbtodo Tester"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);
    const sessionId = getSessionId(app, session.sessionCookie);
    const persistedSession = getPersistedSession(sqlitePath, sessionId);

    expect(session.callbackResponse.statusCode).toBe(302);
    expect(session.callbackResponse.headers.location).toBe("/");
    expect(session.sessionCookieRecord.maxAge).toBe(SESSION_COOKIE_MAX_AGE_SECONDS);
    expect(persistedSession?.oidc_token).not.toBeNull();
    expect(persistedSession?.oidc_token).not.toContain("test-refresh-token");

    const meResponse = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(meResponse.statusCode).toBe(200);
    expect(meResponse.json()).toMatchObject({
      email: "hello@example.com",
      name: "bbtodo Tester",
      theme: "sea"
    });

    const logoutResponse = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(logoutResponse.statusCode).toBe(204);

    const afterLogoutResponse = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(afterLogoutResponse.statusCode).toBe(401);
    expect(afterLogoutResponse.cookies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "bbtodo_session",
          value: ""
        })
      ])
    );
  });

  it("refreshes an expired session on /api/v1/me and rotates the stored token data", async () => {
    const sqlitePath = createTempSqlitePath();
    const oidc = createMutableMockOidcProvider({
      subject: "refresh-user",
      email: "refresh@example.com",
      displayName: "Refresh User"
    });
    oidc.setRefreshResponse({
      accessToken: "refreshed-access-token",
      refreshToken: "refreshed-refresh-token"
    });

    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);
    const sessionId = getSessionId(app, session.sessionCookie);
    const initialSession = getPersistedSession(sqlitePath, sessionId);

    expireSession(sqlitePath, sessionId);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    const refreshedSession = getPersistedSession(sqlitePath, sessionId);
    const refreshedToken = getDecryptedPersistedToken(sqlitePath, sessionId);

    expect(response.statusCode).toBe(200);
    expect(response.cookies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
          name: "bbtodo_session"
        })
      ])
    );
    expect(new Date(refreshedSession?.expires_at ?? 0).getTime()).toBeGreaterThan(
      new Date(initialSession?.expires_at ?? 0).getTime()
    );
    expect(refreshedToken).toMatchObject({
      access_token: "refreshed-access-token",
      refresh_token: "refreshed-refresh-token"
    });
  });

  it("refreshes an expired session for other authenticated API routes", async () => {
    const sqlitePath = createTempSqlitePath();
    const oidc = createMutableMockOidcProvider({
      subject: "tokens-user",
      email: "tokens@example.com",
      displayName: "Tokens User"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);
    const sessionId = getSessionId(app, session.sessionCookie);

    expireSession(sqlitePath, sessionId);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/api-tokens",
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
    expect(oidc.getRefreshCallCount()).toBe(1);
  });

  it("preserves the previous refresh token when refreshed tokens omit a replacement", async () => {
    const sqlitePath = createTempSqlitePath();
    const oidc = createMutableMockOidcProvider({
      subject: "rotation-user",
      email: "rotation@example.com",
      displayName: "Rotation User"
    });
    oidc.setMissingRefreshTokenOnRefresh(true);
    oidc.setRefreshResponse({
      accessToken: "rotated-access-token"
    });

    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);
    const sessionId = getSessionId(app, session.sessionCookie);

    expireSession(sqlitePath, sessionId);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    const persistedSession = getPersistedSession(sqlitePath, sessionId);
    const refreshedToken = getDecryptedPersistedToken(sqlitePath, sessionId);

    expect(response.statusCode).toBe(200);
    expect(refreshedToken).toMatchObject({
      access_token: "rotated-access-token",
      refresh_token: "test-refresh-token"
    });
  });

  it("clears expired sessions that were created without a refresh token and redirects with a warning notice on login", async () => {
    const sqlitePath = createTempSqlitePath();
    const oidc = createMutableMockOidcProvider({
      subject: "missing-refresh",
      email: "missing-refresh@example.com",
      displayName: "Missing Refresh"
    });
    oidc.setMissingRefreshToken(true);

    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);
    const sessionId = getSessionId(app, session.sessionCookie);

    expect(session.callbackResponse.statusCode).toBe(302);
    expect(session.callbackResponse.headers.location).toBe("/?authNotice=missing-refresh-token");
    expect(getPersistedSession(sqlitePath, sessionId)?.oidc_token).toBeNull();

    expireSession(sqlitePath, sessionId);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(response.statusCode).toBe(401);
    expect(getPersistedSession(sqlitePath, sessionId)).toBeNull();
    expect(response.cookies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "bbtodo_session",
          value: ""
        })
      ])
    );
  });

  it("clears the session when refresh fails unexpectedly", async () => {
    const sqlitePath = createTempSqlitePath();
    const oidc = createMutableMockOidcProvider({
      subject: "refresh-error",
      email: "refresh-error@example.com",
      displayName: "Refresh Error"
    });
    oidc.setRefreshError(new Error("refresh failed"));

    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);
    const sessionId = getSessionId(app, session.sessionCookie);

    expireSession(sqlitePath, sessionId);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(response.statusCode).toBe(401);
    expect(getPersistedSession(sqlitePath, sessionId)).toBeNull();
    expect(response.cookies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "bbtodo_session",
          value: ""
        })
      ])
    );
  });

  it("deduplicates concurrent refreshes for the same expired session", async () => {
    const sqlitePath = createTempSqlitePath();
    const oidc = createMutableMockOidcProvider({
      subject: "dedupe-user",
      email: "dedupe@example.com",
      displayName: "Dedupe User"
    });
    oidc.setRefreshDelayMs(40);

    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);
    const sessionId = getSessionId(app, session.sessionCookie);

    expireSession(sqlitePath, sessionId);

    const [firstResponse, secondResponse] = await Promise.all([
      app.inject({
        method: "GET",
        url: "/api/v1/me",
        cookies: {
          bbtodo_session: session.sessionCookie
        }
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/me",
        cookies: {
          bbtodo_session: session.sessionCookie
        }
      })
    ]);

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(oidc.getRefreshCallCount()).toBe(1);
  });

  it("rejects callbacks when the provider omits id_token", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "missing-token",
      email: "missing@example.com",
      displayName: "Missing Token"
    });
    oidc.setMissingIdToken(true);

    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const loginResponse = await app.inject({
      method: "GET",
      url: "/auth/login"
    });
    const redirectUrl = new URL(loginResponse.headers.location ?? "");
    (app as ReturnType<typeof buildApp> & {
      oidcTestControls?: { onAuthorizationNonce?: (nonce: string) => void };
    }).oidcTestControls?.onAuthorizationNonce?.(
      redirectUrl.searchParams.get("nonce") ?? ""
    );

    const callbackResponse = await app.inject({
      method: "GET",
      url: `/auth/callback?code=auth-code&state=test-state&iss=${encodeURIComponent(testConfig.oidcIssuer)}`,
      cookies: Object.fromEntries(
        loginResponse.cookies.map((cookie) => [cookie.name, cookie.value])
      )
    });

    expect(callbackResponse.statusCode).toBe(400);
    expect(callbackResponse.json()).toEqual({
      message: "OIDC provider did not return an id_token."
    });
  });

  it("rejects callbacks when JWT verification fails", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "bad-signature",
      email: "bad@example.com",
      displayName: "Bad Signature"
    });
    oidc.setVerifierError(new Error("signature verification failed"));

    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const loginResponse = await app.inject({
      method: "GET",
      url: "/auth/login"
    });
    const redirectUrl = new URL(loginResponse.headers.location ?? "");
    (app as ReturnType<typeof buildApp> & {
      oidcTestControls?: { onAuthorizationNonce?: (nonce: string) => void };
    }).oidcTestControls?.onAuthorizationNonce?.(
      redirectUrl.searchParams.get("nonce") ?? ""
    );

    const callbackResponse = await app.inject({
      method: "GET",
      url: `/auth/callback?code=auth-code&state=test-state&iss=${encodeURIComponent(testConfig.oidcIssuer)}`,
      cookies: Object.fromEntries(
        loginResponse.cookies.map((cookie) => [cookie.name, cookie.value])
      )
    });

    expect(callbackResponse.statusCode).toBe(400);
    expect(callbackResponse.json()).toEqual({
      message: "OIDC id_token validation failed."
    });
  });

  it("rejects callbacks with invalid issuer, audience, subject, or nonce claims", async () => {
    const testCases: Array<{
      expectedMessage: string;
      overrides: Record<string, unknown>;
    }> = [
      {
        expectedMessage:
          "OIDC id_token issuer did not match the configured issuer.",
        overrides: {
          iss: "https://wrong-issuer.example.com/"
        }
      },
      {
        expectedMessage:
          "OIDC id_token audience did not include the configured client.",
        overrides: {
          aud: "another-client"
        }
      },
      {
        expectedMessage:
          "OIDC id_token azp claim did not match the configured client.",
        overrides: {
          aud: [testConfig.oidcClientId, "other-audience"],
          azp: "different-client"
        }
      },
      {
        expectedMessage: "OIDC id_token nonce did not match the login request.",
        overrides: {
          nonce: "unexpected-nonce"
        }
      },
      {
        expectedMessage: "Invalid input: expected string, received undefined",
        overrides: {
          sub: undefined
        }
      }
    ];

    for (const testCase of testCases) {
      const oidc = createMutableMockOidcProvider({
        subject: "claims-user",
        email: "claims@example.com",
        displayName: "Claims User"
      });
      oidc.setClaimsOverrides(testCase.overrides);

      const app = buildApp({
        config: testConfig,
        oidcProvider: oidc.provider,
        sqlitePath: ":memory:"
      });
      createdApps.push(app);

      const loginResponse = await app.inject({
        method: "GET",
        url: "/auth/login"
      });
      const redirectUrl = new URL(loginResponse.headers.location ?? "");
      (app as ReturnType<typeof buildApp> & {
        oidcTestControls?: { onAuthorizationNonce?: (nonce: string) => void };
      }).oidcTestControls?.onAuthorizationNonce?.(
        redirectUrl.searchParams.get("nonce") ?? ""
      );

      const callbackResponse = await app.inject({
        method: "GET",
        url: `/auth/callback?code=auth-code&state=test-state&iss=${encodeURIComponent(testConfig.oidcIssuer)}`,
        cookies: Object.fromEntries(
          loginResponse.cookies.map((cookie) => [cookie.name, cookie.value])
        )
      });

      expect(callbackResponse.statusCode).toBe(400);
      expect(callbackResponse.json()).toEqual({
        message: testCase.expectedMessage
      });
    }
  });

  it("stores the selected theme as a user preference", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "theme-user",
      email: "themes@example.com",
      displayName: "Theme User"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);

    const updateThemeResponse = await app.inject({
      method: "PATCH",
      url: "/api/v1/me/theme",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        theme: "midnight"
      }
    });

    expect(updateThemeResponse.statusCode).toBe(200);
    expect(updateThemeResponse.json()).toMatchObject({
      id: expect.any(String),
      theme: "midnight"
    });

    const meResponse = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(meResponse.statusCode).toBe(200);
    expect(meResponse.json()).toMatchObject({
      theme: "midnight"
    });
  });
});
