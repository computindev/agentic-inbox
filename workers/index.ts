// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { sendEmail } from "./email-sender";
import { storeAttachments, type StoredAttachment } from "./lib/attachments";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildOutboundHeaders,
	listMailboxesWithSettings,
	getMailboxSettings,
	mergeMailboxSettings,
	resolveInboundMailbox,
	isAutomatedOrBounceEmail,
	resolveOutboundFrom,
	deleteEmailWithAttachments,
} from "./lib/email-helpers";
import { SendEmailRequestSchema } from "./lib/schemas";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { Folders } from "../shared/folders";
import type { Env } from "./types";
import { requireMailbox, type MailboxContext } from "./lib/mailbox";

type AppContext = Context<MailboxContext>;

export interface InboundEmailEvent {
	raw: ReadableStream;
	rawSize: number;
	to?: string;
	from?: string;
}

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	settings: z.record(z.unknown()).optional(),
});

const DraftBody = z.object({
	to: z.string().optional(),
	cc: z.string().optional(),
	bcc: z.string().optional(),
	subject: z.string().optional(),
	body: z.string(),
	in_reply_to: z.string().optional(),
	thread_id: z.string().optional(),
	draft_id: z.string().optional(),
});

// -- Helpers --------------------------------------------------------

function slugify(text: string) {
	return text
		.toString()
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^\w-]+/g, "")
		.replace(/--+/g, "-")
		.replace(/^-+/, "")
		.replace(/-+$/, "");
}

function intQuery(c: AppContext, key: string): number | undefined {
	const v = c.req.query(key);
	if (!v) return undefined;
	const n = Number(v);
	return Number.isNaN(n) ? undefined : n;
}

function boolQuery(c: AppContext, key: string): boolean | undefined {
	const v = c.req.query(key);
	if (v === undefined || v === "") return undefined;
	return v === "true" || v === "1";
}

function parseAllowedDomains(raw?: string): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((d) => d.trim().toLowerCase())
		.filter(Boolean);
}

// -- App & middleware -----------------------------------------------

const app = new Hono<MailboxContext>();
app.use(
	"/api/*",
	cors({
		origin: (origin) => {
			// Same-origin requests have no Origin header — allow them.
			if (!origin) return origin;
			// In development, allow localhost for Vite dev server.
			try {
				const url = new URL(origin);
				if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
					return origin;
				}
			} catch {
				/* invalid origin */
			}
			// Block all other cross-origin requests.
			return undefined;
		},
	}),
);
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);

// -- Config ---------------------------------------------------------

app.get("/api/v1/config", (c) => {
	const domains = parseAllowedDomains(c.env.DOMAINS);
	const emailAddresses = c.env.EMAIL_ADDRESSES ?? [];
	return c.json({ domains, emailAddresses });
});

// -- Mailboxes ------------------------------------------------------

app.get("/api/v1/mailboxes", async (c) => {
	const allMailboxes = await listMailboxesWithSettings(c.env.BUCKET);
	return c.json(allMailboxes);
});

app.post("/api/v1/mailboxes", async (c) => {
	const { name, settings, email: rawEmail } = CreateMailboxBody.parse(
		await c.req.json(),
	);
	const email = rawEmail.toLowerCase().trim();
	const emailDomain = email.split("@")[1] || "";

	const configuredDomains = parseAllowedDomains(c.env.DOMAINS);
	if (configuredDomains.length > 0 && !configuredDomains.includes(emailDomain)) {
		return c.json(
			{
				error: `Mailbox domain '${emailDomain}' is not in configured DOMAINS (${configuredDomains.join(", ")})`,
			},
			403,
		);
	}

	const allowedAddresses = ((c.env.EMAIL_ADDRESSES ?? []) as string[]).map((a) =>
		a.toLowerCase().trim(),
	);
	if (allowedAddresses.length > 0 && !allowedAddresses.includes(email)) {
		return c.json(
			{ error: "Mailbox creation is restricted to configured EMAIL_ADDRESSES" },
			403,
		);
	}

	const key = `mailboxes/${email}.json`;
	if (await c.env.BUCKET.head(key)) {
		return c.json({ error: "Mailbox already exists" }, 409);
	}

	const defaultSettings = {
		fromName: name.trim(),
		forwarding: { enabled: false, email: "" },
		signature: { enabled: false, text: "" },
		autoReply: { enabled: false, subject: "", message: "" },
	};
	const finalSettings = mergeMailboxSettings(defaultSettings, settings ?? {});
	await c.env.BUCKET.put(key, JSON.stringify(finalSettings));

	const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(email));
	await stub.getFolders();

	return c.json(
		{
			id: email,
			email,
			name: finalSettings.fromName || name.trim(),
			settings: finalSettings,
		},
		201,
	);
});

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!.toLowerCase().trim();
	const obj = await c.env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return c.json({ error: "Not found" }, 404);
	const settings = (await obj.json()) as Record<string, any>;
	return c.json({
		id: mailboxId,
		name: settings?.fromName?.trim() || mailboxId,
		email: mailboxId,
		settings,
	});
});

app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!.toLowerCase().trim();
	const { settings } = (await c.req.json()) as {
		settings: Record<string, unknown>;
	};
	const key = `mailboxes/${mailboxId}.json`;
	const existingObj = await c.env.BUCKET.get(key);
	if (!existingObj) return c.json({ error: "Not found" }, 404);

	const existing = (await existingObj.json()) as Record<string, any>;
	const merged = mergeMailboxSettings(existing, settings ?? {});
	await c.env.BUCKET.put(key, JSON.stringify(merged));

	return c.json({
		id: mailboxId,
		name: merged.fromName?.trim() || mailboxId,
		email: mailboxId,
		settings: merged,
	});
});

app.delete("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!.toLowerCase().trim();
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.delete(key);
	return c.body(null, 204);
});

// -- Emails ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const folder = c.req.query("folder");
	const thread_id = c.req.query("thread_id");
	const threaded = boolQuery(c, "threaded");
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	const sortColumn = c.req.query("sortColumn") as any;
	const sortDirection = c.req.query("sortDirection") as
		| "ASC"
		| "DESC"
		| undefined;
	const stub = c.var.mailboxStub;

	if (threaded && folder) {
		const emails = await (stub as any).getThreadedEmails({ folder, page, limit });
		const totalCount = await (stub as any).countThreadedEmails(folder);
		return c.json({ emails, totalCount });
	}
	const emails = await stub.getEmails({
		folder,
		thread_id,
		page,
		limit,
		sortColumn,
		sortDirection,
	});
	if (folder) {
		const totalCount = await stub.countEmails({ folder, thread_id });
		return c.json({ emails, totalCount });
	}
	return c.json(emails);
});

app.post("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!.toLowerCase().trim();
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const {
		to,
		cc,
		bcc,
		from,
		subject,
		html,
		text,
		attachments,
		in_reply_to,
		references,
		thread_id,
	} = body;

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
		if (e instanceof SenderValidationError) {
			return c.json({ error: e.message }, 400);
		}
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const stub = c.var.mailboxStub;
	const rateLimitError = await (stub as any).checkSendRateLimit();
	if (rateLimitError) return c.json({ error: rateLimitError }, 429);

	const effectiveFrom = resolveOutboundFrom(from, fromEmail, settings);

	// Await email delivery BEFORE writing to Folders.SENT so failures return 502
	// instead of silently dropping the message in waitUntil while showing it as Sent.
	let sendRes: { messageId: string; wireMessageId: string };
	try {
		sendRes = await sendEmail(c.env.EMAIL, {
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
				disposition: att.disposition || "attachment",
				contentId: att.contentId,
			})),
			headers: buildOutboundHeaders(outgoingMessageId, {
				inReplyTo: in_reply_to,
				references,
			}),
		});
	} catch (e) {
		console.error("Outbound email delivery failed:", (e as Error).message);
		return c.json(
			{ error: `Failed to send email: ${(e as Error).message}` },
			502,
		);
	}

	const wireMessageId = sendRes.wireMessageId || outgoingMessageId;
	const attachmentData = await storeAttachments(
		c.env.BUCKET,
		messageId,
		attachments,
	);
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
			in_reply_to: in_reply_to || null,
			email_references: references ? JSON.stringify(references) : null,
			thread_id: thread_id || in_reply_to || messageId,
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
				...(in_reply_to ? [{ key: "in-reply-to", value: `<${in_reply_to}>` }] : []),
				...(references && references.length > 0
					? [{ key: "references", value: references.map((r) => `<${r}>`).join(" ") }]
					: []),
			]),
		},
		attachmentData,
	);

	return c.json({ id: messageId, messageId: wireMessageId, status: "sent" }, 200);
});

app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!.toLowerCase().trim();
	const { to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id } =
		DraftBody.parse(await c.req.json());
	const stub = c.var.mailboxStub;
	const messageId = crypto.randomUUID();
	const now = new Date().toISOString();

	await stub.createEmail(
		Folders.DRAFT,
		{
			id: messageId,
			subject: subject || "",
			sender: mailboxId,
			recipient: (to || "").toLowerCase(),
			cc: cc?.toLowerCase() || null,
			bcc: bcc?.toLowerCase() || null,
			date: now,
			body,
			in_reply_to: in_reply_to || null,
			email_references: null,
			thread_id: thread_id || in_reply_to || messageId,
		},
		[],
	);

	if (draft_id && draft_id !== messageId) {
		await deleteEmailWithAttachments(stub, c.env.BUCKET, draft_id);
	}

	return c.json(
		{
			id: messageId,
			status: "draft",
			subject: subject || "",
			recipient: to || "",
			date: now,
		},
		201,
	);
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const email = await c.var.mailboxStub.getEmail(c.req.param("id")!);
	if (!email) return c.json({ error: "Email not found" }, 404);
	return new Response(JSON.stringify(email), {
		headers: { "Content-Type": "application/json" },
	});
});

app.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const { read, starred } = (await c.req.json()) as {
		read?: boolean;
		starred?: boolean;
	};
	const email = await c.var.mailboxStub.updateEmail(c.req.param("id")!, {
		read,
		starred,
	});
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const id = c.req.param("id")!;
	const attachments = await deleteEmailWithAttachments(
		c.var.mailboxStub,
		c.env.BUCKET,
		id,
	);
	if (attachments === null) return c.json({ error: "Not found" }, 404);
	return c.body(null, 204);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c: AppContext) => {
	const { folderId } = (await c.req.json()) as { folderId: string };
	const success = await c.var.mailboxStub.moveEmail(
		c.req.param("id")!,
		folderId,
	);
	return success
		? c.json({ status: "moved" })
		: c.json({ error: "Folder not found" }, 400);
});

// -- Threads --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c: AppContext) => {
	return c.json(
		await (c.var.mailboxStub as any).getThreadEmails(
			c.req.param("threadId")!,
		),
	);
});

app.post(
	"/api/v1/mailboxes/:mailboxId/threads/:threadId/read",
	async (c: AppContext) => {
		await c.var.mailboxStub.markThreadRead(c.req.param("threadId")!);
		return c.json({ status: "marked_read" });
	},
);

// -- Reply / Forward ------------------------------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", handleReplyEmail);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", handleForwardEmail);

// -- Folders --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) =>
	c.json(await c.var.mailboxStub.getFolders()),
);

app.post("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const slug = slugify(name);
	if (!slug) {
		return c.json(
			{ error: "Folder name must contain alphanumeric characters" },
			400,
		);
	}
	const f = await c.var.mailboxStub.createFolder(slug, name);
	return f
		? c.json(f, 201)
		: c.json({ error: "Folder with this name already exists" }, 409);
});

app.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const f = await c.var.mailboxStub.updateFolder(c.req.param("id")!, name);
	return f ? c.json(f) : c.json({ error: "Folder not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const ok = await c.var.mailboxStub.deleteFolder(c.req.param("id")!);
	return ok
		? c.body(null, 204)
		: c.json({ error: "Folder not found or cannot be deleted" }, 400);
});

// -- Search ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/search", async (c: AppContext) => {
	const searchOpts: Record<string, unknown> = {
		query: c.req.query("query") || "",
		folder: c.req.query("folder"),
		from: c.req.query("from"),
		to: c.req.query("to"),
		subject: c.req.query("subject"),
		date_start: c.req.query("date_start"),
		date_end: c.req.query("date_end"),
		is_read: boolQuery(c, "is_read"),
		is_starred: boolQuery(c, "is_starred"),
		has_attachment: boolQuery(c, "has_attachment"),
	};
	const stub = c.var.mailboxStub as any;
	const emails = await stub.searchEmails({
		...searchOpts,
		page: intQuery(c, "page"),
		limit: intQuery(c, "limit"),
	});
	const totalCount = await stub.countSearchResults(searchOpts);
	return c.json({ emails, totalCount });
});

// -- Attachments ----------------------------------------------------

app.get(
	"/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId",
	async (c: AppContext) => {
		const emailId = c.req.param("emailId")!;
		const attachmentId = c.req.param("attachmentId")!;
		const attachment = await c.var.mailboxStub.getAttachment(attachmentId);
		if (!attachment) return c.json({ error: "Attachment not found" }, 404);
		const obj = await c.env.BUCKET.get(
			`attachments/${emailId}/${attachmentId}/${attachment.filename}`,
		);
		if (!obj) return c.json({ error: "Attachment file not found" }, 404);
		const headers = new Headers();
		headers.set("Content-Type", attachment.mimetype);
		const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
		headers.set(
			"Content-Disposition",
			`attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
		);
		return new Response(obj.body, { headers });
	},
);

// -- Receive inbound email ------------------------------------------

const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

async function streamToArrayBuffer(
	stream: ReadableStream,
	streamSize: number,
) {
	if (streamSize > MAX_EMAIL_SIZE) {
		throw new Error(
			`Email too large: ${streamSize} bytes exceeds ${MAX_EMAIL_SIZE} byte limit`,
		);
	}
	if (streamSize <= 0) throw new Error(`Invalid stream size: ${streamSize}`);
	const result = new Uint8Array(streamSize);
	let bytesRead = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (bytesRead + value.length > streamSize) {
			reader.cancel();
			throw new Error("Stream exceeds declared size");
		}
		result.set(value, bytesRead);
		bytesRead += value.length;
	}
	return result;
}

async function receiveEmail(
	event: InboundEmailEvent,
	env: Env,
	ctx: ExecutionContext,
) {
	const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
	const parsedEmail = await new PostalMime().parse(rawEmail);

	const toRecipients = (parsedEmail.to || [])
		.map((t) => t.address?.toLowerCase().trim())
		.filter(Boolean) as string[];
	const ccRecipients = (parsedEmail.cc || [])
		.map((e) => e.address?.toLowerCase().trim())
		.filter(Boolean) as string[];
	const bccRecipients = (parsedEmail.bcc || [])
		.map((e) => e.address?.toLowerCase().trim())
		.filter(Boolean) as string[];

	const headerRecipients = [
		...toRecipients,
		...ccRecipients,
		...bccRecipients,
	];

	if (!event.to && headerRecipients.length === 0) {
		throw new Error("received email with no envelope or header recipients");
	}

	const allowedAddresses = ((env.EMAIL_ADDRESSES ?? []) as string[]).map((a) =>
		a.toLowerCase().trim(),
	);

	// Resolve mailbox using SMTP envelope `event.to` first, falling back to
	// matching any To/CC/BCC header recipient against existing R2 mailboxes.
	const resolved = await resolveInboundMailbox(env.BUCKET, {
		envelopeTo: event.to ?? null,
		headerRecipients,
		allowedAddresses,
	});

	if (!resolved) {
		console.log(
			`Ignoring inbound email (envelopeTo=${event.to ?? "none"}, to=${toRecipients.join(",")}): no matching mailbox found`,
		);
		return;
	}

	const { mailboxId, settings: mailboxSettings, matchedAddress } = resolved;
	const messageId = crypto.randomUUID();
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));

	const attachmentData: StoredAttachment[] = [];
	if (parsedEmail.attachments) {
		for (const att of parsedEmail.attachments) {
			const attId = crypto.randomUUID();
			const filename = (att.filename || "untitled").replace(
				/[\/\\:*?"<>|\x00-\x1f]/g,
				"_",
			);
			await env.BUCKET.put(
				`attachments/${messageId}/${attId}/${filename}`,
				att.content,
			);
			attachmentData.push({
				id: attId,
				email_id: messageId,
				filename,
				mimetype: att.mimeType,
				size:
					typeof att.content === "string"
						? att.content.length
						: att.content.byteLength,
				content_id: att.contentId || null,
				disposition: att.disposition || "attachment",
			});
		}
	}

	const extractMsgId = (s: string) => {
		const m = s.match(/<([^>]+)>/);
		return m ? m[1] : s.trim().split(/\s+/)[0];
	};
	const inReplyTo = parsedEmail.inReplyTo
		? extractMsgId(parsedEmail.inReplyTo)
		: null;
	const emailReferences = parsedEmail.references
		? parsedEmail.references.split(/\s+/).filter(Boolean).map(extractMsgId)
		: [];
	let threadId = emailReferences[0] || inReplyTo || messageId;

	if (!inReplyTo && emailReferences.length === 0) {
		const subjectThread = await (stub as any).findThreadBySubject(
			parsedEmail.subject || "",
			parsedEmail.from?.address || undefined,
		);
		if (subjectThread) threadId = subjectThread;
	}

	const originalMessageId = parsedEmail.messageId
		? extractMsgId(parsedEmail.messageId)
		: null;
	const senderEmail = (
		parsedEmail.from?.address ||
		event.from ||
		""
	).toLowerCase();
	const storedRecipient =
		toRecipients.length > 0 ? toRecipients.join(", ") : matchedAddress;

	await stub.createEmail(
		Folders.INBOX,
		{
			id: messageId,
			subject: parsedEmail.subject || "",
			sender: senderEmail,
			recipient: storedRecipient,
			cc: ccRecipients.join(", ") || null,
			bcc: bccRecipients.join(", ") || null,
			date: new Date().toISOString(),
			body: parsedEmail.html || parsedEmail.text || "",
			in_reply_to: inReplyTo,
			email_references:
				emailReferences.length > 0
					? JSON.stringify(emailReferences)
					: null,
			thread_id: threadId,
			message_id: originalMessageId,
			raw_headers: JSON.stringify(parsedEmail.headers),
		},
		attachmentData,
	);

	// Honor mailbox forwarding setting (`settings.forwarding`) with loop protection
	const forwardTarget = mailboxSettings.forwarding?.email?.toLowerCase().trim();
	const alreadyForwarded = (parsedEmail.headers || []).some(
		(h) => h.key?.toLowerCase() === "x-agentic-forwarded-from",
	);
	if (
		mailboxSettings.forwarding?.enabled &&
		forwardTarget &&
		forwardTarget !== mailboxId &&
		!alreadyForwarded &&
		env.EMAIL
	) {
		ctx.waitUntil(
			sendEmail(env.EMAIL, {
				to: forwardTarget,
				from: resolveOutboundFrom(mailboxId, mailboxId, mailboxSettings),
				replyTo: senderEmail || undefined,
				subject: parsedEmail.subject || "(no subject)",
				html: parsedEmail.html || undefined,
				text: parsedEmail.text || "",
				headers: {
					"X-Agentic-Forwarded-From": mailboxId,
					"Auto-Submitted": "auto-forwarded",
				},
			}).catch((err) => {
				console.error(
					`Forwarding from ${mailboxId} to ${forwardTarget} failed:`,
					(err as Error).message,
				);
			}),
		);
	}

	// Skip auto-drafting replies to automated messages, bounces, and self-loops
	const autoCheck = isAutomatedOrBounceEmail({
		sender: senderEmail,
		envelopeFrom: event.from ?? null,
		headers: parsedEmail.headers as Array<{ key: string; value: string }>,
		selfAddresses: [mailboxId, ...(mailboxSettings.aliases ?? [])],
	});
	if (autoCheck.automated) {
		console.log(
			`Skipping auto-draft for ${messageId} (${senderEmail}): ${autoCheck.reason}`,
		);
		return;
	}

	const agentStub = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxId));
	ctx.waitUntil(
		agentStub
			.fetch(
				new Request("https://agents/onNewEmail", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						mailboxId,
						emailId: messageId,
						sender: senderEmail,
						subject: parsedEmail.subject || "",
						threadId,
					}),
				}),
			)
			.catch((e) =>
				console.error("Auto-draft trigger failed:", (e as Error).message),
			),
	);
}

export { app, receiveEmail };
