import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import {
  deleteSession,
  getSessionWithUser,
  getUserForApiToken,
  type DatabaseClient,
  type UserRecord,
  updateSession
} from "../db.js";
import {
  describeOidcRefreshFailure,
  deserializeOidcOAuthToken,
  isTemporaryOidcRefreshFailure,
  mergeOidcRefreshToken,
  normalizeOidcOAuthToken,
  type OidcOAuth2Namespace
} from "../oidc.js";
import { decryptSessionToken, encryptSessionToken } from "../session-token-crypto.js";

export const SESSION_COOKIE = "bbtodo_session";
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const SESSION_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
export const SESSION_SUPPORT_DECORATION = "bbtodoSessionSupport";

export interface SessionSupportState {
  encryptionKey: Buffer;
  oauth2Namespace: OidcOAuth2Namespace | null;
  secureCookie: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    bbtodoSessionSupport: SessionSupportState;
  }
}

export const apiDocsSecurity: Array<Record<string, string[]>> = [
  { apiToken: [] },
  { sessionCookie: [] }
];
export const sessionDocsSecurity: Array<Record<string, string[]>> = [{ sessionCookie: [] }];

export function withZodTypeProvider(app: FastifyInstance) {
  return app.withTypeProvider<ZodTypeProvider>();
}

export type TypedApp = ReturnType<typeof withZodTypeProvider>;

type AuthRequest = Pick<FastifyRequest, "headers" | "cookies">;
type AuthReply = Pick<FastifyReply, "clearCookie" | "setCookie" | "status" | "send">;
interface SessionAuthContext {
  renewed: boolean;
  source: "session";
  user: UserRecord;
}

export interface ApiAuthContext {
  source: "bearer" | "session";
  user: UserRecord;
}

const SESSION_REFRESH_UNAVAILABLE = "session-refresh-unavailable";
type SessionResolution = SessionAuthContext | typeof SESSION_REFRESH_UNAVAILABLE | null;

const pendingSessionRefreshes = new Map<string, Promise<SessionResolution>>();

function getSessionSupport(app: FastifyInstance) {
  return app[SESSION_SUPPORT_DECORATION];
}

function getSessionCookieExpiresAt() {
  return new Date(Date.now() + SESSION_COOKIE_MAX_AGE_SECONDS * 1000);
}

export function setSessionCookie(
  app: FastifyInstance,
  reply: Pick<FastifyReply, "setCookie">,
  sessionId: string
) {
  const sessionSupport = getSessionSupport(app);

  reply.setCookie(SESSION_COOKIE, sessionId, {
    expires: getSessionCookieExpiresAt(),
    httpOnly: true,
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    path: "/",
    sameSite: "lax",
    secure: sessionSupport.secureCookie,
    signed: true
  });
}

export function getSignedCookieValue(
  app: FastifyInstance,
  rawCookieValue: string | undefined
) {
  if (!rawCookieValue) {
    return null;
  }

  const unsigned = app.unsignCookie(rawCookieValue);
  if (!unsigned.valid) {
    return null;
  }

  return unsigned.value;
}

export function encryptOidcTokenForStorage(
  app: FastifyInstance,
  oidcToken: Parameters<typeof encryptSessionToken>[0]
) {
  return encryptSessionToken(oidcToken, getSessionSupport(app).encryptionKey);
}

export function decryptStoredOidcToken(
  app: FastifyInstance,
  rawToken: string | null | undefined
) {
  if (!rawToken) {
    return null;
  }

  return (
    decryptSessionToken(rawToken, getSessionSupport(app).encryptionKey) ??
    deserializeOidcOAuthToken(rawToken)
  );
}

function formatSessionIdForLog(sessionId: string) {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
}

async function resolveSessionAuthContext(
  app: FastifyInstance,
  db: DatabaseClient,
  sessionId: string
): Promise<SessionResolution> {
  const sessionWithUser = getSessionWithUser(db, sessionId);
  if (!sessionWithUser) {
    return null;
  }

  if (new Date(sessionWithUser.session.expiresAt).getTime() > Date.now()) {
    return {
      renewed: false,
      source: "session",
      user: sessionWithUser.user
    } satisfies SessionAuthContext;
  }

  const sessionSupport = getSessionSupport(app);
  const oauth2Namespace = sessionSupport.oauth2Namespace;
  const sessionToken = decryptStoredOidcToken(app, sessionWithUser.session.oidcToken);

  if (!oauth2Namespace || !sessionToken) {
    deleteSession(db, sessionId);
    return null;
  }

  let pendingRefresh = pendingSessionRefreshes.get(sessionId);
  if (!pendingRefresh) {
    pendingRefresh = (async () => {
      try {
        const latestSessionWithUser = getSessionWithUser(db, sessionId);
        if (!latestSessionWithUser) {
          return null;
        }

        if (new Date(latestSessionWithUser.session.expiresAt).getTime() > Date.now()) {
          return {
            renewed: false,
            source: "session",
            user: latestSessionWithUser.user
          } satisfies SessionAuthContext;
        }

        const latestSessionToken = decryptStoredOidcToken(app, latestSessionWithUser.session.oidcToken);
        if (!latestSessionToken) {
          deleteSession(db, sessionId);
          return null;
        }

        const refreshedTokenResponse = await oauth2Namespace.getNewAccessTokenUsingRefreshToken(
          latestSessionToken,
          {}
        );
        const refreshedToken = mergeOidcRefreshToken(
          latestSessionToken,
          normalizeOidcOAuthToken(refreshedTokenResponse.token)
        );
        const refreshedSession = updateSession(db, {
          expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
          oidcToken: encryptOidcTokenForStorage(app, refreshedToken),
          sessionId
        });

        if (!refreshedSession) {
          return null;
        }

        return {
          renewed: true,
          source: "session",
          user: latestSessionWithUser.user
        } satisfies SessionAuthContext;
      } catch (error) {
        const isTemporary = isTemporaryOidcRefreshFailure(error);

        app.log.warn(
          {
            failure: describeOidcRefreshFailure(error),
            sessionFingerprint: formatSessionIdForLog(sessionId)
          },
          isTemporary
            ? "OIDC session refresh failed temporarily; keeping the session."
            : "OIDC session refresh failed."
        );

        if (isTemporary) {
          return SESSION_REFRESH_UNAVAILABLE;
        }

        deleteSession(db, sessionId);
        return null;
      } finally {
        pendingSessionRefreshes.delete(sessionId);
      }
    })();

    pendingSessionRefreshes.set(sessionId, pendingRefresh);
  }

  return pendingRefresh;
}

export async function getApiAuthContext(
  app: FastifyInstance,
  db: DatabaseClient,
  request: AuthRequest,
  reply: AuthReply
) {
  const authorizationHeader = request.headers.authorization;
  const bearerToken =
    typeof authorizationHeader === "string" &&
    authorizationHeader.startsWith("Bearer ")
      ? authorizationHeader.slice("Bearer ".length).trim()
      : null;

  if (bearerToken) {
    const user = getUserForApiToken(db, bearerToken);
    if (!user) {
      reply.status(401).send({
        message: "Authentication required."
      });
      return null;
    }

    return {
      source: "bearer",
      user
    } satisfies ApiAuthContext;
  }

  const sessionId = getSignedCookieValue(app, request.cookies[SESSION_COOKIE]);
  if (!sessionId) {
    reply.status(401).send({
      message: "Authentication required."
    });
    return null;
  }

  const auth = await resolveSessionAuthContext(app, db, sessionId);
  if (auth === SESSION_REFRESH_UNAVAILABLE) {
    reply.status(503).send({
      message: "Your sign-in provider is temporarily unavailable. Please try again shortly."
    });
    return null;
  }

  if (!auth) {
    reply.clearCookie(SESSION_COOKIE, {
      path: "/"
    });
    reply.status(401).send({
      message: "Authentication required."
    });
    return null;
  }

  if (auth.renewed) {
    setSessionCookie(app, reply, sessionId);
  }

  return auth satisfies ApiAuthContext;
}

export async function requireApiUser(
  app: FastifyInstance,
  db: DatabaseClient,
  request: AuthRequest,
  reply: AuthReply
) {
  const auth = await getApiAuthContext(app, db, request, reply);
  return auth?.user ?? null;
}

export async function requireSessionApiUser(
  app: FastifyInstance,
  db: DatabaseClient,
  request: AuthRequest,
  reply: AuthReply
) {
  const auth = await getApiAuthContext(app, db, request, reply);
  if (!auth) {
    return null;
  }

  if (auth.source === "bearer") {
    reply.status(403).send({
      message: "API tokens cannot create API tokens."
    });
    return null;
  }

  return auth.user;
}
