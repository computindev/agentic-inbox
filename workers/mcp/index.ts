// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	fetchClientDossier,
	notifyPaymentClaim,
} from "../lib/cobrador-bridge";
import {
	toolListMailboxes,
	toolListEmails,
	toolGetEmail,
	toolGetThread,
	toolSearchEmails,
	toolDraftReply,
	toolDraftEmail,
	toolUpdateDraft,
	toolDeleteEmail,
	toolSendReply,
	toolSendEmail,
	toolMarkEmailRead,
	toolMoveEmail,
} from "../lib/tools";
import {
	Folders,
	FOLDER_TOOL_DESCRIPTION,
	MOVE_FOLDER_TOOL_DESCRIPTION,
} from "../../shared/folders";
import type { Env } from "../types";

/** Wrap a plain result object into MCP content format. */
function mcpText(result: unknown) {
	return {
		content: [
			{ type: "text" as const, text: JSON.stringify(result, null, 2) },
		],
	};
}

/** Wrap an error string into MCP error format. */
function mcpError(message: string) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
		isError: true as const,
	};
}

function mcpResult(result: Record<string, unknown>) {
	if ("error" in result) {
		return {
			content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
			isError: true as const,
		};
	}
	return mcpText(result);
}

/**
 * EmailMCP — exposes email & Computin Customer 360 tools over the Model Context Protocol (`TOP 8`).
 *
 * Clients (`pi`, Claude Code, Antigravity, Cursor) connect to `/mcp` using either
 * Cloudflare Access JWT or `Authorization: Bearer <AGENT_API_KEY>`.
 */
export class EmailMCP extends McpAgent<Env> {
	server = new McpServer({
		name: "agentic-inbox",
		version: "1.1.0",
	});

	async init() {
		const env = this.env;

		const verifyMailbox = async (mailboxId: string) => {
			const clean = mailboxId.toLowerCase().trim();
			const obj = await env.BUCKET.head(`mailboxes/${clean}.json`);
			if (!obj) {
				return mcpError(
					`Mailbox "${clean}" not found. Use list_mailboxes to see available mailboxes.`,
				);
			}
			return null;
		};

		// ── list_mailboxes ─────────────────────────────────────────
		this.server.tool(
			"list_mailboxes",
			"List all available mailboxes and their identity/alias settings",
			{},
			async () => {
				const result = await toolListMailboxes(env);
				return mcpText(result);
			},
		);

		// ── list_emails ────────────────────────────────────────────
		this.server.tool(
			"list_emails",
			"List emails in a mailbox folder. Returns email metadata (id, subject, sender, recipient, date, read/starred status, thread_id).",
			{
				mailboxId: z
					.string()
					.describe("The mailbox email address (e.g. pablo@computin.dev)"),
				folder: z
					.string()
					.default(Folders.INBOX)
					.describe(FOLDER_TOOL_DESCRIPTION),
				limit: z
					.number()
					.default(20)
					.describe("Maximum number of emails to return"),
				page: z
					.number()
					.default(1)
					.describe("Page number for pagination"),
			},
			async ({ mailboxId, folder, limit, page }) => {
				const cleanId = mailboxId.toLowerCase().trim();
				const denied = await verifyMailbox(cleanId);
				if (denied) return denied;
				const result = await toolListEmails(env, cleanId, { folder, limit, page });
				return mcpText(result);
			},
		);

		// ── get_email ──────────────────────────────────────────────
		this.server.tool(
			"get_email",
			"Get a single email with its full body content and attachments.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email ID to retrieve"),
			},
			async ({ mailboxId, emailId }) => {
				const cleanId = mailboxId.toLowerCase().trim();
				const denied = await verifyMailbox(cleanId);
				if (denied) return denied;
				const result = await toolGetEmail(env, cleanId, emailId);
				if ("error" in result) {
					return {
						content: [{ type: "text" as const, text: "Email not found" }],
						isError: true,
					};
				}
				return mcpText(result);
			},
		);

		// ── get_thread ─────────────────────────────────────────────
		this.server.tool(
			"get_thread",
			"Get all emails in a conversation thread sorted chronologically.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				threadId: z
					.string()
					.describe("The thread_id to retrieve all messages for"),
			},
			async ({ mailboxId, threadId }) => {
				const cleanId = mailboxId.toLowerCase().trim();
				const denied = await verifyMailbox(cleanId);
				if (denied) return denied;
				const result = await toolGetThread(env, cleanId, threadId);
				return mcpText(result);
			},
		);

		// ── search_emails ──────────────────────────────────────────
		this.server.tool(
			"search_emails",
			"Search for emails matching a query (supports operators: from:, to:, subject:, in:, is:unread, is:read, is:starred, has:attachment, before:, after:).",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				query: z
					.string()
					.describe("Search query (e.g. 'from:chilemarine is:unread')"),
				folder: z
					.string()
					.optional()
					.describe("Optional folder to restrict search to"),
			},
			async ({ mailboxId, query, folder }) => {
				const cleanId = mailboxId.toLowerCase().trim();
				const denied = await verifyMailbox(cleanId);
				if (denied) return denied;
				const result = await toolSearchEmails(env, cleanId, { query, folder });
				return mcpText(result);
			},
		);

		// ── draft_reply ────────────────────────────────────────────
		this.server.tool(
			"draft_reply",
			"Draft a reply to an email and save it to the Drafts folder (applies mailbox signature and deterministic financial verification). Does NOT send.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				originalEmailId: z
					.string()
					.describe("The ID of the email being replied to"),
				to: z.string().email().describe("Recipient email address"),
				subject: z.string().describe("Subject line (usually 'Re: ...')"),
				bodyHtml: z.string().describe("The HTML body of the reply"),
			},
			async ({ mailboxId, originalEmailId, to, subject, bodyHtml }) => {
				const cleanId = mailboxId.toLowerCase().trim();
				const denied = await verifyMailbox(cleanId);
				if (denied) return denied;
				const result = await toolDraftReply(env, cleanId, {
					originalEmailId,
					to,
					subject,
					body: bodyHtml,
					isPlainText: false,
					runVerifyDraft: true,
				});
				return mcpResult(result);
			},
		);

		// ── create_draft ───────────────────────────────────────────
		this.server.tool(
			"create_draft",
			"Create a new draft email in the Drafts folder. Can be a new email or a reply draft.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				to: z
					.string()
					.optional()
					.describe("Recipient email address (optional for early drafts)"),
				subject: z.string().describe("Subject line"),
				bodyHtml: z.string().describe("The HTML body of the draft"),
				in_reply_to: z
					.string()
					.optional()
					.describe("The ID of the email this draft is replying to (optional)"),
				thread_id: z
					.string()
					.optional()
					.describe("Thread ID to attach this draft to (optional)"),
			},
			async ({ mailboxId, to, subject, bodyHtml, in_reply_to, thread_id }) => {
				const cleanId = mailboxId.toLowerCase().trim();
				const denied = await verifyMailbox(cleanId);
				if (denied) return denied;
				const result = await toolDraftEmail(env, cleanId, {
					to: to || "",
					subject,
					body: bodyHtml,
					isPlainText: false,
					runVerifyDraft: true,
					in_reply_to,
					thread_id,
				});
				if ("error" in result) {
					return mcpResult(result);
				}
				return mcpText({
					status: "draft_created",
					draftId: result.draftId,
					threadId: result.threadId,
					verificationCode: result.verificationCode,
					...(result.verificationWarnings
						? { verificationWarnings: result.verificationWarnings }
						: {}),
					message: result.message,
				});
			},
		);

		// ── update_draft ───────────────────────────────────────────
		this.server.tool(
			"update_draft",
			"Update an existing draft email's content.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				draftId: z.string().describe("The ID of the draft to update"),
				to: z
					.string()
					.optional()
					.describe("Updated recipient email address"),
				subject: z.string().optional().describe("Updated subject line"),
				bodyHtml: z.string().optional().describe("Updated HTML body"),
			},
			async ({ mailboxId, draftId, to, subject, bodyHtml }) => {
				const cleanId = mailboxId.toLowerCase().trim();
				const denied = await verifyMailbox(cleanId);
				if (denied) return denied;
				const result = await toolUpdateDraft(env, cleanId, {
					draftId,
					to,
					subject,
					bodyHtml,
				});
				if ("error" in result) {
					if (result.error === "Draft not found") {
						return {
							content: [{ type: "text" as const, text: "Draft not found" }],
							isError: true,
						};
					}
					return mcpResult(result);
				}
				return mcpText(result);
			},
		);

		// ── delete_email ───────────────────────────────────────────
		this.server.tool(
			"delete_email",
			"Permanently delete an email and its R2 attachments by ID.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email ID to delete"),
			},
			async ({ mailboxId, emailId }) => {
				const cleanId = mailboxId.toLowerCase().trim();
				const denied = await verifyMailbox(cleanId);
				if (denied) return denied;
				const result = await toolDeleteEmail(env, cleanId, emailId);
				return mcpResult(result);
			},
		);

		// ── send_reply ─────────────────────────────────────────────
		this.server.tool(
			"send_reply",
			"Send a reply to an email using the mailbox's configured display name and signature. Mailboxes using the Antonio persona require confirmedByHuman=true.",
			{
				mailboxId: z.string().describe("The mailbox email address to send from"),
				originalEmailId: z
					.string()
					.describe("The ID of the email being replied to"),
				to: z.string().email().describe("Recipient email address"),
				subject: z.string().describe("Subject line"),
				bodyHtml: z.string().describe("The HTML body of the reply"),
				confirmedByHuman: z
					.boolean()
					.optional()
					.describe(
						"Set true ONLY when the human operator explicitly approved sending this message (mandatory for Antonio persona)",
					),
			},
			async ({
				mailboxId,
				originalEmailId,
				to,
				subject,
				bodyHtml,
				confirmedByHuman,
			}) => {
				const cleanId = mailboxId.toLowerCase().trim();
				const denied = await verifyMailbox(cleanId);
				if (denied) return denied;
				const result = await toolSendReply(env, cleanId, {
					originalEmailId,
					to,
					subject,
					bodyHtml,
					confirmedByHuman,
				});
				if ("error" in result) {
					if (
						typeof result.error === "string" &&
						result.error.startsWith("Failed to send")
					) {
						return {
							content: [{ type: "text" as const, text: result.error }],
							isError: true,
						};
					}
					if (result.error === "Original email not found") {
						return {
							content: [{ type: "text" as const, text: "Original email not found" }],
							isError: true,
						};
					}
					return mcpResult(result);
				}
				return mcpText(result);
			},
		);

		// ── send_email ─────────────────────────────────────────────
		this.server.tool(
			"send_email",
			"Send a new email (not a reply) using the mailbox's configured display name and signature. Mailboxes using the Antonio persona require confirmedByHuman=true.",
			{
				mailboxId: z.string().describe("The mailbox email address to send from"),
				to: z.string().email().describe("Recipient email address"),
				subject: z.string().describe("Subject line"),
				bodyHtml: z.string().describe("The HTML body of the email"),
				confirmedByHuman: z
					.boolean()
					.optional()
					.describe(
						"Set true ONLY when the human operator explicitly approved sending this message (mandatory for Antonio persona)",
					),
			},
			async ({ mailboxId, to, subject, bodyHtml, confirmedByHuman }) => {
				const cleanId = mailboxId.toLowerCase().trim();
				const denied = await verifyMailbox(cleanId);
				if (denied) return denied;
				const result = await toolSendEmail(env, cleanId, {
					to,
					subject,
					bodyHtml,
					confirmedByHuman,
				});
				if ("error" in result) {
					if (
						typeof result.error === "string" &&
						result.error.startsWith("Failed to send")
					) {
						return {
							content: [{ type: "text" as const, text: result.error }],
							isError: true,
						};
					}
					return mcpResult(result);
				}
				return mcpText(result);
			},
		);

		// ── mark_email_read ────────────────────────────────────────
		this.server.tool(
			"mark_email_read",
			"Mark an email as read or unread.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email ID"),
				read: z.boolean().describe("true to mark as read, false for unread"),
			},
			async ({ mailboxId, emailId, read }) => {
				const cleanId = mailboxId.toLowerCase().trim();
				const denied = await verifyMailbox(cleanId);
				if (denied) return denied;
				const result = await toolMarkEmailRead(env, cleanId, emailId, read);
				return mcpText(result);
			},
		);

		// ── move_email ─────────────────────────────────────────────
		this.server.tool(
			"move_email",
			"Move an email to a different folder (inbox, sent, draft, archive, trash).",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email ID"),
				folderId: z.string().describe(MOVE_FOLDER_TOOL_DESCRIPTION),
			},
			async ({ mailboxId, emailId, folderId }) => {
				const cleanId = mailboxId.toLowerCase().trim();
				const denied = await verifyMailbox(cleanId);
				if (denied) return denied;
				const result = await toolMoveEmail(env, cleanId, emailId, folderId);
				if ("error" in result) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({ error: "Failed to move email" }),
							},
						],
						isError: true,
					};
				}
				return mcpText(result);
			},
		);

		// ── get_client_dossier (TOP 3 & TOP 8) ─────────────────────
		this.server.tool(
			"get_client_dossier",
			"Fetch the live Customer 360 billing dossier from cobrador-hosting by client email or client slug/ID (plan, UF/CLP amount today, active cycle status, due date, holds, and /p/:token payment link).",
			{
				email: z
					.string()
					.describe(
						"Client email address or client ID/slug (e.g. 'nacherry@chilemarine.cl' or 'chilemarine')",
					),
			},
			async ({ email }) => {
				const dossier = await fetchClientDossier(env, email);
				return mcpText(dossier);
			},
		);

		// ── register_payment_claim (TOP 1, TOP 3 & TOP 8) ──────────
		this.server.tool(
			"register_payment_claim",
			"Register a payment transfer claim in cobrador-hosting to pause billing reminders on the active cycle while bank reconciliation is verified.",
			{
				email: z
					.string()
					.optional()
					.describe("Client email address"),
				clientId: z
					.string()
					.optional()
					.describe("Client ID/slug in cobrador-hosting"),
				cycleId: z
					.string()
					.optional()
					.describe("Billing cycle ID (e.g. 'chilemarine-hosting:2026-11-08')"),
				amountClp: z
					.number()
					.optional()
					.describe("Transferred amount in Chilean Pesos ($ CLP)"),
				rut: z
					.string()
					.optional()
					.describe("Origin or client Chilean RUT"),
				glosa: z
					.string()
					.optional()
					.describe("Bank transfer reference / glosa (e.g. 'CHILEMARINE-2026')"),
				source: z
					.string()
					.default("mcp")
					.describe("Origin of the payment claim (e.g. 'mcp', 'email', 'banco_chile')"),
				note: z
					.string()
					.optional()
					.describe("Optional context note or receipt summary"),
			},
			async ({ email, clientId, cycleId, amountClp, rut, glosa, source, note }) => {
				const result = await notifyPaymentClaim(env, {
					email,
					clientId,
					cycleId,
					amountClp,
					rut,
					glosa,
					source,
					note,
				});
				if (!result.ok && result.error) {
					return mcpError(result.error);
				}
				return mcpText(result);
			},
		);
	}
}
