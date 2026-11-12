// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared email helpers across HTTP API routes, Durable Objects, MCP, and EmailAgent.
 */
import type { MailboxDO } from "../durableObject";
import type { EmailFull } from "./schemas";
import { Folders } from "../../shared/folders";
import type { Env, MailboxSettingsRecord } from "../types";
import { formatQuotedDate } from "../../shared/dates";

// ── DO Stub ────────────────────────────────────────────────────────

export function getMailboxStub(
	env: Env,
	mailboxId: string,
): DurableObjectStub<MailboxDO> {
	const ns = env.MAILBOX;
	const id = ns.idFromName(mailboxId.toLowerCase().trim());
	return ns.get(id);
}

// ── Mailbox Settings & Alias Resolution ────────────────────────────

export async function getMailboxSettings(
	bucket: R2Bucket,
	mailboxId: string,
): Promise<MailboxSettingsRecord> {
	try {
		const obj = await bucket.get(`mailboxes/${mailboxId.toLowerCase().trim()}.json`);
		if (!obj) return {};
		return ((await obj.json()) as MailboxSettingsRecord) || {};
	} catch {
		return {};
	}
}

export function mergeMailboxSettings(
	existing: MailboxSettingsRecord,
	patch: Record<string, unknown>,
): MailboxSettingsRecord {
	const next: MailboxSettingsRecord = {
		...existing,
	};

	if (typeof patch.fromName === "string") {
		next.fromName = patch.fromName;
	}
	if (Array.isArray(patch.aliases)) {
		next.aliases = Array.from(
			new Set(
				patch.aliases
					.map((a) => String(a || "").trim().toLowerCase())
					.filter((a) => a.includes("@")),
			),
		);
	}
	if (typeof patch.llmModel === "string") {
		next.llmModel = patch.llmModel.trim() || undefined;
	}
	if (typeof patch.autoDraftEnabled === "boolean") {
		next.autoDraftEnabled = patch.autoDraftEnabled;
	}
	if (patch.persona === "pablo" || patch.persona === "antonio") {
		next.persona = patch.persona;
	}
	if (typeof patch.requireExplicitConfirm === "boolean") {
		next.requireExplicitConfirm = patch.requireExplicitConfirm;
	}
	if ("agentSystemPrompt" in patch) {
		const val = patch.agentSystemPrompt;
		next.agentSystemPrompt =
			typeof val === "string" && val.trim() ? val.trim() : "";
	}
	if (patch.forwarding && typeof patch.forwarding === "object") {
		const fw = patch.forwarding as Record<string, unknown>;
		next.forwarding = {
			enabled:
				typeof fw.enabled === "boolean"
					? fw.enabled
					: Boolean(existing.forwarding?.enabled),
			email:
				typeof fw.email === "string"
					? fw.email.trim().toLowerCase()
					: existing.forwarding?.email ?? "",
		};
	}
	if (patch.signature && typeof patch.signature === "object") {
		const sig = patch.signature as Record<string, unknown>;
		next.signature = {
			enabled:
				typeof sig.enabled === "boolean"
					? sig.enabled
					: Boolean(existing.signature?.enabled),
			text:
				typeof sig.text === "string"
					? sig.text
					: existing.signature?.text ?? "",
			...(typeof sig.html === "string"
				? { html: sig.html }
				: existing.signature?.html
					? { html: existing.signature.html }
					: {}),
		};
	}
	if (patch.autoReply && typeof patch.autoReply === "object") {
		const ar = patch.autoReply as Record<string, unknown>;
		next.autoReply = {
			enabled:
				typeof ar.enabled === "boolean"
					? ar.enabled
					: Boolean(existing.autoReply?.enabled),
			subject:
				typeof ar.subject === "string"
					? ar.subject
					: existing.autoReply?.subject ?? "",
			message:
				typeof ar.message === "string"
					? ar.message
					: existing.autoReply?.message ?? "",
		};
	}

	return next;
}

export async function listMailboxes(
	bucket: R2Bucket,
): Promise<{ id: string; email: string }[]> {
	const list = await bucket.list({ prefix: "mailboxes/" });
	return list.objects.map((obj) => {
		const id = obj.key.replace("mailboxes/", "").replace(/\.json$/, "");
		return { id, email: id };
	});
}

export async function listMailboxesWithSettings(bucket: R2Bucket): Promise<
	Array<{
		id: string;
		email: string;
		name: string;
		settings: MailboxSettingsRecord;
	}>
> {
	const base = await listMailboxes(bucket);
	return Promise.all(
		base.map(async (m) => {
			const settings = await getMailboxSettings(bucket, m.id);
			return {
				id: m.id,
				email: m.email,
				name: settings.fromName?.trim() || m.id,
				settings,
			};
		}),
	);
}

function stripPlusSubaddress(email: string): string {
	const [local, domain] = email.split("@");
	if (!local || !domain) return email;
	const baseLocal = local.split("+")[0];
	return baseLocal ? `${baseLocal}@${domain}` : email;
}

/**
 * Resolve an inbound email's target mailbox (`CF-03`):
 * 1. Checks `envelopeTo` (`event.to`) first against primary mailboxes, `+tag` base,
 *    `platformAliases`, and per-mailbox `settings.aliases`.
 * 2. Falls back to checking all `To`, `CC`, and `BCC` recipients against the same map
 *    so multi-recipient, CC, BCC, and alias-routed emails are never silently dropped.
 */
export async function resolveInboundMailbox(
	bucket: R2Bucket,
	options: {
		envelopeTo?: string | null;
		headerRecipients: string[];
		allowedAddresses?: string[];
		platformAliases?: Record<string, string>;
	},
): Promise<{
	mailboxId: string;
	settings: MailboxSettingsRecord;
	matchedAddress: string;
} | null> {
	const allowed = (options.allowedAddresses ?? []).map((a) => a.toLowerCase().trim());
	const platformAliases = options.platformAliases ?? {};

	const orderedCandidates: string[] = [];
	const pushCandidate = (raw?: string | null) => {
		const clean = raw?.toLowerCase().trim();
		if (clean && clean.includes("@") && !orderedCandidates.includes(clean)) {
			orderedCandidates.push(clean);
		}
	};

	pushCandidate(options.envelopeTo);
	for (const r of options.headerRecipients) {
		pushCandidate(r);
	}

	if (orderedCandidates.length === 0) return null;

	// Fast path for direct primary mailbox hit on first candidate (typically `event.to`)
	const first = orderedCandidates[0];
	const firstBase = stripPlusSubaddress(first);
	for (const probe of first === firstBase ? [first] : [first, firstBase]) {
		if (allowed.length === 0 || allowed.includes(probe)) {
			const directObj = await bucket.get(`mailboxes/${probe}.json`);
			if (directObj) {
				const settings = ((await directObj.json()) as MailboxSettingsRecord) || {};
				return { mailboxId: probe, settings, matchedAddress: first };
			}
		}
	}

	// Load full mailbox + alias map from R2
	const allMailboxes = await listMailboxesWithSettings(bucket);
	const byPrimary = new Map(
		allMailboxes.map((m) => [m.id.toLowerCase(), m.settings]),
	);
	const byAlias = new Map<string, { mailboxId: string; settings: MailboxSettingsRecord }>();

	for (const m of allMailboxes) {
		for (const alias of m.settings.aliases ?? []) {
			const cleanAlias = alias.toLowerCase().trim();
			if (cleanAlias) {
				byAlias.set(cleanAlias, { mailboxId: m.id.toLowerCase(), settings: m.settings });
			}
		}
	}

	for (const [alias, target] of Object.entries(platformAliases)) {
		const cleanAlias = alias.toLowerCase().trim();
		const cleanTarget = target.toLowerCase().trim();
		const targetSettings = byPrimary.get(cleanTarget);
		if (cleanAlias && targetSettings) {
			byAlias.set(cleanAlias, { mailboxId: cleanTarget, settings: targetSettings });
		}
	}

	for (const candidate of orderedCandidates) {
		const base = stripPlusSubaddress(candidate);
		for (const probe of candidate === base ? [candidate] : [candidate, base]) {
			if (allowed.length > 0 && !allowed.includes(probe) && !byAlias.has(probe)) {
				continue;
			}
			const directSettings = byPrimary.get(probe);
			if (directSettings) {
				return { mailboxId: probe, settings: directSettings, matchedAddress: candidate };
			}
			const aliasTarget = byAlias.get(probe);
			if (aliasTarget) {
				return {
					mailboxId: aliasTarget.mailboxId,
					settings: aliasTarget.settings,
					matchedAddress: candidate,
				};
			}
		}
	}

	return null;
}

/**
 * RFC 3834 & anti-loop filter (`CF-12`) to prevent `EmailAgent` from
 * auto-drafting replies to bounces, `mailer-daemon`, `no-reply@`, or self-loops.
 */
export function isAutomatedOrBounceEmail(input: {
	sender: string;
	envelopeFrom?: string | null;
	headers?: Array<{ key: string; value: string }> | Record<string, string> | null;
	selfAddresses?: string[];
}): { automated: boolean; reason?: string } {
	const sender = (input.sender || "").toLowerCase().trim();
	const envFrom = (input.envelopeFrom ?? "").toLowerCase().trim();

	// Empty SMTP reverse-path (`MAIL FROM:<>`) indicates a bounce / DSN (RFC 5321)
	if (input.envelopeFrom !== undefined && input.envelopeFrom !== null && envFrom === "") {
		return { automated: true, reason: "empty_envelope_from_bounce" };
	}

	if (!sender) {
		return { automated: true, reason: "missing_sender" };
	}

	const selfSet = new Set((input.selfAddresses ?? []).map((s) => s.toLowerCase().trim()));
	if (selfSet.has(sender)) {
		return { automated: true, reason: "self_loop" };
	}

	const automatedAddressRe =
		/^(?:mailer-daemon|postmaster|no-reply|noreply|do-not-reply|donotreply|bounce|bounces|auto-reply|autoreply)(?:\+[^@]*)?@/i;
	if (automatedAddressRe.test(sender) || automatedAddressRe.test(envFrom)) {
		return { automated: true, reason: "automated_sender_address" };
	}

	// Never auto-reply directly to bank notification senders
	if (/@(?:[\w.-]+\.)?bancochile\.cl$/i.test(sender)) {
		return { automated: true, reason: "bank_notification_sender" };
	}

	const getHeader = (name: string): string | null => {
		if (!input.headers) return null;
		const lower = name.toLowerCase();
		if (Array.isArray(input.headers)) {
			const hit = input.headers.find((h) => h.key?.toLowerCase() === lower);
			return hit ? String(hit.value || "") : null;
		}
		for (const [k, v] of Object.entries(input.headers)) {
			if (k.toLowerCase() === lower) return String(v || "");
		}
		return null;
	};

	const autoSubmitted = getHeader("auto-submitted")?.toLowerCase().trim();
	if (autoSubmitted && autoSubmitted !== "no") {
		return { automated: true, reason: `auto_submitted_${autoSubmitted}` };
	}

	const returnPath = getHeader("return-path")?.trim();
	if (returnPath === "<>") {
		return { automated: true, reason: "null_return_path" };
	}

	const forwardedLoop = getHeader("x-agentic-forwarded-from");
	if (forwardedLoop) {
		return { automated: true, reason: "internal_forward_loop" };
	}

	return { automated: false };
}

// ── Sender Validation & Signature Formatting ───────────────────────

export function validateSender(
	to: string | string[],
	from: string | { email: string; name: string },
	mailboxId: string,
	allowedAliases: string[] = [],
): { toStr: string; fromEmail: string; fromDomain: string } {
	const toStr = (Array.isArray(to) ? to.join(", ") : to).toLowerCase();
	const fromEmail = (typeof from === "string" ? from : from.email).toLowerCase().trim();

	const validSenders = new Set([
		mailboxId.toLowerCase().trim(),
		...allowedAliases.map((a) => a.toLowerCase().trim()),
	]);

	if (!validSenders.has(fromEmail)) {
		throw new SenderValidationError(
			"From address must match the mailbox email address or one of its configured aliases",
		);
	}

	const fromDomain = fromEmail.split("@")[1];
	if (!fromDomain) {
		throw new SenderValidationError("Invalid sender email address");
	}

	return { toStr, fromEmail, fromDomain };
}

export class SenderValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SenderValidationError";
	}
}

export function resolveOutboundFrom(
	fromInput: string | { email: string; name: string } | undefined,
	mailboxId: string,
	settings?: MailboxSettingsRecord,
): string | { email: string; name: string } {
	const email =
		typeof fromInput === "string"
			? fromInput
			: fromInput?.email || mailboxId;
	const explicitName =
		typeof fromInput === "object" && fromInput?.name?.trim()
			? fromInput.name.trim()
			: settings?.fromName?.trim();

	return explicitName ? { email, name: explicitName } : email;
}

export function appendSignature(
	body: string,
	signature: MailboxSettingsRecord["signature"] | undefined,
	isHtml: boolean,
): string {
	if (!signature?.enabled || !signature.text?.trim()) {
		return body;
	}

	const sigText = signature.text.trim();
	const bodyPlain = isHtml ? stripHtmlToText(body) : body;
	const normBody = bodyPlain.replace(/\s+/g, " ").trim().toLowerCase();
	const normSig = sigText.replace(/\s+/g, " ").trim().toLowerCase();

	// Avoid duplicating the signature if already included in the body
	if (normSig && normBody.endsWith(normSig)) {
		return body;
	}

	if (isHtml) {
		const sigHtml =
			signature.html?.trim() ||
			`<div style="white-space:pre-wrap;color:#555">${escapeHtml(sigText).replace(/\n/g, "<br>")}</div>`;
		return `${body}<br><br>${sigHtml}`;
	}

	return `${body}\n\n${sigText}`;
}

// ── R2 Cascade Deletion Helper (CF-12) ─────────────────────────────

export async function deleteEmailWithAttachments(
	stub: DurableObjectStub<MailboxDO>,
	bucket: R2Bucket,
	emailId: string,
): Promise<{ id: string; filename: string }[] | null> {
	const attachments = await stub.deleteEmail(emailId);
	if (attachments === null) return null;

	if (attachments.length > 0) {
		await bucket.delete(
			attachments.map((att) => `attachments/${emailId}/${att.id}/${att.filename}`),
		);
	}

	return attachments;
}

// ── Message ID & RFC 5322 Threading Headers (CF-02) ────────────────

export function generateMessageId(fromDomain: string): {
	messageId: string;
	outgoingMessageId: string;
} {
	const messageId = crypto.randomUUID();
	const outgoingMessageId = `${messageId}@${fromDomain}`;
	return { messageId, outgoingMessageId };
}

export function buildReferencesChain(original: EmailFull): {
	originalMsgId: string;
	references: string[];
	threadId: string;
} {
	const originalMsgId = original.message_id || original.id;
	let existingRefs: string[] = [];
	if (original.email_references) {
		try {
			existingRefs = JSON.parse(original.email_references);
		} catch {
			// Malformed JSON in email_references — treat as empty
		}
	}
	const references = [...existingRefs, originalMsgId].filter(Boolean);
	const threadId = original.thread_id || original.id;
	return { originalMsgId, references, threadId };
}

/**
 * Build threading headers (`In-Reply-To` + `References`) and optional wire `Message-ID`.
 */
export function buildThreadingHeaders(
	originalMsgId: string,
	references: string[],
	outgoingMessageId?: string,
): Record<string, string> {
	return {
		...(outgoingMessageId ? { "Message-ID": `<${outgoingMessageId}>` } : {}),
		"In-Reply-To": `<${originalMsgId}>`,
		...(references.length > 0
			? { References: references.map((r) => `<${r}>`).join(" ") }
			: {}),
	};
}

/**
 * Build outbound headers that ALWAYS include `"Message-ID": "<outgoingMessageId>"`
 * so the wire Message-ID matches SQLite `message_id` (`CF-02`).
 */
export function buildOutboundHeaders(
	outgoingMessageId: string,
	threading?: { inReplyTo?: string | null; references?: string[] },
	extra?: Record<string, string>,
): Record<string, string> {
	const headers: Record<string, string> = {
		"Message-ID": `<${outgoingMessageId}>`,
	};
	if (threading?.inReplyTo) {
		headers["In-Reply-To"] = `<${threading.inReplyTo.replace(/^<+|>+$/g, "")}>`;
	}
	if (threading?.references && threading.references.length > 0) {
		headers.References = threading.references
			.map((r) => `<${r.replace(/^<+|>+$/g, "")}>`)
			.join(" ");
	}
	if (extra) {
		Object.assign(headers, extra);
	}
	return headers;
}

// ── Draft-follows-in_reply_to ──────────────────────────────────────

export async function resolveOriginalEmail(
	stub: DurableObjectStub<MailboxDO>,
	email: EmailFull,
): Promise<EmailFull> {
	if (email.folder_id === Folders.DRAFT && email.in_reply_to) {
		const realOriginal = (await stub.getEmail(email.in_reply_to)) as EmailFull | null;
		if (realOriginal) return realOriginal;
	}
	return email;
}

// ── HTML Utilities & Chilean Spanish Quoted Reply Block ────────────

export function escapeHtml(text: string): string {
	if (!text) return "";
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function textToHtml(text: string): string {
	if (!text) return "";
	const escaped = escapeHtml(text).replace(/\n/g, "<br>");
	return `<div style="white-space:pre-wrap">${escaped}</div>`;
}

export function stripHtmlToText(html: string): string {
	if (!html) return "";
	return html
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export const formatEmailDate = formatQuotedDate;

/**
 * Build a quoted reply block HTML string localized to Chilean Spanish (`CF-07`).
 */
export function buildQuotedReplyBlock(original: {
	date?: string;
	sender?: string;
	body?: string;
}): string {
	if (!original.body) return "";

	const originalSender = escapeHtml(original.sender || "desconocido");
	const originalDate = escapeHtml(formatEmailDate(original.date || ""));

	const plainBody = stripHtmlToText(original.body);
	const bodyToQuote = escapeHtml(plainBody).replace(/\n/g, "<br>");

	return `<br><blockquote style="border-left: 2px solid #ccc; margin: 0; padding-left: 1em; color: #666;">El ${originalDate}, ${originalSender} escribió:<br><br>${bodyToQuote}</blockquote>`;
}

// ── Tool Logic (getFullEmail / getFullThread) ──────────────────────

type MailboxThreadReaderStub = {
	getThreadEmails: (threadId: string) => Promise<EmailFull[]>;
};

export async function getFullEmail(
	stub: DurableObjectStub<MailboxDO>,
	emailId: string,
) {
	const email = (await stub.getEmail(emailId)) as EmailFull | null;
	if (!email) return null;

	const textBody = email.body ? stripHtmlToText(email.body) : "";
	return { ...email, body_text: textBody, body_html: email.body };
}

export async function getFullThread(
	stub: DurableObjectStub<MailboxDO>,
	threadId: string,
) {
	const threadStub = stub as unknown as MailboxThreadReaderStub;
	const emails = await threadStub.getThreadEmails(threadId);

	const enriched = emails.map((email) => {
		const textBody = email.body ? stripHtmlToText(email.body) : "";
		return { ...email, body_text: textBody };
	});

	enriched.sort(
		(a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
	);

	return { thread_id: threadId, message_count: enriched.length, messages: enriched };
}
