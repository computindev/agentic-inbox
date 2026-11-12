// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Context } from "hono";
import { sendOutboundEmail } from "../email-sender";
import { checkPersonaGovernance } from "../lib/ai";
import { storeAttachments } from "../lib/attachments";
import type { EmailFull } from "../lib/schemas";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildReferencesChain,
	buildOutboundHeaders,
	resolveOriginalEmail,
	getMailboxSettings,
	resolveOutboundFrom,
} from "../lib/email-helpers";
import { SendEmailRequestSchema } from "../lib/schemas";
import { Folders } from "../../shared/folders";
import type { MailboxContext } from "../lib/mailbox";

type AppContext = Context<MailboxContext>;
type RateLimitStub = { checkSendRateLimit: () => Promise<string | null> };

export async function handleReplyEmail(c: AppContext) {
	const mailboxId = (c.req.param("mailboxId") ?? "").toLowerCase().trim();
	const id = c.req.param("id") ?? "";
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments, confirmedByHuman } = body;

	const stub = c.var.mailboxStub;
	const rawOriginal = (await stub.getEmail(id)) as EmailFull | null;

	if (!rawOriginal) {
		return c.json({ error: "Original email not found" }, 404);
	}

	const settings = await getMailboxSettings(c.env.BUCKET, mailboxId);

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(
			to,
			from,
			mailboxId,
			settings.aliases,
		));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	// Enforce Persona Governance for API key callers unless confirmedByHuman is true
	const isHumanBrowser = c.var.authMethod !== "agent_api_key";
	const governance = checkPersonaGovernance({
		mailboxId,
		settings,
		from,
		body: html || text || "",
		confirmedByHuman: confirmedByHuman ?? isHumanBrowser,
	});
	if (!governance.allowed) {
		return c.json({ error: governance.error }, 403);
	}

	const originalEmail = await resolveOriginalEmail(stub, rawOriginal);
	const { originalMsgId, references, threadId: thread_id } = buildReferencesChain(originalEmail);

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit();
	if (rateLimitError) {
		return c.json({ error: rateLimitError }, 429);
	}

	const effectiveFrom = resolveOutboundFrom(from, fromEmail, settings);

	// Synchronous send BEFORE writing to Folders.SENT (`CF-02` — eliminates Fake-Sent)
	let sendRes: { messageId: string; wireMessageId: string; provider: string };
	try {
		sendRes = await sendOutboundEmail(c.env, {
			to,
			cc,
			bcc,
			from: effectiveFrom,
			subject,
			html,
			text,
			attachments: attachments?.map((att) => ({
				content: att.content,
				filename: att.filename,
				type: att.type,
				disposition: att.disposition,
				contentId: att.contentId,
			})),
			headers: buildOutboundHeaders(outgoingMessageId, {
				inReplyTo: originalMsgId,
				references,
			}),
		});
	} catch (e) {
		console.error("Reply email delivery failed:", (e as Error).message);
		return c.json({ error: `Failed to send reply: ${(e as Error).message}` }, 502);
	}

	const wireMessageId = sendRes.wireMessageId || outgoingMessageId;
	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);
	const nowIso = new Date().toISOString();

	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject,
			sender: fromEmail,
			recipient: toStr,
			cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
			bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
			date: nowIso,
			body: html || text || "",
			in_reply_to: originalMsgId,
			email_references: JSON.stringify(references),
			thread_id,
			message_id: wireMessageId,
			raw_headers: JSON.stringify([
				{
					key: "from",
					value:
						typeof effectiveFrom === "string"
							? effectiveFrom
							: `${effectiveFrom.name} <${effectiveFrom.email}>`,
				},
				{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
				...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
				...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
				{ key: "subject", value: subject },
				{ key: "date", value: nowIso },
				{ key: "message-id", value: `<${wireMessageId}>` },
				...(originalMsgId ? [{ key: "in-reply-to", value: `<${originalMsgId}>` }] : []),
				...(references.length > 0
					? [{ key: "references", value: references.map((r: string) => `<${r}>`).join(" ") }]
					: []),
			]),
		},
		attachmentData,
	);

	await stub.markThreadRead(thread_id);

	return c.json(
		{
			id: messageId,
			messageId: wireMessageId,
			provider: sendRes.provider,
			status: "sent",
		},
		200,
	);
}

export async function handleForwardEmail(c: AppContext) {
	const mailboxId = (c.req.param("mailboxId") ?? "").toLowerCase().trim();
	const id = c.req.param("id") ?? "";
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments, confirmedByHuman } = body;

	const stub = c.var.mailboxStub;
	const rawOriginal = (await stub.getEmail(id)) as EmailFull | null;

	if (!rawOriginal) {
		return c.json({ error: "Original email not found" }, 404);
	}

	await resolveOriginalEmail(stub, rawOriginal);
	const settings = await getMailboxSettings(c.env.BUCKET, mailboxId);

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(
			to,
			from,
			mailboxId,
			settings.aliases,
		));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const isHumanBrowser = c.var.authMethod !== "agent_api_key";
	const governance = checkPersonaGovernance({
		mailboxId,
		settings,
		from,
		body: html || text || "",
		confirmedByHuman: confirmedByHuman ?? isHumanBrowser,
	});
	if (!governance.allowed) {
		return c.json({ error: governance.error }, 403);
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit();
	if (rateLimitError) {
		return c.json({ error: rateLimitError }, 429);
	}

	const effectiveFrom = resolveOutboundFrom(from, fromEmail, settings);

	// Synchronous send BEFORE writing to Folders.SENT (`CF-02`)
	let sendRes: { messageId: string; wireMessageId: string; provider: string };
	try {
		sendRes = await sendOutboundEmail(c.env, {
			to,
			cc,
			bcc,
			from: effectiveFrom,
			subject,
			html,
			text,
			attachments: attachments?.map((att) => ({
				content: att.content,
				filename: att.filename,
				type: att.type,
				disposition: att.disposition,
				contentId: att.contentId,
			})),
			headers: buildOutboundHeaders(outgoingMessageId),
		});
	} catch (e) {
		console.error("Forward email delivery failed:", (e as Error).message);
		return c.json({ error: `Failed to forward email: ${(e as Error).message}` }, 502);
	}

	const wireMessageId = sendRes.wireMessageId || outgoingMessageId;
	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);
	const nowIso = new Date().toISOString();

	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject,
			sender: fromEmail,
			recipient: toStr,
			cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
			bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
			date: nowIso,
			body: html || text || "",
			in_reply_to: null,
			email_references: null,
			thread_id: messageId,
			message_id: wireMessageId,
			raw_headers: JSON.stringify([
				{
					key: "from",
					value:
						typeof effectiveFrom === "string"
							? effectiveFrom
							: `${effectiveFrom.name} <${effectiveFrom.email}>`,
				},
				{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
				...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
				...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
				{ key: "subject", value: subject },
				{ key: "date", value: nowIso },
				{ key: "message-id", value: `<${wireMessageId}>` },
			]),
		},
		attachmentData,
	);

	return c.json(
		{
			id: messageId,
			messageId: wireMessageId,
			provider: sendRes.provider,
			status: "sent",
		},
		200,
	);
}
