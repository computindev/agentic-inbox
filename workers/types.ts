// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface MailboxSettingsRecord {
	fromName?: string;
	aliases?: string[];
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

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
}
