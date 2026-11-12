// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared tool business logic for the EmailAgent and MCP server (`CF-02`, `CF-07`, `CF-12`, `TOP 6`).
 */

import type { EmailFull } from "./schemas";
import {
	getMailboxStub,
	getMailboxSettings,
	getFullEmail,
	getFullThread,
	buildQuotedReplyBlock,
	textToHtml,
	listMailboxesWithSettings,
	generateMessageId,
	buildReferencesChain,
	buildOutboundHeaders,
	resolveOutboundFrom,
	appendSignature,
	deleteEmailWithAttachments,
} from "./email-helpers";
import {
	verifyDraft,
	verifyDraftDeterministically,
	checkPersonaGovernance,
} from "./ai";
import { fetchClientDossier } from "./cobrador-bridge";
import { sendOutboundEmail } from "../email-sender";
import { Folders } from "../../shared/folders";
import { parseSearchQuery, type ParsedSearch } from "../../shared/search-parser";
import type { Env } from "../types";

type MailboxSearchStub = {
	searchEmails: (options: ParsedSearch & { page?: number; limit?: number }) => Promise<unknown>;
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

// ── search_emails (with Gmail-style operator parser — CF-07) ───────

export async function toolSearchEmails(
	env: Env,
	mailboxId: string,
	params: { query: string; folder?: string },
) {
	const stub = getMailboxStub(env, mailboxId);
	const parsed = parseSearchQuery(params.query || "");
	return (stub as unknown as MailboxSearchStub).searchEmails({
		...parsed,
		folder: params.folder || parsed.folder,
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
			verificationCode?: string;
			verificationWarnings?: string[];
			draft: Record<string, string>;
	  }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);
	const settings = await getMailboxSettings(env.BUCKET, mailboxId);

	let processedBody = params.body.trim();
	if (params.runVerifyDraft) {
		const sanitized = await verifyDraft(env.AI, processedBody);
		processedBody = sanitized || processedBody;
	}

	if (params.isPlainText) {
		const withSigText = appendSignature(processedBody, settings.signature, false);
		processedBody = textToHtml(withSigText);
	} else {
		processedBody = appendSignature(processedBody, settings.signature, true);
	}

	// Deterministic financial & link check against live Dossier (`TOP 6`)
	const dossier = params.to ? await fetchClientDossier(env, params.to) : null;
	const detCheck = verifyDraftDeterministically(processedBody, { dossier });

	const draftId = crypto.randomUUID();
	const original = (await stub.getEmail(params.originalEmailId)) as EmailFull | null;
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

	const warnings = detCheck.mismatches.map((m) => m.reason);

	return {
		status: "draft_saved",
		draftId,
		verificationCode: detCheck.code,
		...(warnings.length > 0 ? { verificationWarnings: warnings } : {}),
		message:
			warnings.length > 0
				? `Draft saved with ${warnings.length} financial verification warning(s): ${warnings.join(" | ")}`
				: "Draft saved to Drafts folder. Review it and confirm to send.",
		draft: {
			id: draftId,
			originalEmailId: params.originalEmailId,
			in_reply_to: params.originalEmailId,
			to: params.to,
			subject: params.subject,
			body: params.isPlainText
				? appendSignature(params.body.trim(), settings.signature, false)
				: bodyHtml,
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
			verificationCode?: string;
			verificationWarnings?: string[];
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
		processedBody = sanitized || processedBody;
	}

	if (params.isPlainText) {
		const withSigText = appendSignature(processedBody, settings.signature, false);
		processedBody = textToHtml(withSigText);
	} else {
		processedBody = appendSignature(processedBody, settings.signature, true);
	}

	const dossier = params.to ? await fetchClientDossier(env, params.to) : null;
	const detCheck = verifyDraftDeterministically(processedBody, { dossier });

	const draftId = crypto.randomUUID();

	let resolvedThreadId = params.thread_id;
	if (!resolvedThreadId && params.in_reply_to) {
		const original = (await stub.getEmail(params.in_reply_to)) as EmailFull | null;
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

	const warnings = detCheck.mismatches.map((m) => m.reason);

	return {
		status: "draft_saved",
		draftId,
		threadId: resolvedThreadId,
		verificationCode: detCheck.code,
		...(warnings.length > 0 ? { verificationWarnings: warnings } : {}),
		message:
			warnings.length > 0
				? `Draft saved with ${warnings.length} financial verification warning(s): ${warnings.join(" | ")}`
				: "Draft saved to Drafts folder. Review it and confirm to send.",
		draft: {
			id: draftId,
			...(params.in_reply_to
				? { originalEmailId: params.in_reply_to, in_reply_to: params.in_reply_to }
				: {}),
			to: params.to,
			subject: params.subject,
			body: params.isPlainText
				? appendSignature(params.body.trim(), settings.signature, false)
				: processedBody,
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
	const verifiedBody = (await verifyDraft(env.AI, rawBody)) || rawBody;

	await deleteEmailWithAttachments(stub, env.BUCKET, params.draftId);
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

// ── discard_draft (with R2 blob cleanup — CF-12) ───────────────────

export async function toolDiscardDraft(
	env: Env,
	mailboxId: string,
	draftId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const email = (await stub.getEmail(draftId)) as { folder_id?: string } | null;
	if (!email) {
		return { error: "Draft not found" };
	}
	if (email.folder_id !== Folders.DRAFT) {
		return { error: "Cannot discard: email is not a draft" };
	}
	await deleteEmailWithAttachments(stub, env.BUCKET, draftId);
	return { status: "discarded", draftId };
}

// ── delete_email (with R2 blob cleanup — CF-12) ────────────────────

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

// ── send_reply (with fromName, signature, Message-ID & Governance) ─

export async function toolSendReply(
	env: Env,
	mailboxId: string,
	params: {
		originalEmailId: string;
		to: string;
		subject: string;
		bodyHtml: string;
		confirmedByHuman?: boolean;
	},
): Promise<
	| { status: "sent"; messageId: string; provider: string; message: string }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);
	const settings = await getMailboxSettings(env.BUCKET, mailboxId);

	// Persona Governance (`Pablo` vs `Antonio` — TOP 6)
	const governance = checkPersonaGovernance({
		mailboxId,
		settings,
		body: params.bodyHtml,
		confirmedByHuman: params.confirmedByHuman,
	});
	if (!governance.allowed) {
		return { error: governance.error! };
	}

	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit();
	if (rateLimitError) {
		return { error: rateLimitError };
	}

	const originalEmail = (await stub.getEmail(params.originalEmailId)) as EmailFull | null;
	if (!originalEmail) {
		return { error: "Original email not found" };
	}

	const { originalMsgId, references, threadId } = buildReferencesChain(originalEmail);
	const fromDomain = mailboxId.split("@")[1];
	if (!fromDomain) throw new Error("Invalid mailbox email address");
	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const sanitizedBody = (await verifyDraft(env.AI, params.bodyHtml)) || params.bodyHtml;
	const signedBody = appendSignature(sanitizedBody, settings.signature, true);

	// Deterministic anti-hallucination check before sending (`TOP 6`)
	if (!params.confirmedByHuman) {
		const dossier = await fetchClientDossier(env, params.to);
		const detCheck = verifyDraftDeterministically(signedBody, { dossier });
		if (!detCheck.ok) {
			return {
				error: `REJECTED_NUMBER_MISMATCH: El correo contiene datos financieros o enlaces que no coinciden con el dossier oficial: ${detCheck.mismatches.map((m) => m.reason).join(" | ")}`,
			};
		}
	}

	const quotedBlock = buildQuotedReplyBlock({
		date: originalEmail.date,
		sender: originalEmail.sender || params.to,
		body: originalEmail.body ?? undefined,
	});
	const fullBodyHtml = signedBody + quotedBlock;
	const fromField = resolveOutboundFrom(mailboxId, mailboxId, settings);

	let wireMessageId = outgoingMessageId;
	let provider = "cf_email";
	try {
		const sendRes = await sendOutboundEmail(env, {
			to: params.to,
			from: fromField,
			subject: params.subject,
			html: fullBodyHtml,
			headers: buildOutboundHeaders(outgoingMessageId, {
				inReplyTo: originalMsgId,
				references,
			}),
		});
		wireMessageId = sendRes.wireMessageId || outgoingMessageId;
		provider = sendRes.provider;
	} catch (e) {
		console.error("Email send failed:", (e as Error).message);
		return { error: `Failed to send reply: ${(e as Error).message}` };
	}

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

	return {
		status: "sent",
		messageId,
		provider,
		message: `Reply sent to ${params.to} via ${provider}`,
	};
}

// ── send_email (with fromName, signature, Message-ID & Governance) ─

export async function toolSendEmail(
	env: Env,
	mailboxId: string,
	params: {
		to: string;
		subject: string;
		bodyHtml: string;
		confirmedByHuman?: boolean;
	},
): Promise<
	| { status: "sent"; messageId: string; provider: string; message: string }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);
	const settings = await getMailboxSettings(env.BUCKET, mailboxId);

	// Persona Governance (`Pablo` vs `Antonio` — TOP 6)
	const governance = checkPersonaGovernance({
		mailboxId,
		settings,
		body: params.bodyHtml,
		confirmedByHuman: params.confirmedByHuman,
	});
	if (!governance.allowed) {
		return { error: governance.error! };
	}

	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit();
	if (rateLimitError) {
		return { error: rateLimitError };
	}

	const fromDomain = mailboxId.split("@")[1];
	if (!fromDomain) throw new Error("Invalid mailbox email address");
	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const sanitizedBody = (await verifyDraft(env.AI, params.bodyHtml)) || params.bodyHtml;
	const signedBody = appendSignature(sanitizedBody, settings.signature, true);

	if (!params.confirmedByHuman) {
		const dossier = await fetchClientDossier(env, params.to);
		const detCheck = verifyDraftDeterministically(signedBody, { dossier });
		if (!detCheck.ok) {
			return {
				error: `REJECTED_NUMBER_MISMATCH: El correo contiene datos financieros o enlaces que no coinciden con el dossier oficial: ${detCheck.mismatches.map((m) => m.reason).join(" | ")}`,
			};
		}
	}

	const fromField = resolveOutboundFrom(mailboxId, mailboxId, settings);

	let wireMessageId = outgoingMessageId;
	let provider = "cf_email";
	try {
		const sendRes = await sendOutboundEmail(env, {
			to: params.to,
			from: fromField,
			subject: params.subject,
			html: signedBody,
			headers: buildOutboundHeaders(outgoingMessageId),
		});
		wireMessageId = sendRes.wireMessageId || outgoingMessageId;
		provider = sendRes.provider;
	} catch (e) {
		console.error("Email send failed:", (e as Error).message);
		return { error: `Failed to send email: ${(e as Error).message}` };
	}

	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: new Date().toISOString(),
			body: signedBody,
			in_reply_to: null,
			email_references: null,
			thread_id: messageId,
			message_id: wireMessageId,
		},
		[],
	);

	return {
		status: "sent",
		messageId,
		provider,
		message: `Email sent to ${params.to} via ${provider}`,
	};
}
