// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Dynamic platform configuration persisted in R2 at `config/platform.json`.
 *
 * Merges static `env.DOMAINS` with runtime domains/settings stored in R2
 * so operators can add/remove domains, switch outbound providers
 * (`cf_email` vs `aws_ses`), and configure `cobradorUrl` from the UI
 * without redeploying the Worker.
 */

import type { Env, OutboundProvider, PlatformConfig } from "../types";

export const PLATFORM_CONFIG_KEY = "config/platform.json";
export const DEFAULT_SES_REGION = "sa-east-1";
export const DEFAULT_COBRADOR_URL = "https://cobro.computincloudhosting.com";

function normalizeDomain(domain: string): string {
	return domain.trim().toLowerCase().replace(/^@+/, "");
}

function parseEnvDomains(raw?: string): string[] {
	if (!raw) return [];
	return Array.from(
		new Set(
			raw
				.split(",")
				.map(normalizeDomain)
				.filter(Boolean),
		),
	);
}

interface StoredPlatformConfig {
	domains?: string[];
	removedDomains?: string[];
	outboundProvider?: OutboundProvider;
	sesRegion?: string;
	defaultFromDomain?: string;
	cobradorUrl?: string;
	aliases?: Record<string, string>;
}

export async function readRawPlatformConfig(
	bucket: R2Bucket,
): Promise<StoredPlatformConfig | null> {
	try {
		const obj = await bucket.get(PLATFORM_CONFIG_KEY);
		if (!obj) return null;
		return (await obj.json()) as StoredPlatformConfig;
	} catch {
		return null;
	}
}

export async function getPlatformConfig(env: Env): Promise<PlatformConfig & {
	emailAddresses: string[];
	awsSesConfigured: boolean;
}> {
	const envDomains = parseEnvDomains(env.DOMAINS);
	const stored = await readRawPlatformConfig(env.BUCKET);

	const removedSet = new Set(
		(stored?.removedDomains ?? []).map(normalizeDomain).filter(Boolean),
	);
	const storedDomains = (stored?.domains ?? [])
		.map(normalizeDomain)
		.filter(Boolean);

	const mergedDomains = Array.from(
		new Set([
			...envDomains.filter((d) => !removedSet.has(d)),
			...storedDomains,
		]),
	);

	const awsSesConfigured = Boolean(
		env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY,
	);

	const defaultProvider: OutboundProvider =
		env.OUTBOUND_PROVIDER === "aws_ses" || env.OUTBOUND_PROVIDER === "cf_email"
			? env.OUTBOUND_PROVIDER
			: awsSesConfigured
				? "aws_ses"
				: "cf_email";

	const outboundProvider: OutboundProvider =
		stored?.outboundProvider === "aws_ses" || stored?.outboundProvider === "cf_email"
			? stored.outboundProvider
			: defaultProvider;

	const sesRegion =
		stored?.sesRegion?.trim() || env.AWS_SES_REGION?.trim() || DEFAULT_SES_REGION;

	const defaultFromDomain =
		(stored?.defaultFromDomain &&
			mergedDomains.includes(normalizeDomain(stored.defaultFromDomain))
			? normalizeDomain(stored.defaultFromDomain)
			: mergedDomains[0]) || "computin.dev";

	const cobradorUrl = (
		stored?.cobradorUrl?.trim() ||
		env.COBRADOR_URL?.trim() ||
		DEFAULT_COBRADOR_URL
	).replace(/\/+$/, "");

	const aliases: Record<string, string> = {};
	if (stored?.aliases && typeof stored.aliases === "object") {
		for (const [alias, target] of Object.entries(stored.aliases)) {
			const cleanAlias = alias.trim().toLowerCase();
			const cleanTarget = String(target || "").trim().toLowerCase();
			if (cleanAlias && cleanTarget) {
				aliases[cleanAlias] = cleanTarget;
			}
		}
	}

	const emailAddresses = ((env.EMAIL_ADDRESSES ?? []) as readonly string[]).map((a) =>
		a.toLowerCase(),
	);

	return {
		domains: mergedDomains,
		outboundProvider,
		sesRegion,
		defaultFromDomain,
		cobradorUrl,
		aliases,
		emailAddresses,
		awsSesConfigured,
	};
}

export async function updatePlatformConfig(
	env: Env,
	patch: {
		domains?: string[];
		outboundProvider?: OutboundProvider;
		sesRegion?: string;
		defaultFromDomain?: string;
		cobradorUrl?: string;
		aliases?: Record<string, string>;
	},
) {
	const envDomains = parseEnvDomains(env.DOMAINS);
	const existing = (await readRawPlatformConfig(env.BUCKET)) ?? {};
	const current = await getPlatformConfig(env);

	let nextDomains = existing.domains
		? existing.domains.map(normalizeDomain).filter(Boolean)
		: current.domains;
	let nextRemoved = new Set(
		(existing.removedDomains ?? []).map(normalizeDomain).filter(Boolean),
	);

	if (patch.domains !== undefined) {
		const normalizedIncoming = Array.from(
			new Set(patch.domains.map(normalizeDomain).filter(Boolean)),
		);
		nextDomains = normalizedIncoming;
		nextRemoved = new Set(
			envDomains.filter((envDom) => !normalizedIncoming.includes(envDom)),
		);
	}

	const nextStored: StoredPlatformConfig = {
		domains: nextDomains,
		removedDomains: Array.from(nextRemoved),
		outboundProvider: patch.outboundProvider ?? current.outboundProvider,
		sesRegion: patch.sesRegion?.trim() || current.sesRegion,
		defaultFromDomain: patch.defaultFromDomain
			? normalizeDomain(patch.defaultFromDomain)
			: nextDomains.includes(current.defaultFromDomain)
				? current.defaultFromDomain
				: nextDomains[0] || current.defaultFromDomain,
		cobradorUrl: (patch.cobradorUrl?.trim() || current.cobradorUrl).replace(
			/\/+$/,
			"",
		),
		aliases: patch.aliases ?? current.aliases ?? {},
	};

	await env.BUCKET.put(PLATFORM_CONFIG_KEY, JSON.stringify(nextStored, null, 2));
	return getPlatformConfig(env);
}
