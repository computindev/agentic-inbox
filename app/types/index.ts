// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface SignatureSettings {
	enabled: boolean;
	text: string;
	html?: string;
}

export type AgentPersona = "pablo" | "antonio";

export type OutboundProvider = "cf_email" | "aws_ses";

export interface PlatformConfig {
	domains: string[];
	emailAddresses?: string[];
	outboundProvider?: OutboundProvider;
	sesRegion?: string;
	defaultFromDomain?: string;
	cobradorUrl?: string;
	awsSesConfigured?: boolean;
	defaultPabloPrompt?: string;
}

export interface TestEmailResponse {
	ok: boolean;
	messageId?: string;
	provider?: string;
	error?: string;
}

export interface MigrateMailboxResponse {
	ok?: boolean;
	mailbox?: Mailbox;
	newEmail?: string;
	error?: string;
}

export interface MailboxSettings {
	fromName?: string;
	aliases?: string[];
	llmModel?: string;
	autoDraftEnabled?: boolean;
	persona?: AgentPersona;
	requireExplicitConfirm?: boolean;
	forwarding?: { enabled: boolean; email: string };
	signature?: SignatureSettings;
	autoReply?: { enabled: boolean; subject: string; message: string };
	agentSystemPrompt?: string;
}

export interface Mailbox {
	id: string;
	email: string;
	name: string;
	settings?: MailboxSettings;
}

export interface Email {
	id: string;
	thread_id?: string | null;
	folder_id?: string | null;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string;
	bcc?: string;
	date: string;
	read: boolean;
	starred: boolean;
	body?: string | null;
	in_reply_to?: string | null;
	email_references?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	attachments?: Attachment[];
	snippet?: string | null;
	// Thread aggregate fields (only present in threaded list view)
	thread_count?: number;
	thread_unread_count?: number;
	participants?: string;
	needs_reply?: boolean;
	has_draft?: boolean;
}

export interface Attachment {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string;
	disposition?: string;
}

export interface Folder {
	id: string;
	name: string;
	unreadCount: number;
}

export interface DossierClientInfo {
	id: string;
	displayName?: string;
	name?: string;
	billingGroup?: string;
	billingEmails?: string[];
	rut?: string | null;
	razonSocial?: string | null;
	giro?: string | null;
	docPreference?: string | null;
	courtesy?: number | boolean;
	holdReason?: string | null;
	notes?: string | null;
}

export interface DossierSubscriptionInfo {
	id: string;
	planCode?: string;
	planName?: string;
	plan?: string;
	description?: string | null;
	priceUf?: number;
	anchorDate?: string | null;
	leadDays?: number;
	usageNote?: string | null;
}

export type CycleEffectiveState =
	| "open"
	| "payment_claimed"
	| "paid"
	| "waived"
	| "cancelled";

export interface DossierCycleInfo {
	id: string;
	kind?: string;
	periodStart?: string;
	periodEnd?: string;
	dueDate?: string;
	priceUf?: number;
	amountClpToday?: number | null;
	netoClpToday?: number | null;
	ivaClpToday?: number | null;
	ufToday?: number | null;
	status?: string;
	effectiveState?: CycleEffectiveState;
	paymentClaimedAt?: string | null;
	paymentClaimNote?: string | null;
	ocNumber?: string | null;
	payToken?: string | null;
	payUrl?: string | null;
	bankReference?: string | null;
}

export interface ClientDossier {
	found?: boolean;
	cobradorUrl?: string;
	adminUrl?: string;
	client?: DossierClientInfo | null;
	subscription?: DossierSubscriptionInfo | null;
	activeCycle?: DossierCycleInfo | null;
	cycle?: DossierCycleInfo | null;
	dossier?: Omit<ClientDossier, "dossier"> | null;
	// Optional flat fields fallback
	clientId?: string;
	clientName?: string;
	plan?: string;
	priceUf?: number;
	amountClp?: number;
	dueDate?: string;
	status?: string;
	payToken?: string;
	payUrl?: string;
}

export interface PaymentClaimInput {
	email?: string;
	clientId?: string;
	cycleId?: string;
	amountClp?: number;
	rut?: string;
	glosa?: string;
	note?: string;
}

export interface PaymentClaimResponse {
	ok: boolean;
	matched?: boolean;
	matchedBy?: string;
	cycleId?: string;
	clientId?: string;
	clientName?: string;
	effectiveState?: string;
	reason?: string;
	error?: string;
}
