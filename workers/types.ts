// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export type OutboundProvider = "cf_email" | "aws_ses";

export type MailboxPersona = "pablo" | "antonio";

export interface MailboxSettingsRecord {
	fromName?: string;
	aliases?: string[];
	llmModel?: string;
	autoDraftEnabled?: boolean;
	persona?: MailboxPersona;
	requireExplicitConfirm?: boolean;
	agentSystemPrompt?: string;
	forwarding?: {
		enabled: boolean;
		email: string;
	};
	signature?: {
		enabled: boolean;
		text: string;
		html?: string;
	};
	autoReply?: {
		enabled: boolean;
		subject: string;
		message: string;
	};
}

export interface PlatformConfig {
	domains: string[];
	outboundProvider: OutboundProvider;
	sesRegion: string;
	defaultFromDomain: string;
	cobradorUrl: string;
	aliases?: Record<string, string>;
	removedDomains?: string[];
}

export interface CobradorServiceBinding extends Fetcher {
	getClientDossier?: (emailOrClientId: string) => Promise<unknown>;
	registerPaymentClaim?: (input: {
		email?: string;
		clientId?: string;
		cycleId?: string;
		amountClp?: number;
		rut?: string;
		glosa?: string;
		source?: string;
		note?: string;
	}) => Promise<unknown>;
	dryRunForecast?: (startDate: string, days: number) => Promise<unknown>;
	exportBackupSnapshot?: () => Promise<unknown>;
}

export interface Env extends Cloudflare.Env {
	AGENT_API_KEY?: string;
	INTERNAL_API_KEY?: string;
	COBRADOR_URL?: string;
	COBRADOR?: CobradorServiceBinding;
	AWS_ACCESS_KEY_ID?: string;
	AWS_SECRET_ACCESS_KEY?: string;
	AWS_SESSION_TOKEN?: string;
	AWS_SES_REGION?: string;
	OUTBOUND_PROVIDER?: OutboundProvider;
}
