// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { getAgentByName } from "agents";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { sendOutboundEmail } from "./email-sender";
import { checkPersonaGovernance } from "./lib/ai";
import { storeAttachments, type StoredAttachment } from "./lib/attachments";
import {
	PABLO_DEFAULT_SYSTEM_PROMPT,
	extractEmailAddress,
	fetchClientDossier,
	notifyPaymentClaim,
	parseBancoChileTransferAlert,
} from "./lib/cobrador-bridge";
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
	stripHtmlToText,
	textToHtml,
	escapeHtml,
	getMailboxStub,
} from "./lib/email-helpers";
import { getPlatformConfig, updatePlatformConfig } from "./lib/platform-config";
import { SendEmailRequestSchema } from "./lib/schemas";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { Folders } from "../shared/folders";
import type { Env, MailboxSettingsRecord } from "./types";
import { requireMailbox, type MailboxContext } from "./lib/mailbox";

type AppContext = Context<MailboxContext>;

// -- Request body schemas -------------------------------------------

const CreateMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	settings: z.record(z.any()).optional(),
});

const UpdatePlatformConfigBody = z.object({
	domains: z.array(z.string()).optional(),
	outboundProvider: z.enum(["cf_email", "aws_ses"]).optional(),
	sesRegion: z.string().optional(),
	defaultFromDomain: z.string().optional(),
	cobradorUrl: z.string().optional(),
	aliases: z.record(z.string()).optional(),
});

const TestEmailBody = z.object({
	from: z.string().optional(),
	mailboxId: z.string().optional(),
	fromMailbox: z.string().optional(),
	to: z.string().email().optional(),
	toEmail: z.string().email().optional(),
	subject: z.string().optional(),
	provider: z.enum(["cf_email", "aws_ses"]).optional(),
	outboundProvider: z.enum(["cf_email", "aws_ses"]).optional(),
});

const MigrateMailboxBody = z.object({
	newEmail: z.string().email(),
	keepOldAsAlias: z.boolean().optional().default(true),
});

const ClaimPaymentBody = z.object({
	email: z.string().optional(),
	clientId: z.string().optional(),
	cycleId: z.string().optional(),
	amountClp: z.coerce.number().optional(),
	rut: z.string().optional(),
	glosa: z.string().optional(),
	source: z.string().optional(),
	note: z.string().optional(),
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

// -- App & middleware -----------------------------------------------

const app = new Hono<MailboxContext>();
app.use(
	"/api/*",
	cors({
		origin: (origin) => {
			if (!origin) return origin;
			try {
				const url = new URL(origin);
				if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
					return origin;
				}
			} catch {
				/* invalid origin */
			}
			return undefined;
		},
	}),
);
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);

// -- Platform Config & Outbound Test --------------------------------

app.get("/api/v1/config", async (c) => {
	const config = await getPlatformConfig(c.env);
	return c.json({
		...config,
		defaultPabloPrompt: PABLO_DEFAULT_SYSTEM_PROMPT,
	});
});

app.put("/api/v1/config", async (c) => {
	const patch = UpdatePlatformConfigBody.parse(await c.req.json());
	const updated = await updatePlatformConfig(c.env, patch);
	return c.json({
		...updated,
		defaultPabloPrompt: PABLO_DEFAULT_SYSTEM_PROMPT,
	});
});

app.post("/api/v1/config/test-email", async (c) => {
	let parsed: z.infer<typeof TestEmailBody>;
	try {
		parsed = TestEmailBody.parse(await c.req.json());
	} catch (e) {
		return c.json({ ok: false, error: (e as Error).message });
	}

	const config = await getPlatformConfig(c.env);
	const toEmail = (parsed.to || parsed.toEmail || "").trim().toLowerCase();
	if (!toEmail) {
		return c.json({ ok: false, error: "Destination email ('to') is required" });
	}

	let fromEmail = (
		parsed.from ||
		parsed.mailboxId ||
		parsed.fromMailbox ||
		""
	)
		.trim()
		.toLowerCase();

	if (!fromEmail) {
		const mailboxes = await listMailboxesWithSettings(c.env.BUCKET);
		fromEmail =
			mailboxes[0]?.email || `noreply@${config.defaultFromDomain || "computin.dev"}`;
	}

	const settings = await getMailboxSettings(c.env.BUCKET, fromEmail);
	const fromField = resolveOutboundFrom(fromEmail, fromEmail, settings);
	const fromDomain = fromEmail.split("@")[1] || config.defaultFromDomain;
	const { outgoingMessageId } = generateMessageId(fromDomain);
	const selectedProvider =
		parsed.outboundProvider || parsed.provider || config.outboundProvider;

	const subject =
		parsed.subject?.trim() ||
		`Prueba de envío saliente — Agentic Inbox (${selectedProvider === "aws_ses" ? "AWS SES sa-east-1" : "Cloudflare Email"})`;

	const nowStr = new Date().toLocaleString("es-CL", {
		timeZone: "America/Santiago",
	});
	const textBody = [
		"Hola,",
		"",
		`Este es un correo de prueba enviado desde Agentic Inbox (${fromEmail}).`,
		`Proveedor activo: ${selectedProvider === "aws_ses" ? "AWS SES v2 (sa-east-1)" : "Cloudflare Email Service"}`,
		`Fecha y hora (Chile): ${nowStr}`,
		`Message-ID: <${outgoingMessageId}>`,
	].join("\n");

	try {
		const res = await sendOutboundEmail(
			c.env,
			{
				to: toEmail,
				from: fromField,
				subject,
				text: textBody,
				html: textToHtml(textBody),
				headers: buildOutboundHeaders(outgoingMessageId),
			},
			{ provider: selectedProvider },
		);

		return c.json({
			ok: true,
			messageId: res.messageId,
			wireMessageId: res.wireMessageId,
			provider: res.provider,
		});
	} catch (e) {
		return c.json({
			ok: false,
			provider: selectedProvider,
			error: (e as Error).message,
		});
	}
});

// -- Internal Mirror Endpoint for cobrador-hosting (`TOP 3` & `TOP 4`) --

export interface SentMirrorPayload {
	mailboxId?: string;
	from?: string | { email: string; name?: string };
	to: string | string[];
	cc?: string | string[];
	subject: string;
	body?: string;
	bodyText?: string;
	bodyHtml?: string;
	html?: string;
	text?: string;
	messageId?: string;
	wireMessageId?: string;
	cycleId?: string;
	clientId?: string;
	stage?: string;
	sentAt?: string;
}

export async function recordSentEmailMirror(
	env: Env,
	payload: SentMirrorPayload,
): Promise<{ ok: boolean; id: string; mailboxId: string }> {
	const rawFrom =
		typeof payload.from === "string"
			? payload.from
			: payload.from?.email || "";
	const mailboxId = (
		payload.mailboxId ||
		extractEmailAddress(rawFrom) ||
		"pablo@computin.dev"
	)
		.toLowerCase()
		.trim();

	const stub = getMailboxStub(env, mailboxId);
	await stub.getFolders();

	const toStr = (
		Array.isArray(payload.to) ? payload.to.join(", ") : payload.to || ""
	).toLowerCase();
	const ccStr = payload.cc
		? (Array.isArray(payload.cc) ? payload.cc.join(", ") : payload.cc).toLowerCase()
		: null;

	const id = crypto.randomUUID();
	const wireMsgId = (payload.wireMessageId || payload.messageId || "")
		.replace(/^<+|>+$/g, "")
		.trim() || `${id}@${mailboxId.split("@")[1] || "computin.dev"}`;

	const htmlBody =
		payload.bodyHtml ||
		payload.html ||
		(payload.body && /<[a-z][\s\S]*>/i.test(payload.body)
			? payload.body
			: textToHtml(payload.bodyText || payload.text || payload.body || ""));

	const sentAt = payload.sentAt || new Date().toISOString();

	await stub.createEmail(
		Folders.SENT,
		{
			id,
			subject: payload.subject || "",
			sender: mailboxId,
			recipient: toStr,
			cc: ccStr,
			date: sentAt,
			body: htmlBody,
			thread_id: wireMsgId,
			message_id: wireMsgId,
			raw_headers: JSON.stringify([
				{ key: "from", value: mailboxId },
				{ key: "to", value: toStr },
				{ key: "subject", value: payload.subject || "" },
				{ key: "date", value: sentAt },
				{ key: "message-id", value: `<${wireMsgId}>` },
				...(payload.cycleId
					? [{ key: "x-computin-cycle-id", value: payload.cycleId }]
					: []),
				...(payload.clientId
					? [{ key: "x-computin-client-id", value: payload.clientId }]
					: []),
				...(payload.stage
					? [{ key: "x-computin-stage", value: payload.stage }]
					: []),
			]),
		},
		[],
	);

	return { ok: true, id, mailboxId };
}

app.post("/api/internal/mirror-sent", async (c) => {
	const payload = (await c.req.json()) as SentMirrorPayload;
	const res = await recordSentEmailMirror(c.env, payload);
	return c.json(res);
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
	const config = await getPlatformConfig(c.env);

	const emailDomain = email.split("@")[1] || "";
	if (config.domains.length > 0 && !config.domains.includes(emailDomain)) {
		return c.json(
			{
				error: `Domain "${emailDomain}" is not in configured platform domains (${config.domains.join(", ")})`,
			},
			400,
		);
	}

	const allowedAddresses = config.emailAddresses;
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

	const isAntonio = email.startsWith("antonio@");
	const defaultSettings: MailboxSettingsRecord = {
		fromName: name,
		aliases: [],
		llmModel: "@cf/moonshotai/kimi-k2.5",
		autoDraftEnabled: true,
		persona: isAntonio ? "antonio" : "pablo",
		requireExplicitConfirm: isAntonio,
		forwarding: { enabled: false, email: "" },
		signature: { enabled: false, text: "" },
		autoReply: { enabled: false, subject: "", message: "" },
	};
	const finalSettings = settings
		? mergeMailboxSettings(defaultSettings, settings)
		: defaultSettings;

	await c.env.BUCKET.put(key, JSON.stringify(finalSettings));
	const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(email));
	await stub.getFolders();
	return c.json(
		{
			id: email,
			email,
			name: finalSettings.fromName || name,
			settings: finalSettings,
		},
		201,
	);
});

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = decodeURIComponent(c.req.param("mailboxId")!)
		.toLowerCase()
		.trim();
	const obj = await c.env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return c.json({ error: "Not found" }, 404);
	const settings = (await obj.json()) as MailboxSettingsRecord;
	return c.json({
		id: mailboxId,
		name: settings?.fromName?.trim() || mailboxId,
		email: mailboxId,
		settings,
	});
});

app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = decodeURIComponent(c.req.param("mailboxId")!)
		.toLowerCase()
		.trim();
	const body = (await c.req.json()) as { settings?: Record<string, unknown> } & Record<
		string,
		unknown
	>;
	const incomingSettings =
		body.settings && typeof body.settings === "object" ? body.settings : body;

	const key = `mailboxes/${mailboxId}.json`;
	const existingObj = await c.env.BUCKET.get(key);
	if (!existingObj) return c.json({ error: "Not found" }, 404);

	const existingSettings =
		((await existingObj.json()) as MailboxSettingsRecord) || {};
	const mergedSettings = mergeMailboxSettings(existingSettings, incomingSettings);

	await c.env.BUCKET.put(key, JSON.stringify(mergedSettings));
	return c.json({
		id: mailboxId,
		name: mergedSettings.fromName?.trim() || mailboxId,
		email: mailboxId,
		settings: mergedSettings,
	});
});

app.post("/api/v1/mailboxes/:mailboxId/migrate", async (c: AppContext) => {
	const oldEmail = decodeURIComponent(c.req.param("mailboxId")!)
		.toLowerCase()
		.trim();
	const { newEmail: rawNewEmail, keepOldAsAlias } = MigrateMailboxBody.parse(
		await c.req.json(),
	);
	const newEmail = rawNewEmail.toLowerCase().trim();

	if (newEmail === oldEmail) {
		return c.json(
			{ error: "New email address must be different from current address" },
			400,
		);
	}

	const config = await getPlatformConfig(c.env);
	const targetDomain = newEmail.split("@")[1] || "";
	if (config.domains.length > 0 && !config.domains.includes(targetDomain)) {
		return c.json(
			{
				error: `Domain "${targetDomain}" is not in active platform domains (${config.domains.join(", ")})`,
			},
			400,
		);
	}

	const newKey = `mailboxes/${newEmail}.json`;
	if (await c.env.BUCKET.head(newKey)) {
		return c.json({ error: `Mailbox "${newEmail}" already exists` }, 409);
	}

	const oldKey = `mailboxes/${oldEmail}.json`;
	const oldObj = await c.env.BUCKET.get(oldKey);
	if (!oldObj) return c.json({ error: "Source mailbox not found" }, 404);

	const existingSettings = ((await oldObj.json()) as MailboxSettingsRecord) || {};
	const aliasSet = new Set(
		(existingSettings.aliases ?? [])
			.map((a) => a.toLowerCase().trim())
			.filter((a) => a && a !== newEmail),
	);
	if (keepOldAsAlias !== false) {
		aliasSet.add(oldEmail);
	}

	const nextSettings: MailboxSettingsRecord = {
		...existingSettings,
		aliases: Array.from(aliasSet),
	};

	const oldStub = c.var.mailboxStub as any;
	const newStub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(newEmail)) as any;

	// Ensure default folders exist in target DO, then export & import all records
	await newStub.getFolders();
	const exported = await oldStub.exportAllData();
	const copied = await newStub.importAllData(exported, { oldEmail, newEmail });

	await c.env.BUCKET.put(newKey, JSON.stringify(nextSettings));
	await c.env.BUCKET.delete(oldKey);

	return c.json({
		ok: true,
		oldEmail,
		newEmail,
		keepOldAsAlias: keepOldAsAlias !== false,
		copied,
		mailbox: {
			id: newEmail,
			email: newEmail,
			name: nextSettings.fromName?.trim() || newEmail,
			settings: nextSettings,
		},
	});
});

app.delete("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = decodeURIComponent(c.req.param("mailboxId")!)
		.toLowerCase()
		.trim();
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);

	// Clean up R2 attachment blobs for emails in this mailbox before deleting metadata
	try {
		const stub = getMailboxStub(c.env, mailboxId) as any;
		const exported = await stub.exportAllData();
		const r2Keys: string[] = [];
		for (const att of exported.attachments || []) {
			if (att.email_id && att.id && att.filename) {
				r2Keys.push(`attachments/${att.email_id}/${att.id}/${att.filename}`);
			}
		}
		for (let i = 0; i < r2Keys.length; i += 500) {
			await c.env.BUCKET.delete(r2Keys.slice(i, i + 500));
		}
		if (typeof stub.purgeAllData === "function") {
			await stub.purgeAllData();
		}
	} catch (e) {
		console.warn("Mailbox attachment cleanup warning:", (e as Error).message);
	}

	await c.env.BUCKET.delete(key);
	return c.body(null, 204);
});

// -- Customer 360 Dossier & Payment Claim Routes (`TOP 1` & `TOP 3`) --

app.get("/api/v1/mailboxes/:mailboxId/dossier", async (c: AppContext) => {
	const email = (c.req.query("email") || c.req.query("clientId") || "").trim();
	if (!email) {
		const config = await getPlatformConfig(c.env);
		return c.json({
			found: false,
			cobradorUrl: config.cobradorUrl,
			adminUrl: `${config.cobradorUrl}/admin`,
			client: null,
			subscription: null,
			activeCycle: null,
			cycle: null,
		});
	}
	const dossier = await fetchClientDossier(c.env, email);
	return c.json(dossier);
});

app.post("/api/v1/mailboxes/:mailboxId/claim-payment", async (c: AppContext) => {
	const claim = ClaimPaymentBody.parse(await c.req.json());
	const result = await notifyPaymentClaim(c.env, {
		...claim,
		source: claim.source || "inbox_ui",
	});
	return c.json(result, result.ok ? 200 : 502);
});

// -- Emails ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const folder = c.req.query("folder");
	const thread_id = c.req.query("thread_id");
	const threaded = boolQuery(c, "threaded");
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	const sortColumn = c.req.query("sortColumn") as any;
	const sortDirection = c.req.query("sortDirection") as "ASC" | "DESC" | undefined;
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
	const mailboxId = decodeURIComponent(c.req.param("mailboxId")!)
		.toLowerCase()
		.trim();
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
		confirmedByHuman,
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
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	// Enforce Persona Governance on Bearer API-key requests unless confirmedByHuman is true
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
	const stub = c.var.mailboxStub;
	const rateLimitError = await (stub as any).checkSendRateLimit();
	if (rateLimitError) return c.json({ error: rateLimitError }, 429);

	const effectiveFrom = resolveOutboundFrom(from, fromEmail, settings);

	// Synchronous delivery BEFORE inserting into Folders.SENT (`CF-02`)
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
				disposition: att.disposition || "attachment",
				contentId: att.contentId,
			})),
			headers: buildOutboundHeaders(outgoingMessageId, {
				inReplyTo: in_reply_to,
				references: references || [],
			}),
		});
	} catch (e) {
		console.error("Outbound email delivery failed:", (e as Error).message);
		return c.json({ error: `Failed to send email: ${(e as Error).message}` }, 502);
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

	return c.json(
		{
			id: messageId,
			messageId: wireMessageId,
			provider: sendRes.provider,
			status: "sent",
		},
		200,
	);
});

app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c: AppContext) => {
	const mailboxId = decodeURIComponent(c.req.param("mailboxId")!)
		.toLowerCase()
		.trim();
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

	if (draft_id) {
		await deleteEmailWithAttachments(stub, c.env.BUCKET, draft_id);
	}

	return c.json(
		{
			id: messageId,
			draft_id: messageId,
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
	const success = await c.var.mailboxStub.moveEmail(c.req.param("id")!, folderId);
	return success ? c.json({ status: "moved" }) : c.json({ error: "Folder not found" }, 400);
});

// -- Threads --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c: AppContext) => {
	return c.json(
		await (c.var.mailboxStub as any).getThreadEmails(c.req.param("threadId")!),
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
		return c.json({ error: "Folder name must contain alphanumeric characters" }, 400);
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

// -- Receive inbound email (`CF-03`, `CF-12`, `TOP 1`) --------------

const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

async function streamToArrayBuffer(stream: ReadableStream, streamSize: number) {
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

export interface InboundEmailEvent {
	raw: ReadableStream;
	rawSize: number;
	to?: string;
	from?: string;
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

	const allHeaderRecipients = [
		...toRecipients,
		...ccRecipients,
		...bccRecipients,
	];

	const platformConfig = await getPlatformConfig(env);
	const resolved = await resolveInboundMailbox(env.BUCKET, {
		envelopeTo: event.to,
		headerRecipients: allHeaderRecipients,
		allowedAddresses: platformConfig.emailAddresses,
		platformAliases: platformConfig.aliases,
	});

	if (!resolved) {
		console.log(
			`Ignoring inbound email: no matching mailbox or alias for envelope="${event.to ?? ""}", headers=[${allHeaderRecipients.join(", ")}]`,
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
	const parentMessageIds = [
		...new Set([...emailReferences, ...(inReplyTo ? [inReplyTo] : [])]),
	];
	const existingThread =
		parentMessageIds.length > 0
			? await (stub as any).findThreadByMessageIds(parentMessageIds)
			: null;
	let threadId = existingThread || emailReferences[0] || inReplyTo || messageId;

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

	const senderAddress = (
		parsedEmail.from?.address ||
		event.from ||
		""
	)
		.toLowerCase()
		.trim();
	const recipientDisplay =
		toRecipients.length > 0 ? toRecipients.join(", ") : matchedAddress;

	await stub.createEmail(
		Folders.INBOX,
		{
			id: messageId,
			subject: parsedEmail.subject || "",
			sender: senderAddress,
			recipient: recipientDisplay,
			cc: ccRecipients.join(", ") || null,
			bcc: bccRecipients.join(", ") || null,
			date: new Date().toISOString(),
			body: parsedEmail.html || parsedEmail.text || "",
			in_reply_to: inReplyTo,
			email_references:
				emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
			thread_id: threadId,
			message_id: originalMessageId,
			raw_headers: JSON.stringify(parsedEmail.headers),
		},
		attachmentData,
	);

	// 1. Real `settings.forwarding` (`CF-03`): forward a copy if configured
	const forwardTo = mailboxSettings.forwarding?.enabled
		? mailboxSettings.forwarding.email?.trim().toLowerCase()
		: "";
	const selfAddresses = [mailboxId, ...(mailboxSettings.aliases ?? [])].map((a) =>
		a.toLowerCase().trim(),
	);
	const alreadyForwarded = (parsedEmail.headers || []).some(
		(h) => h.key?.toLowerCase() === "x-agentic-forwarded-from",
	);

	if (
		forwardTo &&
		forwardTo.includes("@") &&
		!selfAddresses.includes(forwardTo) &&
		forwardTo !== senderAddress &&
		!alreadyForwarded
	) {
		const fromDomain = mailboxId.split("@")[1] || "computin.dev";
		const { outgoingMessageId: fwdMsgId } = generateMessageId(fromDomain);
		const fwdSubject = (parsedEmail.subject || "(sin asunto)").startsWith("Fwd:")
			? parsedEmail.subject!
			: `Fwd: ${parsedEmail.subject || "(sin asunto)"}`;
		const plainOriginal =
			parsedEmail.text || stripHtmlToText(parsedEmail.html || "");
		const fwdHeaderNote = `---------- Mensaje reenviado desde ${mailboxId} ----------\nDe: ${senderAddress}\nPara: ${recipientDisplay}\nAsunto: ${parsedEmail.subject || ""}\n\n`;
		const fwdHtml = parsedEmail.html
			? `<div style="font-size:12px;color:#666;border-bottom:1px solid #ddd;padding-bottom:8px;margin-bottom:12px"><strong>Mensaje reenviado desde ${escapeHtml(mailboxId)}</strong><br>De: ${escapeHtml(senderAddress)}<br>Para: ${escapeHtml(recipientDisplay)}</div>${parsedEmail.html}`
			: textToHtml(`${fwdHeaderNote}${plainOriginal}`);

		ctx.waitUntil(
			sendOutboundEmail(env, {
				to: forwardTo,
				from: resolveOutboundFrom(mailboxId, mailboxId, mailboxSettings),
				replyTo: senderAddress || undefined,
				subject: fwdSubject,
				text: `${fwdHeaderNote}${plainOriginal}`,
				html: fwdHtml,
				headers: buildOutboundHeaders(fwdMsgId, undefined, {
					"X-Agentic-Forwarded-From": mailboxId,
				}),
			}).catch((e) =>
				console.error(
					`Inbound forwarding from ${mailboxId} to ${forwardTo} failed:`,
					(e as Error).message,
				),
			),
		);
	}

	// 2. Deterministic Banco de Chile Transfer Notification Parser (`TOP 1`)
	const plainBodyText =
		parsedEmail.text || stripHtmlToText(parsedEmail.html || "");
	const bankAlert = parseBancoChileTransferAlert(
		parsedEmail.subject || "",
		plainBodyText,
		parsedEmail.headers,
	);
	if (bankAlert) {
		ctx.waitUntil(
			notifyPaymentClaim(env, {
				amountClp: bankAlert.amountClp,
				rut: bankAlert.rutOrigen ?? undefined,
				glosa: bankAlert.glosa ?? undefined,
				source: bankAlert.dkimVerified
					? "banco_chile_dkim"
					: "banco_chile_forward",
				note: bankAlert.rawSummary,
			}).catch((e) =>
				console.error("Banco de Chile payment claim notify failed:", (e as Error).message),
			),
		);
	}

	// 3. Anti-bounce / RFC 3834 filter (`CF-12`) & per-mailbox `autoDraftEnabled`
	if (mailboxSettings.autoDraftEnabled === false) {
		console.log(`Skipping auto-draft for ${mailboxId}: autoDraftEnabled is false`);
		return;
	}

	const bounceCheck = isAutomatedOrBounceEmail({
		sender: senderAddress,
		envelopeFrom: event.from,
		headers: parsedEmail.headers,
		selfAddresses,
	});
	if (bounceCheck.automated) {
		console.log(
			`Skipping auto-draft for ${mailboxId} on email ${messageId} from "${senderAddress}": ${bounceCheck.reason}`,
		);
		return;
	}

	ctx.waitUntil(
		(async () => {
			const agentStub = await getAgentByName(env.EMAIL_AGENT, mailboxId);
			await agentStub.fetch(
				new Request("https://agents/onNewEmail", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						mailboxId,
						emailId: messageId,
						sender: senderAddress,
						subject: parsedEmail.subject || "",
						threadId,
					}),
				}),
			);
		})().catch((e) =>
			console.error("Auto-draft trigger failed:", (e as Error).message),
		),
	);
}

export { app, receiveEmail };
