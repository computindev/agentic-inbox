// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { WorkerEntrypoint } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { createRequestHandler } from "react-router";
import {
	app as apiApp,
	receiveEmail,
	recordSentEmailMirror,
	type InboundEmailEvent,
	type SentMirrorPayload,
} from "./index";
import { EmailMCP } from "./mcp";
import type { Env } from "./types";

export { MailboxDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";

/**
 * Service Binding RPC entrypoint so `cobrador-hosting` (`env.INBOX`)
 * can mirror sent billing emails directly into `pablo@computin.dev`'s `Sent` folder.
 */
export class InboxRPC extends WorkerEntrypoint<Env> {
	async recordSentMirror(payload: SentMirrorPayload) {
		return recordSentEmailMirror(this.env, payload);
	}
}

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

// Cache JWKS sets per certsUrl to avoid refetching keys on every HTTP request,
// while letting jose handle cooldown-based key rotation (`CF-11`).
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getAccessVerifier(teamDomain: string) {
	const certsPath = "/cdn-cgi/access/certs";
	const teamUrl = new URL(teamDomain);
	const issuer = teamUrl.origin;
	const certsUrl = teamUrl.pathname.endsWith(certsPath)
		? teamUrl
		: new URL(certsPath, issuer);

	const cacheKey = certsUrl.toString();
	let jwks = jwksCache.get(cacheKey);
	if (!jwks) {
		jwks = createRemoteJWKSet(certsUrl);
		jwksCache.set(cacheKey, jwks);
	}

	return { issuer, jwks };
}

/**
 * Constant-time string comparison via SHA-256 digests so Bearer API key
 * verification never leaks secret length or prefix timing.
 */
async function timingSafeTokenEqual(a: string, b: string): Promise<boolean> {
	if (!a || !b) return false;
	const enc = new TextEncoder();
	const [hashA, hashB] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(a)),
		crypto.subtle.digest("SHA-256", enc.encode(b)),
	]);
	const bytesA = new Uint8Array(hashA);
	const bytesB = new Uint8Array(hashB);
	if (bytesA.length !== bytesB.length || a.length !== b.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < bytesA.length; i++) {
		diff |= bytesA[i] ^ bytesB[i];
	}
	return diff === 0;
}

type RootContext = {
	Bindings: Env;
	Variables: {
		authMethod?: "cf_access" | "agent_api_key" | "dev";
	};
};

// Main app that wraps the API, MCP server, and React Router fallback
const app = new Hono<RootContext>();

// Dual Authentication Middleware:
// Allows `/mcp` and `/api/*` via `Authorization: Bearer <env.AGENT_API_KEY>`
// (or `INTERNAL_API_KEY` on `/api/internal/*`) OR Cloudflare Access JWT (`cf-access-jwt-assertion`).
app.use("*", async (c, next) => {
	if (import.meta.env.DEV) {
		c.set("authMethod", "dev");
		return next();
	}

	const path = new URL(c.req.url).pathname;
	const isApiOrMcp =
		path === "/mcp" || path.startsWith("/mcp/") || path.startsWith("/api/");
	const isInternalRoute = path.startsWith("/api/internal/");

	// 1. Check Bearer API Key for `/mcp` and `/api/*` when configured
	if (isApiOrMcp) {
		const authHeader = c.req.header("authorization") || "";
		const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
		const providedKey = bearerMatch?.[1]?.trim() || c.req.header("x-internal-key")?.trim() || "";

		if (providedKey) {
			if (
				c.env.AGENT_API_KEY &&
				(await timingSafeTokenEqual(providedKey, c.env.AGENT_API_KEY))
			) {
				c.set("authMethod", "agent_api_key");
				return next();
			}
			if (
				isInternalRoute &&
				c.env.INTERNAL_API_KEY &&
				(await timingSafeTokenEqual(providedKey, c.env.INTERNAL_API_KEY))
			) {
				c.set("authMethod", "agent_api_key");
				return next();
			}
		}
	}

	// 2. Cloudflare Access JWT validation
	const { POLICY_AUD, TEAM_DOMAIN } = c.env;

	if (!POLICY_AUD || !TEAM_DOMAIN) {
		return c.text(
			"Cloudflare Access must be configured in production. Set POLICY_AUD and TEAM_DOMAIN.",
			500,
		);
	}

	const token = c.req.header("cf-access-jwt-assertion");
	if (!token) {
		return c.text("Missing required CF Access JWT or valid Bearer AGENT_API_KEY", 403);
	}

	try {
		const { issuer, jwks } = getAccessVerifier(TEAM_DOMAIN);
		await jwtVerify(token, jwks, {
			issuer,
			audience: POLICY_AUD,
		});
	} catch {
		return c.text("Invalid or expired Access token", 403);
	}

	c.set("authMethod", "cf_access");
	return next();
});

// MCP server endpoint — used by AI coding tools (`pi`, Claude Code, Antigravity, Cursor)
const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });
app.all("/mcp", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});
app.all("/mcp/*", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});

// Mount the API routes
app.route("/", apiApp);

// Agent WebSocket routing - must be before React Router catch-all
app.all("/agents/*", async (c) => {
	const response = await routeAgentRequest(c.req.raw, c.env);
	if (response) return response;
	return c.text("Agent not found", 404);
});

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", (c) => {
	return requestHandler(c.req.raw, {
		cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
	});
});

// Export the Hono app as the default export with an email handler (`CF-03`)
export default {
	fetch: app.fetch,
	async email(
		event: InboundEmailEvent,
		env: Env,
		ctx: ExecutionContext,
	) {
		try {
			await receiveEmail(event, env, ctx);
		} catch (e) {
			console.error(
				"Failed to process incoming email:",
				(e as Error).message,
				(e as Error).stack,
			);
			throw e;
		}
	},
};
