import { stat } from "node:fs/promises";
import path from "node:path";

import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import oauthPlugin from "@fastify/oauth2";
import staticFiles from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler
} from "fastify-type-provider-zod";
import { z } from "zod";

import type { AppConfig } from "./config.js";
import { registerApiTokensController } from "./controllers/api-tokens-controller.js";
import { registerAuthController } from "./controllers/auth-controller.js";
import {
  SESSION_SUPPORT_DECORATION,
  SESSION_COOKIE,
  withZodTypeProvider
} from "./controllers/controller-support.js";
import { registerBoardController } from "./controllers/board-controller.js";
import { SQLITE_DATABASE_PATH, createDatabase } from "./db.js";
import {
  OIDC_OAUTH_NAMESPACE,
  OIDC_REQUEST_TIMEOUT_MS,
  OIDC_STATE_COOKIE,
  OIDC_VERIFIER_COOKIE,
  createJwksSecretResolver,
  resolveOidcDiscoveryDocument,
  type JwksSecretResolver,
  type OidcAuthTestingOptions,
  type OidcOAuth2Namespace
} from "./oidc.js";
import { deriveSessionTokenEncryptionKey } from "./session-token-crypto.js";

declare module "fastify" {
  interface FastifyInstance {
    oidcJwksSecretResolver?: JwksSecretResolver;
    oidcOAuth2: OidcOAuth2Namespace;
    oidcTestControls?: OidcAuthTestingOptions;
  }
}

function isSecureCookie(clientUrl: string) {
  return new URL(clientUrl).protocol === "https:";
}

function isReservedAppPath(pathname: string) {
  return (
    pathname === "/health" ||
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/auth" ||
    pathname.startsWith("/auth/") ||
    pathname === "/docs" ||
    pathname.startsWith("/docs/")
  );
}

function sanitizeOpenApiForDocs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeOpenApiForDocs(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "$id" && key !== "$schema")
      .map(([key, entry]) => [key, sanitizeOpenApiForDocs(entry)])
  );
}

async function resolveClientAssetPath(root: string, pathname: string) {
  const relativePath = pathname.replace(/^\/+/, "");
  if (!relativePath) {
    return null;
  }

  const absolutePath = path.resolve(root, relativePath);
  const relativeToRoot = path.relative(root, absolutePath);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    return null;
  }

  try {
    const entry = await stat(absolutePath);
    return entry.isFile() ? relativeToRoot : null;
  } catch {
    return null;
  }
}

export function buildApp(options: {
  config: AppConfig;
  clientDistPath?: string;
  authTesting?: OidcAuthTestingOptions;
  oidcProvider?: OidcAuthTestingOptions;
  sqlitePath?: string;
}) {
  const app = Fastify({
    logger: true
  });
  const database = createDatabase(options.sqlitePath ?? SQLITE_DATABASE_PATH);
  const authTesting = options.authTesting ?? options.oidcProvider;
  const secureCookie = isSecureCookie(options.config.clientUrl);
  const clientDistPath = options.clientDistPath
    ? path.resolve(options.clientDistPath)
    : null;

  app.decorate(SESSION_SUPPORT_DECORATION, {
    encryptionKey: deriveSessionTokenEncryptionKey(options.config.sessionSecret),
    oauth2Namespace: null,
    secureCookie
  });

  app.register(cookie, {
    secret: options.config.sessionSecret
  });
  if (authTesting) {
    app.decorate("oidcTestControls", authTesting);
  }
  app.register(async (authApp) => {
    if (authTesting?.oauth2Namespace) {
      authApp.decorate(OIDC_OAUTH_NAMESPACE, authTesting.oauth2Namespace);
      app[SESSION_SUPPORT_DECORATION].oauth2Namespace = authTesting.oauth2Namespace;
    } else {
      await authApp.register(oauthPlugin, {
        callbackUri: `${options.config.clientUrl}/auth/callback`,
        cookie: {
          httpOnly: true,
          path: "/auth",
          sameSite: "lax",
          secure: secureCookie
        },
        credentials: {
          client: {
            id: options.config.oidcClientId,
            secret: options.config.oidcClientSecret
          },
          http: {
            timeout: authTesting?.requestTimeoutMs ?? OIDC_REQUEST_TIMEOUT_MS
          }
        },
        discovery: {
          issuer: options.config.oidcIssuer
        },
        name: OIDC_OAUTH_NAMESPACE,
        pkce: "S256",
        redirectStateCookieName: OIDC_STATE_COOKIE,
        scope: options.config.oidcScopes.split(/\s+/).filter(Boolean),
        verifierCookieName: OIDC_VERIFIER_COOKIE
      });
      app[SESSION_SUPPORT_DECORATION].oauth2Namespace = authApp[OIDC_OAUTH_NAMESPACE];
    }

    if (authTesting?.jwtVerifier) {
      authApp.decorate("jwt", authTesting.jwtVerifier as never);
    } else {
      const discoveryDocument =
        authTesting?.discoveryDocument ??
        (await resolveOidcDiscoveryDocument(options.config.oidcIssuer));
      const jwksSecretResolver = createJwksSecretResolver({
        clientSecret: options.config.oidcClientSecret,
        jwksUri: discoveryDocument.jwksUri
      });
      authApp.decorate(
        "oidcJwksSecretResolver",
        jwksSecretResolver
      );
      await authApp.register(jwt as never, {
        decode: {
          complete: true
        },
        secret: jwksSecretResolver,
        verify: {
          allowedAud: options.config.oidcClientId,
          allowedIss: discoveryDocument.issuer
        }
      } as never);
    }

    registerAuthController(withZodTypeProvider(authApp), {
      config: options.config,
      database: database.db,
      secureCookie
    });
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(swagger, {
    openapi: {
      info: {
        title: "bbtodo API",
        version: "0.1.0",
        description: "Minimal kanban and todo API for bbtodo."
      },
      openapi: "3.1.0",
      servers: [
        {
          url: options.config.clientUrl
        }
      ],
      components: {
        securitySchemes: {
          apiToken: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "API token",
            description: "Paste a personal API token. Swagger UI will send it as `Authorization: Bearer <token>`."
          },
          sessionCookie: {
            type: "apiKey",
            in: "cookie",
            name: SESSION_COOKIE,
            description: "Browser session cookie set after OIDC login."
          }
        }
      }
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject
  });
  app.register(swaggerUi, {
    routePrefix: "/docs",
    transformSpecification: (swaggerObject) =>
      sanitizeOpenApiForDocs(swaggerObject) as Record<string, unknown>
  });
  if (clientDistPath) {
    app.register(staticFiles, {
      root: clientDistPath,
      serve: false
    });
  }
  app.addHook("onSend", async (request, reply, payload) => {
    const pathname = new URL(request.raw.url ?? request.url, options.config.clientUrl).pathname;
    if (pathname === "/docs" || pathname.startsWith("/docs/")) {
      reply.header("Cache-Control", "no-store");
    }

    return payload;
  });

  app.after(() => {
    const typedApp = withZodTypeProvider(app);

    typedApp.route({
      method: "GET",
      url: "/health",
      schema: {
        response: {
          200: z.object({
            app: z.literal("bbtodo-server"),
            status: z.literal("ok")
          })
        },
        tags: ["system"]
      },
      handler: async () => ({
        app: "bbtodo-server",
        status: "ok"
      } as const)
    });

    registerApiTokensController(typedApp, {
      database: database.db
    });
    registerBoardController(typedApp, {
      database: database.db
    });

    typedApp.route({
      method: "GET",
      url: "/docs/openapi.json",
      schema: {
        hide: true
      },
      handler: async (_request, reply) => {
        reply.header("Cache-Control", "no-store");
        return sanitizeOpenApiForDocs(app.swagger());
      }
    });

    if (clientDistPath) {
      typedApp.route({
        method: "GET",
        url: "/*",
        schema: {
          hide: true
        },
        handler: async (request, reply) => {
          const pathname = new URL(request.raw.url ?? request.url, options.config.clientUrl).pathname;

          if (isReservedAppPath(pathname)) {
            return reply.callNotFound();
          }

          const assetPath = await resolveClientAssetPath(clientDistPath, pathname);
          if (assetPath) {
            return reply.sendFile(assetPath);
          }

          if (path.extname(pathname)) {
            return reply.callNotFound();
          }

          return reply.sendFile("index.html");
        }
      });
    }
  });

  app.addHook("onClose", async () => {
    database.database.close();
  });

  return app;
}
