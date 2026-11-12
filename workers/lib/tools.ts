// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared tool business logic for the Agent and MCP server.
 *
 * Each function takes an `env: Env` (or a DO stub) and tool-specific params,
 * performs the business logic (DO calls, data fetching, formatting), and
 * returns a plain object. The Agent and MCP server wrap these results in
 * their own response formats.
 */

import type { EmailFull } from "./schemas";
import {
	getMailboxStub,
	getFullEmail,
	getFullThread,
	buildQuotedReplyBlock,
	textToHtml,
	listMailboxesWithSettings,
	generateMessageId,
	buildReferencesChain,
	buildOutboundHeaders,
	getMailboxSettings,
	resolveOutboundFrom,
	appendSignature,
	deleteEmailWithAttachments,
} from "./email-helpers";
import { verifyDraft } from "./ai";
import { sendEmail } from "../email-sender";
import { Folders } from "../../shared/folders";
import { parseSearchQuery } from "../../shared/search-parser";
import type { Env } from "../types";

// ── Type casts for DO methods not on the base stub type ────────────
type MailboxSearchStub = {
	searchEmails: (options: {
		query: string;
		folder?: string;
		from?: string;
		to?: string;
		subject?: string;
		is_read?: boolean;
		is_starred?: boolean;
		has_attachment?: boolean;
		date_start?: string;
		date_end?: string;
	}) => Promise<unknown>;
};

type RateLimitStub = {
	checkSendRateLimit: () => Promise<string | null>;
};

// ── list_mailboxes ─────────────────────────────────────────────────

export async function toolListMailboxes(env: Env) {
	return listMailboxesWithSettings(env.BUCKET);
}

// ── list_emails ────────────────────────────────────────────────────

export async function toolListEmails(
	env: Env,
	mailboxId: string,
	params: { folder: string; limit: number; page: number },
) {
	const stub = getMailboxStub(env, mailboxId);
	return stub.getEmails({
		folder: params.folder,
		limit: params.limit,
		page: params.page,
		sortColumn: "date",
		sortDirection: "DESC",
	});
}

// ── get_email ──────────────────────────────────────────────────────

export async function toolGetEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const email = await getFullEmail(stub, emailId);
	if (!email) return { error: "Email not found" };
	return email;
}

// ── get_thread ─────────────────────────────────────────────────────

export async function toolGetThread(
	env: Env,
	mailboxId: string,
	threadId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	return getFullThread(stub, threadId);
}

// ── search_emails ──────────────────────────────────────────────────

export async function toolSearchEmails(
	env: Env,
	mailboxId: string,
	params: { query: string; folder?: string },
) {
	const stub = getMailboxStub(env, mailboxId);
	const parsed = parseSearchQuery(params.query);
	return (stub as unknown as MailboxSearchStub).searchEmails({
		query: parsed.query,
		folder: params.folder ?? parsed.folder,
		from: parsed.from,
		to: parsed.to,
		subject: parsed.subject,
		is_read: parsed.is_read,
		is_starred: parsed.is_starred,
		has_attachment: parsed.has_attachment,
		date_start: parsed.date_start,
		date_end: parsed.date_end,
	});
}

// ── draft_reply ────────────────────────────────────────────────────

export async function toolDraftReply(
	env: Env,
	mailboxId: string,
	params: {
		originalEmailId: string;
		to: string;
		subject: string;
		body: string;
		isPlainText?: boolean;
		runVerifyDraft?: boolean;
	},
): Promise<
	| {
			status: "draft_saved";
			draftId: string;
			message: string;
			draft: Record<string, string>;
	  }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);
	const settings = await getMailboxSettings(env.BUCKET, mailboxId);

	let processedBody = params.body.trim();
	if (params.runVerifyDraft) {
		const sanitized = await verifyDraft(env.AI, processedBody);
		if (!sanitized) {
			return {
				error:
					"Draft verification failed — body could not be verified. Please try again.",
			};
		}
		processedBody = sanitized;
	}

	if (params.isPlainText) {
		processedBody = textToHtml(processedBody);
	}

	processedBody = appendSignature(processedBody, settings.signature, true);

	const draftId = crypto.randomUUID();
	const original = (await stub.getEmail(
		params.originalEmailId,
	)) as EmailFull | null;
	const threadId = original?.thread_id || params.originalEmailId;

	const quotedBlock = original
		? buildQuotedReplyBlock({
				date: original.date,
				sender: original.sender || params.to,
				body: original.body ?? undefined,
			})
		: "";
	const bodyHtml = processedBody + quotedBlock;

	await stub.createEmail(
		Folders.DRAFT,
		{
			id: draftId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: new Date().toISOString(),
			body: bodyHtml,
			in_reply_to: params.originalEmailId,
			email_references: null,
			thread_id: threadId,
		},
		[],
	);

	return {
		status: "draft_saved",
		draftId,
		message: "Draft saved to Drafts folder. Review it and confirm to send.",
		draft: {
			originalEmailId: params.originalEmailId,
			to: params.to,
			subject: params.subject,
			body: bodyHtml,
		},
	};
}

// ── draft_email (new email, not a reply) ───────────────────────────

export async function toolDraftEmail(
	env: Env,
	mailboxId: string,
	params: {
		to: string;
		subject: string;
		body: string;
		isPlainText?: boolean;
		runVerifyDraft?: boolean;
		in_reply_to?: string;
		thread_id?: string;
	},
): Promise<
	| {
			status: string;
			draftId: string;
			threadId?: string;
			message: string;
			draft?: Record<string, string>;
	  }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);
	const settings = await getMailboxSettings(env.BUCKET, mailboxId);

	let processedBody = params.body.trim();
	if (params.runVerifyDraft) {
		const sanitized = await verifyDraft(env.AI, processedBody);
		if (!sanitized) {
			return {
				error:
					"Draft verification failed — body could not be verified. Please try again.",
			};
		}
		processedBody = sanitized;
	}

	if (params.isPlainText) {
		processedBody = textToHtml(processedBody);
	}

	processedBody = appendSignature(processedBody, settings.signature, true);

	const draftId = crypto.randomUUID();

	let resolvedThreadId = params.thread_id;
	if (!resolvedThreadId && params.in_reply_to) {
		const original = (await stub.getEmail(
			params.in_reply_to,
		)) as EmailFull | null;
		resolvedThreadId = original?.thread_id || params.in_reply_to;
	}
	if (!resolvedThreadId) {
		resolvedThreadId = draftId;
	}

	await stub.createEmail(
		Folders.DRAFT,
		{
			id: draftId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: (params.to || "").toLowerCase(),
			date: new Date().toISOString(),
			body: processedBody,
			in_reply_to: params.in_reply_to || null,
			email_references: null,
			thread_id: resolvedThreadId,
		},
		[],
	);

	return {
		status: "draft_saved",
		draftId,
		threadId: resolvedThreadId,
		message: "Draft saved to Drafts folder. Review it and confirm to send.",
		draft: {
			to: params.to,
			subject: params.subject,
			body: processedBody,
		},
	};
}

// ── update_draft ───────────────────────────────────────────────────

export async function toolUpdateDraft(
	env: Env,
	mailboxId: string,
	params: {
		draftId: string;
		to?: string;
		subject?: string;
		bodyHtml?: string;
	},
): Promise<
	| { status: string; newDraftId: string; oldDraftId: string; message: string }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	const oldDraft = (await stub.getEmail(params.draftId)) as EmailFull | null;
	if (!oldDraft) {
		return { error: "Draft not found" };
	}

	const newDraftId = crypto.randomUUID();
	const rawBody = params.bodyHtml ?? oldDraft.body ?? "";
	const verifiedBody = await verifyDraft(env.AI, rawBody);

	if (!verifiedBody) {
		return {
			error:
				"Draft verification failed — keeping existing draft unchanged. Please try again.",
		};
	}

	await stub.createEmail(
		Folders.DRAFT,
		{
			id: newDraftId,
			subject: params.subject ?? oldDraft.subject,
			sender: mailboxId.toLowerCase(),
			recipient: (params.to ?? oldDraft.recipient).toLowerCase(),
			date: new Date().toISOString(),
			body: verifiedBody,
			in_reply_to: oldDraft.in_reply_to || null,
			email_references: oldDraft.email_references || null,
			thread_id: oldDraft.thread_id || newDraftId,
		},
		[],
	);

	await deleteEmailWithAttachments(stub, env.BUCKET, params.draftId);

	return {
		status: "draft_updated",
		newDraftId,
		oldDraftId: params.draftId,
		message: "Draft updated in Drafts folder.",
	};
}

// ── mark_email_read ────────────────────────────────────────────────

export async function toolMarkEmailRead(
	env: Env,
	mailboxId: string,
	emailId: string,
	read: boolean,
) {
	const stub = getMailboxStub(env, mailboxId);
	await stub.updateEmail(emailId, { read });
	return { status: "updated", emailId, read };
}

// ── move_email ─────────────────────────────────────────────────────

export async function toolMoveEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
	folderId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const success = await stub.moveEmail(emailId, folderId);
	if (success) {
		return { status: "moved", emailId, folder: folderId };
	}
	return { error: "Failed to move email" };
}

// ── discard_draft ──────────────────────────────────────────────────

export async function toolDiscardDraft(
	env: Env,
	mailboxId: string,
	draftId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const email = (await stub.getEmail(draftId)) as {
		folder_id?: string;
	} | null;
	if (!email) {
		return { error: "Draft not found" };
	}
	if (email.folder_id !== Folders.DRAFT) {
		return { error: "Cannot discard: email is not a draft" };
	}
	await deleteEmailWithAttachments(stub, env.BUCKET, draftId);
	return { status: "discarded", draftId };
}

// ── delete_email ───────────────────────────────────────────────────

export async function toolDeleteEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const result = await deleteEmailWithAttachments(stub, env.BUCKET, emailId);
	if (result === null) {
		return { error: "Email not found", emailId };
	}
	return { status: "deleted", emailId };
}

// ── send_reply ─────────────────────────────────────────────────────

export async function toolSendReply(
	env: Env,
	mailboxId: string,
	params: {
		originalEmailId: string;
		to: string;
		subject: string;
		bodyHtml: string;
	},
): Promise<
	| { status: "sent"; messageId: string; message: string }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	const rateLimitError = await (
		stub as unknown as RateLimitStub
	).checkSendRateLimit();
	if (rateLimitError) {
		return { error: rateLimitError };
	}

	const originalEmail = (await stub.getEmail(
		params.originalEmailId,
	)) as EmailFull | null;
	if (!originalEmail) {
		return { error: "Original email not found" };
	}

	const settings = await getMailboxSettings(env.BUCKET, mailboxId);
	const { originalMsgId, references, threadId } =
		buildReferencesChain(originalEmail);
	const fromDomain = mailboxId.split("@")[1];
	if (!fromDomain) throw new Error("Invalid mailbox email address");
	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const sanitizedBody = await verifyDraft(env.AI, params.bodyHtml);
	if (!sanitizedBody) {
		return {
			error:
				"Draft verification failed — refusing to send unverified content. Please try again.",
		};
	}

	const bodyWithSig = appendSignature(sanitizedBody, settings.signature, true);
	const quotedBlock = buildQuotedReplyBlock({
		date: originalEmail.date,
		sender: originalEmail.sender || params.to,
		body: originalEmail.body ?? undefined,
	});
	const fullBodyHtml = bodyWithSig + quotedBlock;
	const effectiveFrom = resolveOutboundFrom(mailboxId, mailboxId, settings);

	let sendRes: { messageId: string; wireMessageId: string };
	try {
		sendRes = await sendEmail(env.EMAIL, {
			to: params.to,
			from: effectiveFrom,
			subject: params.subject,
			html: fullBodyHtml,
			headers: buildOutboundHeaders(outgoingMessageId, {
				inReplyTo: originalMsgId,
				references,
			}),
		});
	} catch (e) {
		console.error("Email send failed:", (e as Error).message);
		return { error: `Failed to send reply: ${(e as Error).message}` };
	}

	const wireMessageId = sendRes.wireMessageId || outgoingMessageId;

	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: new Date().toISOString(),
			body: fullBodyHtml,
			in_reply_to: originalMsgId,
			email_references:
				references.length > 0 ? JSON.stringify(references) : null,
			thread_id: threadId,
			message_id: wireMessageId,
		},
		[],
	);

	return { status: "sent", messageId, message: `Reply sent to ${params.to}` };
}

// ── send_email ─────────────────────────────────────────────────────

export async function toolSendEmail(
	env: Env,
	mailboxId: string,
	params: {
		to: string;
		subject: string;
		bodyHtml: string;
	},
): Promise<
	| { status: "sent"; messageId: string; message: string }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	const rateLimitError = await (
		stub as unknown as RateLimitStub
	).checkSendRateLimit();
	if (rateLimitError) {
		return { error: rateLimitError };
	}

	const settings = await getMailboxSettings(env.BUCKET, mailboxId);
	const fromDomain = mailboxId.split("@")[1];
	if (!fromDomain) throw new Error("Invalid mailbox email address");
	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const sanitizedBody = await verifyDraft(env.AI, params.bodyHtml);
	if (!sanitizedBody) {
		return {
			error:
				"Draft verification failed — refusing to send unverified content. Please try again.",
		};
	}

	const finalHtml = appendSignature(sanitizedBody, settings.signature, true);
	const effectiveFrom = resolveOutboundFrom(mailboxId, mailboxId, settings);

	let sendRes: { messageId: string; wireMessageId: string };
	try {
		sendRes = await sendEmail(env.EMAIL, {
			to: params.to,
			from: effectiveFrom,
			subject: params.subject,
			html: finalHtml,
			headers: buildOutboundHeaders(outgoingMessageId),
		});
	} catch (e) {
		console.error("Email send failed:", (e as Error).message);
		return { error: `Failed to send email: ${(e as Error).message}` };
	}

	const wireMessageId = sendRes.wireMessageId || outgoingMessageId;

	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: new Date().toISOString(),
			body: finalHtml,
			in_reply_to: null,
			email_references: null,
			thread_id: messageId,
			message_id: wireMessageId,
		},
		[],
	);

	return { status: "sent", messageId, message: `Email sent to ${params.to}` };
}
