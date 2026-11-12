// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { AIChatAgent } from "@cloudflare/ai-chat";
import {
	streamText,
	generateText,
	convertToModelMessages,
	stepCountIs,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import type { EmailFull, EmailMetadata } from "../lib/schemas";
import {
	verifyDraft,
	verifyDraftDeterministically,
	isPromptInjection,
} from "../lib/ai";
import {
	PABLO_DEFAULT_SYSTEM_PROMPT,
	fetchClientDossier,
	notifyPaymentClaim,
	formatDossierForPrompt,
} from "../lib/cobrador-bridge";
import {
	getMailboxStub,
	getMailboxSettings,
	stripHtmlToText,
	textToHtml,
	appendSignature,
} from "../lib/email-helpers";
import {
	toolListEmails,
	toolGetEmail,
	toolGetThread,
	toolSearchEmails,
	toolDraftReply,
	toolDraftEmail,
	toolMarkEmailRead,
	toolMoveEmail,
	toolDiscardDraft,
} from "../lib/tools";
import {
	Folders,
	FOLDER_TOOL_DESCRIPTION,
	MOVE_FOLDER_TOOL_DESCRIPTION,
} from "../../shared/folders";
import type { Env, MailboxSettingsRecord } from "../types";

export const DEFAULT_LLM_MODEL = "@cf/moonshotai/kimi-k2.5";

function defineTool(def: {
	description: string;
	parameters: z.ZodType<any>;
	execute: (...args: any[]) => Promise<any>;
}) {
	return {
		description: def.description,
		inputSchema: def.parameters,
		execute: def.execute,
	};
}

/**
 * Generic fallback system prompt for non-Computin mailboxes when no custom prompt is set.
 */
const GENERIC_DEFAULT_SYSTEM_PROMPT = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.

## Writing Style
Write like a real person. Short, direct, flowing prose. Get to the point. Plain text only - no HTML tags in your replies.

**Agent Behavior Rules (CRITICAL):**
- NEVER output meta-commentary about what you are doing (e.g. do not say "I am drafting a reply", "I checked the thread", etc).
- When a new email arrives, your ONLY job is to call the \`draft_reply\` tool.
- Before drafting ANY reply, carefully read the full thread history.
- You can ONLY draft emails (\`draft_reply\` / \`draft_email\`). You do NOT have the ability to send emails directly.`;

const ANTONIO_PERSONA_ADDENDUM = `

## REGLA DE GOBERNANZA — PERSONA ANTONIO CORREA (ESTRICTO)
Esta casilla opera bajo la identidad de **Antonio Correa**. Todo correo queda ESTRICTAMENTE en Borradores (Drafts) para revisión y confirmación explícita de Antonio. Escribe en primera persona singular ("te comento", "revisé"), tono directo chileno, sobrio y técnico, sin jamás inventar montos ni condiciones comerciales.`;

function shouldUsePabloPromptByDefault(
	mailboxId: string,
	settings: MailboxSettingsRecord,
): boolean {
	if (settings.persona === "pablo") return true;
	const lower = mailboxId.toLowerCase().trim();
	return (
		lower.startsWith("pablo@") ||
		lower.startsWith("cobranza@") ||
		lower.startsWith("pagos@") ||
		lower.endsWith("@computin.dev") ||
		lower.endsWith("@computincloudhosting.com")
	);
}

/**
 * Resolve the effective system prompt and LLM model for a mailbox from R2 settings.
 */
async function resolveAgentConfig(
	env: Env,
	mailboxId: string,
): Promise<{
	systemPrompt: string;
	llmModel: string;
	autoDraftEnabled: boolean;
	settings: MailboxSettingsRecord;
}> {
	const settings = await getMailboxSettings(env.BUCKET, mailboxId);
	const llmModel = settings.llmModel?.trim() || DEFAULT_LLM_MODEL;
	const autoDraftEnabled = settings.autoDraftEnabled !== false;

	let systemPrompt: string;
	if (typeof settings.agentSystemPrompt === "string" && settings.agentSystemPrompt.trim()) {
		systemPrompt = settings.agentSystemPrompt.trim();
	} else if (shouldUsePabloPromptByDefault(mailboxId, settings)) {
		systemPrompt = PABLO_DEFAULT_SYSTEM_PROMPT;
	} else {
		systemPrompt = GENERIC_DEFAULT_SYSTEM_PROMPT;
	}

	if (
		settings.persona === "antonio" ||
		mailboxId.toLowerCase().trim().startsWith("antonio@")
	) {
		systemPrompt += ANTONIO_PERSONA_ADDENDUM;
	}

	return { systemPrompt, llmModel, autoDraftEnabled, settings };
}

function createEmailTools(env: Env, mailboxId: string) {
	return {
		list_emails: defineTool({
			description:
				"List emails in a folder. Returns email metadata (id, subject, sender, recipient, date, read/starred status, thread_id). Use folder='inbox' for received emails, 'sent' for sent emails.",
			parameters: z.object({
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
			}),
			execute: async ({ folder, limit, page }): Promise<unknown> => {
				return toolListEmails(env, mailboxId, { folder, limit, page });
			},
		}),

		get_email: defineTool({
			description:
				"Get a single email with its full body content and attachments. Use this to read the actual content of an email.",
			parameters: z.object({
				emailId: z.string().describe("The email ID to retrieve"),
			}),
			execute: async ({ emailId }): Promise<unknown> => {
				return toolGetEmail(env, mailboxId, emailId);
			},
		}),

		get_thread: defineTool({
			description:
				"Get all emails in a conversation thread. Returns all messages sorted chronologically.",
			parameters: z.object({
				threadId: z
					.string()
					.describe(
						"The thread_id to retrieve all messages for. Get this from an email's thread_id field.",
					),
			}),
			execute: async ({ threadId }): Promise<unknown> => {
				return toolGetThread(env, mailboxId, threadId);
			},
		}),

		search_emails: defineTool({
			description:
				"Search for emails matching a query (supports operators like from:, to:, subject:, is:unread, has:attachment).",
			parameters: z.object({
				query: z
					.string()
					.describe("Search query to match against subject, body, and operators"),
				folder: z
					.string()
					.optional()
					.describe("Optional folder to restrict search to"),
			}),
			execute: async ({ query, folder }): Promise<unknown> => {
				return toolSearchEmails(env, mailboxId, { query, folder });
			},
		}),

		get_client_dossier: defineTool({
			description:
				"Consulta la Ficha Cliente Computin (Customer 360) en cobrador-hosting por email o ID de cliente: plan, monto UF/CLP exacto de hoy, vencimiento, estado del ciclo, RUT y link oficial de pago /p/:token.",
			parameters: z.object({
				email: z
					.string()
					.describe("Correo electrónico del cliente o slug/ID en cobrador-hosting"),
			}),
			execute: async ({ email }): Promise<unknown> => {
				return fetchClientDossier(env, email);
			},
		}),

		register_payment_claim: defineTool({
			description:
				"Registra un aviso de transferencia/pago en cobrador-hosting para pausar inmediatamente los recordatorios de cobro del ciclo activo mientras se verifica en el banco.",
			parameters: z.object({
				email: z.string().optional().describe("Correo electrónico del cliente"),
				cycleId: z.string().optional().describe("ID del ciclo si se conoce"),
				amountClp: z.number().optional().describe("Monto en pesos chilenos ($ CLP) informado"),
				rut: z.string().optional().describe("RUT de origen o del cliente"),
				glosa: z.string().optional().describe("Glosa o referencia bancaria"),
				note: z.string().optional().describe("Nota resumen del aviso de pago"),
			}),
			execute: async ({ email, cycleId, amountClp, rut, glosa, note }): Promise<unknown> => {
				return notifyPaymentClaim(env, {
					email,
					cycleId,
					amountClp,
					rut,
					glosa,
					source: "email_agent",
					note,
				});
			},
		}),

		draft_email: defineTool({
			description:
				"Draft a new email (not a reply) and save it to the Drafts folder. Does NOT send — saves a draft for operator review. Write the body as plain text — no HTML tags.",
			parameters: z.object({
				to: z.string().email().describe("Recipient email address"),
				subject: z.string().describe("Subject line"),
				body: z
					.string()
					.describe("The plain text body of the email. No HTML — write normally."),
			}),
			execute: async ({ to, subject, body }): Promise<unknown> => {
				return toolDraftEmail(env, mailboxId, {
					to,
					subject,
					body,
					isPlainText: true,
					runVerifyDraft: true,
				});
			},
		}),

		draft_reply: defineTool({
			description:
				"Draft a reply to an existing email and save it to the Drafts folder. Does NOT send — saves a draft for operator review. Write the body as plain text — no HTML tags.",
			parameters: z.object({
				originalEmailId: z
					.string()
					.describe("The ID of the email being replied to"),
				to: z.string().email().describe("Recipient email address"),
				subject: z
					.string()
					.describe("Subject line (usually 'Re: ...')"),
				body: z
					.string()
					.describe("The plain text body of the reply. No HTML — write normally."),
			}),
			execute: async ({ originalEmailId, to, subject, body }): Promise<unknown> => {
				return toolDraftReply(env, mailboxId, {
					originalEmailId,
					to,
					subject,
					body,
					isPlainText: true,
					runVerifyDraft: true,
				});
			},
		}),

		mark_email_read: defineTool({
			description: "Mark an email as read or unread.",
			parameters: z.object({
				emailId: z.string().describe("The email ID"),
				read: z
					.boolean()
					.describe("true to mark as read, false for unread"),
			}),
			execute: async ({ emailId, read }): Promise<unknown> => {
				return toolMarkEmailRead(env, mailboxId, emailId, read);
			},
		}),

		move_email: defineTool({
			description:
				"Move an email to a different folder (inbox, sent, draft, archive, trash).",
			parameters: z.object({
				emailId: z.string().describe("The email ID"),
				folderId: z
					.string()
					.describe(MOVE_FOLDER_TOOL_DESCRIPTION),
			}),
			execute: async ({ emailId, folderId }): Promise<unknown> => {
				return toolMoveEmail(env, mailboxId, emailId, folderId);
			},
		}),

		discard_draft: defineTool({
			description:
				"Delete a draft email that is no longer needed or was rejected by the operator.",
			parameters: z.object({
				draftId: z.string().describe("The ID of the draft to delete"),
			}),
			execute: async ({ draftId }): Promise<unknown> => {
				return toolDiscardDraft(env, mailboxId, draftId);
			},
		}),
	};
}

export class EmailAgent extends AIChatAgent<any> {
	async onChatMessage(onFinish: any) {
		const env = this.env as Env;
		const mailboxId = this.name;
		const workersai = createWorkersAI({ binding: env.AI });
		const tools = createEmailTools(env, mailboxId);
		const { systemPrompt, llmModel } = await resolveAgentConfig(env, mailboxId);

		const result = streamText({
			model: workersai(llmModel as any),
			system: systemPrompt,
			messages: await convertToModelMessages(this.messages),
			tools,
			stopWhen: stepCountIs(5),
			onFinish,
		});

		return result.toUIMessageStreamResponse();
	}

	async onRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/onNewEmail" && request.method === "POST") {
			try {
				const emailData = (await request.json()) as {
					mailboxId: string;
					emailId: string;
					sender: string;
					subject: string;
					threadId: string;
				};
				const result = await this.handleNewEmail(emailData);
				return new Response(JSON.stringify(result), {
					headers: { "Content-Type": "application/json" },
				});
			} catch (e) {
				console.error("onNewEmail handler failed:", (e as Error).message);
				return new Response(
					JSON.stringify({ error: (e as Error).message }),
					{ status: 500, headers: { "Content-Type": "application/json" } },
				);
			}
		}
		return super.onRequest(request);
	}

	async handleNewEmail(emailData: {
		mailboxId: string;
		emailId: string;
		sender: string;
		subject: string;
		threadId: string;
	}) {
		const env = this.env as Env;
		const { systemPrompt, llmModel, autoDraftEnabled, settings } =
			await resolveAgentConfig(env, emailData.mailboxId);

		if (!autoDraftEnabled) {
			return { status: "skipped_auto_draft_disabled" };
		}

		const workersai = createWorkersAI({ binding: env.AI });
		const tools = createEmailTools(env, emailData.mailboxId);
		const stub = getMailboxStub(env, emailData.mailboxId);

		let emailBody = "";
		let threadContext = "";
		try {
			const email = (await stub.getEmail(emailData.emailId)) as EmailFull | null;
			if (email?.body) {
				const isInjection = await isPromptInjection(env.AI, email.body);
				if (isInjection) {
					console.warn(
						"Skipping auto-draft due to detected prompt injection:",
						emailData.emailId,
					);
					const newMessages = [
						{
							id: crypto.randomUUID(),
							role: "user" as const,
							content: `[Auto-triggered] Nuevo correo de ${emailData.sender}: "${emailData.subject}"`,
							createdAt: new Date(),
							parts: [
								{
									type: "text" as const,
									text: `[Auto-triggered] Nuevo correo de ${emailData.sender}: "${emailData.subject}"`,
								},
							],
						},
						{
							id: crypto.randomUUID(),
							role: "assistant" as const,
							content:
								"⚠️ Auto-redacción bloqueada: se detectaron posibles instrucciones de prompt injection en el correo entrante.",
							createdAt: new Date(),
							parts: [
								{
									type: "text" as const,
									text: "⚠️ Auto-redacción bloqueada: se detectaron posibles instrucciones de prompt injection en el correo entrante.",
								},
							],
						},
					];
					await this.persistMessages([...this.messages, ...newMessages]);
					return { status: "blocked_prompt_injection" };
				}

				emailBody = stripHtmlToText(email.body);
			}

			const threadEmails = (await stub.getEmails({
				thread_id: emailData.threadId,
			})) as EmailMetadata[];
			if (threadEmails.length > 1) {
				const fullThread = await Promise.all(
					threadEmails.map(async (e) => {
						const full = (await stub.getEmail(e.id)) as EmailFull | null;
						const text = full?.body ? stripHtmlToText(full.body) : "";
						return {
							id: e.id,
							sender: e.sender,
							recipient: e.recipient,
							subject: e.subject,
							date: e.date,
							folder_id: e.folder_id,
							body_text: text,
						};
					}),
				);
				fullThread.sort(
					(a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
				);
				threadContext = fullThread
					.map(
						(e) =>
							`[${e.date}] ${e.sender} → ${e.recipient} (${e.folder_id}): ${e.body_text.substring(0, 500)}`,
					)
					.join("\n\n");

				if (threadContext) {
					const threadInjection = await isPromptInjection(env.AI, threadContext);
					if (threadInjection) {
						console.warn(
							"Skipping auto-draft due to prompt injection in thread context:",
							emailData.threadId,
						);
						const newMessages = [
							{
								id: crypto.randomUUID(),
								role: "user" as const,
								content: `[Auto-triggered] Nuevo correo de ${emailData.sender}: "${emailData.subject}"`,
								createdAt: new Date(),
								parts: [
									{
										type: "text" as const,
										text: `[Auto-triggered] Nuevo correo de ${emailData.sender}: "${emailData.subject}"`,
									},
								],
							},
							{
								id: crypto.randomUUID(),
								role: "assistant" as const,
								content:
									"⚠️ Auto-redacción bloqueada: el historial del hilo contiene señales de prompt injection.",
								createdAt: new Date(),
								parts: [
									{
										type: "text" as const,
										text: "⚠️ Auto-redacción bloqueada: el historial del hilo contiene señales de prompt injection.",
									},
								],
							},
						];
						await this.persistMessages([...this.messages, ...newMessages]);
						return { status: "blocked_prompt_injection" };
					}
				}
			}
		} catch (e) {
			console.warn("Pre-read failed, agent will use tools:", (e as Error).message);
		}

		// Fetch live Customer 360 Dossier from `cobrador-hosting` (`TOP 3`)
		const dossier = await fetchClientDossier(env, emailData.sender);
		const dossierSection = formatDossierForPrompt(dossier);

		let autoPrompt = `Acaba de llegar un nuevo correo. Redacta una respuesta apropiada guardándola en Borradores mediante \`draft_reply\`. Si el cliente informa que ya transfirió o pagó, llama primero a \`register_payment_claim\` y luego a \`draft_reply\`.

Detalles del correo:
- Casilla: ${emailData.mailboxId}
- Email ID: ${emailData.emailId}
- De: ${emailData.sender}
- Asunto: ${emailData.subject}
- Thread ID: ${emailData.threadId}

${dossierSection}

Cuerpo del correo recibido:
${emailBody || "(no se pudo pre-leer — usa get_email si necesitas leerlo)"}`;

		if (threadContext) {
			autoPrompt += `\n\nHistorial completo del hilo (${emailData.threadId}):\n${threadContext}`;
		} else {
			autoPrompt += `\n\nEste es el primer mensaje en el hilo.`;
		}

		autoPrompt += `\n\nRecuerda: NUNCA inventes montos, UF, RUTs, cuentas bancarias ni enlaces /p/... que no estén en la Ficha Cliente Computin.`;

		const messages = [
			{
				role: "user" as const,
				content: autoPrompt,
				parts: [{ type: "text" as const, text: autoPrompt }],
				createdAt: new Date(),
			},
		];

		try {
			const result = await generateText({
				model: workersai(llmModel as any),
				system: systemPrompt,
				messages: await convertToModelMessages(messages),
				tools,
				stopWhen: stepCountIs(5),
			});

			const draftToolCalled = result.steps.some((step) =>
				step.toolCalls.some(
					(tc) => tc.toolName === "draft_reply" || tc.toolName === "draft_email",
				),
			);

			let detWarningNote = "";

			if (!draftToolCalled && result.text.trim()) {
				const sanitizedText = await verifyDraft(env.AI, result.text.trim());
				if (sanitizedText) {
					const withSig = appendSignature(sanitizedText, settings.signature, false);
					const detCheck = verifyDraftDeterministically(withSig, { dossier });
					if (!detCheck.ok) {
						detWarningNote = ` (⚠️ Revisión requerida: ${detCheck.mismatches.map((m) => m.reason).join("; ")})`;
					}

					const draftId = crypto.randomUUID();
					const draftStub = getMailboxStub(env, emailData.mailboxId);
					const reSubject = emailData.subject.startsWith("Re:")
						? emailData.subject
						: `Re: ${emailData.subject}`;
					await draftStub.createEmail(
						Folders.DRAFT,
						{
							id: draftId,
							subject: reSubject,
							sender: emailData.mailboxId.toLowerCase(),
							recipient: emailData.sender.toLowerCase(),
							date: new Date().toISOString(),
							body: /<[a-z][\s\S]*>/i.test(withSig) ? withSig : textToHtml(withSig),
							in_reply_to: emailData.emailId,
							email_references: null,
							thread_id: emailData.threadId,
						},
						[],
					);
				}
			}

			const assistantText = draftToolCalled
				? `Borrador de respuesta creado para ${emailData.sender}${dossier.found && dossier.clientName ? ` (${dossier.clientName})` : ""}.`
				: `${result.text}${detWarningNote}`;

			const newMessages = [
				{
					id: crypto.randomUUID(),
					role: "user" as const,
					content: `[Auto-triggered] Nuevo correo de ${emailData.sender}: "${emailData.subject}"`,
					createdAt: new Date(),
					parts: [
						{
							type: "text" as const,
							text: `[Auto-triggered] Nuevo correo de ${emailData.sender}: "${emailData.subject}"`,
						},
					],
				},
				{
					id: crypto.randomUUID(),
					role: "assistant" as const,
					content: assistantText,
					createdAt: new Date(),
					parts: [
						{
							type: "text" as const,
							text: assistantText,
						},
					],
				},
			];

			await this.persistMessages([...this.messages, ...newMessages]);

			return { status: "draft_generated", text: assistantText };
		} catch (e) {
			console.error("Auto-draft failed:", (e as Error).message);
			return { status: "error", error: (e as Error).message };
		}
	}
}
