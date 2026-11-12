// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Badge,
	Banner,
	Button,
	Checkbox,
	Input,
	Loader,
	Select,
	Switch,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	ArrowCounterClockwiseIcon,
	ArrowsLeftRightIcon,
	EnvelopeSimpleIcon,
	PlusIcon,
	RobotIcon,
	SignatureIcon,
	SparkleIcon,
	UserCircleIcon,
	XIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { queryKeys } from "~/queries/keys";
import {
	useMailbox,
	useMigrateMailbox,
	useUpdateMailbox,
} from "~/queries/mailboxes";
import api from "~/services/api";
import type { AgentPersona, MailboxSettings } from "~/types";

const DEFAULT_LLM_MODEL = "@cf/moonshotai/kimi-k2.5";

const LLM_MODEL_OPTIONS = [
	{
		value: "@cf/moonshotai/kimi-k2.5",
		label: "Kimi K2.5 — Recomendado (@cf/moonshotai/kimi-k2.5)",
	},
	{
		value: "@cf/meta/llama-4-scout-17b-16e-instruct",
		label: "Llama 4 Scout 17B (@cf/meta/llama-4-scout-17b-16e-instruct)",
	},
	{
		value: "@cf/qwen/qwq-32b",
		label: "Qwen QwQ 32B (@cf/qwen/qwq-32b)",
	},
	{
		value: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
		label: "Llama 3.3 70B Fast (@cf/meta/llama-3.3-70b-instruct-fp8-fast)",
	},
] as const;

const PROMPT_PLACEHOLDER = `Eres un asistente de correo para esta casilla. Lees mensajes, redactas borradores de respuesta y ayudas a organizar conversaciones.\n\n(Deja vacío para usar el prompt base integrado del Worker, o carga la plantilla de Pablo con el botón superior).`;

const PABLO_BASE_PROMPT = `Eres Pablo, asistente virtual de Antonio Correa en Computin Cloud Hosting (COMPUTIN SpA, RUT 78.380.846-3).

REGLAS DE VOZ Y ESTILO:
- Escribe siempre en español de Chile, directo, claro y cordial, sin rodeos ni frases infladas de IA.
- Habla siempre en primera persona plural ("somos un equipo", "revisamos tu cuenta", "se nos pasó avisarte", "quedamos atentos").
- Mantén párrafos breves y destaca en negrita solo los datos clave cuando aporte claridad (montos, fechas de vencimiento, referencias).

REGLAS ESTRICTAS DE NEGOCIO Y COBRANZA:
1. CERO INVENCIÓN DE CIFRAS: Jamás inventes ni estimes montos en UF, valores en pesos (CLP), fechas de vencimiento, RUTs ni enlaces de pago (/p/...). Usa exclusivamente los datos verificados del Dossier de Cliente (Customer 360) o del hilo existente.
2. DATOS BANCARIOS OFICIALES (solo cuando el cliente pida transferir):
   - Titular: COMPUTIN SpA
   - RUT: 78.380.846-3
   - Banco: Banco de Chile — Cuenta Vista / Chequera Electrónica N° 28126125
   - Correo de confirmación: pablo@computin.dev
3. AVISOS DE PAGO Y COMPROBANTES: Si el cliente avisa que ya transfirió o adjunta comprobante, agradece el pago, indícale que dejamos el ciclo en verificación para emitir su Boleta o Factura afecta (COMPUTIN SpA) y confirma si requiere Factura (RUT, Razón Social y Giro) o Boleta.
4. CLIENTES B2B (FACTURA PRIMERO / ORDEN DE COMPRA): Si el cliente requiere Orden de Compra (OC) o Factura antes de pagar, solicita el número/PDF de OC o confirma que coordinamos la emisión de la factura con Antonio.
5. ESCALAMIENTO A ANTONIO: Si el cliente pide descuentos, cambios de plan, baja del servicio, reporta caída crítica (HTTP 5xx / correo sin recibir) o plantea un tema comercial delicado, deja únicamente un borrador prudente acusando recibo y marca que requiere revisión directa de Antonio Correa.`;

export default function SettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const navigate = useNavigate();
	const toastManager = useKumoToastManager();
	const { data: mailbox } = useMailbox(mailboxId);
	const updateMailboxMutation = useUpdateMailbox();
	const migrateMailboxMutation = useMigrateMailbox();

	const { data: configData } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: 60_000,
	});

	// Identity & Aliases
	const [displayName, setDisplayName] = useState("");
	const [aliases, setAliases] = useState<string[]>([]);
	const [newAliasInput, setNewAliasInput] = useState("");

	// Mailbox migration
	const [migrateTargetEmail, setMigrateTargetEmail] = useState("");
	const [keepOldAsAlias, setKeepOldAsAlias] = useState(true);
	const [isMigrating, setIsMigrating] = useState(false);

	// LLM Model, Persona & System Prompt
	const [autoDraftEnabled, setAutoDraftEnabled] = useState(true);
	const [llmModel, setLlmModel] = useState<string>(DEFAULT_LLM_MODEL);
	const [persona, setPersona] = useState<AgentPersona>("pablo");
	const [agentPrompt, setAgentPrompt] = useState("");

	// Signature & Forwarding
	const [signatureEnabled, setSignatureEnabled] = useState(false);
	const [signatureText, setSignatureText] = useState("");
	const [forwardingEnabled, setForwardingEnabled] = useState(false);
	const [forwardingEmail, setForwardingEmail] = useState("");

	const [isSaving, setIsSaving] = useState(false);

	useEffect(() => {
		if (!mailbox) return;
		const s = mailbox.settings;
		setDisplayName(s?.fromName || mailbox.name || "");
		setAliases(s?.aliases ?? []);
		setAutoDraftEnabled(s?.autoDraftEnabled ?? true);
		setLlmModel(s?.llmModel || DEFAULT_LLM_MODEL);
		setPersona(
			s?.persona || (s?.requireExplicitConfirm ? "antonio" : "pablo"),
		);
		setAgentPrompt(s?.agentSystemPrompt || "");
		setSignatureEnabled(s?.signature?.enabled ?? false);
		setSignatureText(s?.signature?.text || "");
		setForwardingEnabled(s?.forwarding?.enabled ?? false);
		setForwardingEmail(s?.forwarding?.email || "");
	}, [mailbox]);

	const suggestedMigrationEmails = useMemo(() => {
		if (!mailbox?.email || !configData?.domains?.length) return [];
		const [localPart, currentDomain] = mailbox.email.split("@");
		if (!localPart) return [];
		return configData.domains
			.filter((d) => d.toLowerCase() !== currentDomain?.toLowerCase())
			.map((d) => `${localPart}@${d}`);
	}, [mailbox?.email, configData?.domains]);

	const modelOptions = useMemo(() => {
		const exists = LLM_MODEL_OPTIONS.some((opt) => opt.value === llmModel);
		if (exists || !llmModel) return [...LLM_MODEL_OPTIONS];
		return [
			{ value: llmModel, label: `Personalizado (${llmModel})` },
			...LLM_MODEL_OPTIONS,
		];
	}, [llmModel]);

	const handleAddAlias = () => {
		const cleaned = newAliasInput.trim().toLowerCase();
		if (!cleaned) return;
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) {
			toastManager.add({
				title: "Ingresa un correo alias válido (ej. cobranza@computincloudhosting.com)",
				variant: "error",
			});
			return;
		}
		if (cleaned === mailbox?.email.toLowerCase()) {
			toastManager.add({
				title: "Esa ya es la dirección primaria de este buzón",
				variant: "error",
			});
			return;
		}
		if (!aliases.includes(cleaned)) {
			setAliases((prev) => [...prev, cleaned]);
		}
		setNewAliasInput("");
	};

	const handleRemoveAlias = (aliasToRemove: string) => {
		setAliases((prev) => prev.filter((a) => a !== aliasToRemove));
	};

	const handleMigrateMailbox = async () => {
		if (!mailboxId || !mailbox) return;
		const target = migrateTargetEmail.trim().toLowerCase();
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
			toastManager.add({
				title: "Ingresa una dirección de correo válida para migrar",
				variant: "error",
			});
			return;
		}
		if (target === mailbox.email.toLowerCase()) {
			toastManager.add({
				title: "La nueva dirección debe ser distinta a la actual",
				variant: "error",
			});
			return;
		}

		setIsMigrating(true);
		try {
			const res = await migrateMailboxMutation.mutateAsync({
				mailboxId,
				newEmail: target,
				keepOldAsAlias,
			});
			const finalEmail = res?.newEmail || res?.mailbox?.email || target;
			toastManager.add({
				title: `Buzón migrado a ${finalEmail}${keepOldAsAlias ? ` (manteniendo ${mailbox.email} como alias)` : ""}`,
			});
			setMigrateTargetEmail("");
			navigate(`/mailbox/${finalEmail}/settings`);
		} catch (err: unknown) {
			const message =
				(err instanceof Error ? err.message : null) ||
				"Error al migrar la dirección de correo";
			toastManager.add({ title: message, variant: "error" });
		} finally {
			setIsMigrating(false);
		}
	};

	const handleLoadPabloPrompt = () => {
		setAgentPrompt(configData?.defaultPabloPrompt || PABLO_BASE_PROMPT);
		setPersona("pablo");
		if (
			!displayName.trim() ||
			displayName.trim().toLowerCase() === mailbox?.email.split("@")[0]?.toLowerCase()
		) {
			setDisplayName("Pablo, asistente virtual de Antonio Correa");
		}
		if (!signatureText.trim()) {
			setSignatureText(
				"--\nPablo\nAsistente virtual de Antonio Correa\nComputin Cloud Hosting",
			);
			setSignatureEnabled(true);
		}
		toastManager.add({
			title: "Prompt base de Pablo cargado. Recuerda guardar los cambios.",
		});
	};

	const handleResetPrompt = () => {
		setAgentPrompt("");
	};

	const handleSave = async () => {
		if (!mailbox || !mailboxId) return;

		// Include pending alias in input if user typed it without clicking "Agregar alias"
		let nextAliases = aliases;
		const pendingAlias = newAliasInput.trim().toLowerCase();
		if (
			pendingAlias &&
			/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pendingAlias) &&
			pendingAlias !== mailbox.email.toLowerCase() &&
			!nextAliases.includes(pendingAlias)
		) {
			nextAliases = [...nextAliases, pendingAlias];
			setAliases(nextAliases);
			setNewAliasInput("");
		}

		if (
			forwardingEnabled &&
			forwardingEmail.trim() &&
			!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(forwardingEmail.trim())
		) {
			toastManager.add({
				title: "Ingresa un correo destino válido para el reenvío",
				variant: "error",
			});
			return;
		}

		setIsSaving(true);
		const settings: MailboxSettings = {
			...mailbox.settings,
			fromName: displayName.trim() || mailbox.name,
			aliases: nextAliases,
			autoDraftEnabled,
			llmModel,
			persona,
			requireExplicitConfirm: persona === "antonio",
			agentSystemPrompt: agentPrompt.trim(),
			signature: {
				...mailbox.settings?.signature,
				enabled: signatureEnabled,
				text: signatureText,
			},
			forwarding: {
				enabled: forwardingEnabled,
				email: forwardingEmail.trim(),
			},
		};

		try {
			await updateMailboxMutation.mutateAsync({ mailboxId, settings });
			toastManager.add({ title: "Configuración del buzón guardada" });
		} catch (err: unknown) {
			const message =
				(err instanceof Error ? err.message : null) ||
				"Error al guardar la configuración";
			toastManager.add({ title: message, variant: "error" });
		} finally {
			setIsSaving(false);
		}
	};

	if (!mailbox) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	const isCustomPrompt = agentPrompt.trim().length > 0;

	return (
		<div className="max-w-3xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
			<div className="flex flex-wrap items-center justify-between gap-3 mb-6">
				<div>
					<h1 className="text-lg font-semibold text-kumo-default">
						Configuración del Buzón y Agente
					</h1>
					<p className="text-xs text-kumo-subtle mt-0.5">
						Identidad, alias, modelo Workers AI, gobernanza de envíos, firma y reenvío.
					</p>
				</div>
				<Button variant="primary" onClick={handleSave} loading={isSaving}>
					Guardar cambios
				</Button>
			</div>

			<div className="space-y-6 pb-10">
				{/* 1. Identity, Aliases & Address Migration */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5 space-y-5">
					<div className="flex items-center gap-2">
						<UserCircleIcon
							size={18}
							weight="duotone"
							className="text-kumo-brand"
						/>
						<span className="text-sm font-medium text-kumo-default">
							Identidad, Alias y Dirección de Correo
						</span>
					</div>

					<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
						<Input
							label="Nombre para mostrar (Display Name)"
							placeholder="Pablo, asistente virtual de Antonio Correa"
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
						/>
						<Input
							label="Dirección principal actual"
							type="email"
							value={mailbox.email}
							disabled
						/>
					</div>

					{/* Additional Aliases */}
					<div className="pt-2 border-t border-kumo-line space-y-2.5">
						<div>
							<span className="text-xs font-medium text-kumo-default block">
								Aliases adicionales en este buzón
							</span>
							<span className="text-xs text-kumo-subtle">
								Todos los correos enviados a estos alias (en To, CC o BCC) entrarán a esta misma bandeja.
							</span>
						</div>

						<div className="flex flex-wrap gap-1.5">
							{aliases.length > 0 ? (
								aliases.map((alias) => (
									<Badge
										key={alias}
										variant="secondary"
										className="flex items-center gap-1.5 pr-1.5 py-1"
									>
										<span>{alias}</span>
										<button
											type="button"
											onClick={() => handleRemoveAlias(alias)}
											aria-label={`Quitar alias ${alias}`}
											className="inline-flex items-center justify-center rounded-full p-0.5 text-kumo-subtle hover:text-kumo-default hover:bg-kumo-base/60 cursor-pointer bg-transparent border-0"
										>
											<XIcon size={12} weight="bold" />
										</button>
									</Badge>
								))
							) : (
								<span className="text-xs text-kumo-subtle italic">
									Sin alias configurados (ej. cobranza@computincloudhosting.com, pagos@computin.dev).
								</span>
							)}
						</div>

						<div className="flex items-center gap-2">
							<div className="flex-1">
								<Input
									aria-label="Nuevo alias de correo"
									placeholder="ej. cobranza@computincloudhosting.com"
									size="sm"
									value={newAliasInput}
									onChange={(e) => setNewAliasInput(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.preventDefault();
											handleAddAlias();
										}
									}}
								/>
							</div>
							<Button
								type="button"
								variant="secondary"
								size="sm"
								icon={<PlusIcon size={14} />}
								onClick={handleAddAlias}
							>
								Agregar alias
							</Button>
						</div>
					</div>

					{/* Migrate / Change primary address */}
					<div className="pt-3 border-t border-kumo-line space-y-3 bg-kumo-recessed/40 -mx-5 -mb-5 px-5 py-4 rounded-b-lg">
						<div className="flex items-center gap-2">
							<ArrowsLeftRightIcon
								size={16}
								weight="bold"
								className="text-kumo-subtle"
							/>
							<div>
								<span className="text-xs font-semibold text-kumo-default block">
									Cambiar / Migrar dirección principal de correo
								</span>
								<span className="text-xs text-kumo-subtle">
									Mueve carpetas, correos y ajustes a una nueva dirección (ej. {mailbox.email} → pablo@computincloudhosting.com).
								</span>
							</div>
						</div>

						{suggestedMigrationEmails.length > 0 && (
							<div className="flex flex-wrap items-center gap-1.5">
								<span className="text-[11px] text-kumo-subtle">
									Sugerencia rápida:
								</span>
								{suggestedMigrationEmails.map((suggestion) => (
									<button
										key={suggestion}
										type="button"
										onClick={() => setMigrateTargetEmail(suggestion)}
										className="text-[11px] px-2 py-0.5 rounded-full border border-kumo-line bg-kumo-base text-kumo-strong hover:bg-kumo-tint cursor-pointer"
									>
										{suggestion}
									</button>
								))}
							</div>
						)}

						<div className="flex flex-col sm:flex-row sm:items-end gap-2">
							<div className="flex-1">
								<Input
									label="Nueva dirección principal"
									type="email"
									placeholder="pablo@computincloudhosting.com"
									size="sm"
									value={migrateTargetEmail}
									onChange={(e) => setMigrateTargetEmail(e.target.value)}
								/>
							</div>
							<Button
								type="button"
								variant="secondary"
								size="sm"
								loading={isMigrating}
								disabled={!migrateTargetEmail.trim()}
								icon={<ArrowsLeftRightIcon size={14} />}
								onClick={handleMigrateMailbox}
							>
								Migrar dirección
							</Button>
						</div>

						<Checkbox
							label={`Mantener ${mailbox.email} como alias y redirigir correos entrantes al nuevo buzón`}
							checked={keepOldAsAlias}
							onCheckedChange={setKeepOldAsAlias}
						/>
					</div>
				</div>

				{/* 2. LLM Model, Persona Governance & System Prompt */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5 space-y-5">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<div className="flex items-center gap-2">
							<RobotIcon
								size={18}
								weight="duotone"
								className="text-kumo-brand"
							/>
							<span className="text-sm font-medium text-kumo-default">
								Modelo LLM, Gobernanza y Prompt del Agente
							</span>
							{isCustomPrompt ? (
								<Badge variant="primary">Prompt personalizado</Badge>
							) : (
								<Badge variant="secondary">Prompt por defecto</Badge>
							)}
						</div>
						<div className="flex items-center gap-1.5">
							<Button
								type="button"
								variant="secondary"
								size="xs"
								icon={<SparkleIcon size={13} />}
								onClick={handleLoadPabloPrompt}
							>
								Cargar prompt base de Pablo (Cobrador Computin)
							</Button>
							{isCustomPrompt && (
								<Button
									type="button"
									variant="ghost"
									size="xs"
									icon={<ArrowCounterClockwiseIcon size={13} />}
									onClick={handleResetPrompt}
								>
									Restaurar
								</Button>
							)}
						</div>
					</div>

					<div className="rounded-lg border border-kumo-line bg-kumo-recessed/50 px-4 py-3">
						<Switch
							label="Auto-redactar borradores al recibir correos entrantes"
							checked={autoDraftEnabled}
							onCheckedChange={setAutoDraftEnabled}
							size="sm"
						/>
						<p className="text-xs text-kumo-subtle mt-1">
							Filtra automáticamente rebotes (mailer-daemon / Auto-Submitted) e inyecta el contexto contable Customer 360 cuando el remitente es cliente de Computin.
						</p>
					</div>

					<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
						<Select
							label="Modelo LLM (Workers AI)"
							value={llmModel}
							onValueChange={(value) => {
								if (typeof value === "string" && value) setLlmModel(value);
							}}
						>
							{modelOptions.map((opt) => (
								<Select.Option key={opt.value} value={opt.value}>
									{opt.label}
								</Select.Option>
							))}
						</Select>

						<Select
							label="Regla de Gobernanza / Persona"
							value={persona}
							onValueChange={(value) => {
								if (value === "pablo" || value === "antonio") {
									setPersona(value);
								}
							}}
						>
							<Select.Option value="pablo">
								Pablo (Asistente virtual — primera persona plural)
							</Select.Option>
							<Select.Option value="antonio">
								Antonio Correa (Solo borrador — exige confirmación explícita siempre)
							</Select.Option>
						</Select>
					</div>

					{persona === "antonio" ? (
						<Banner
							variant="alert"
							title="Modo estricto: Antonio Correa (Solo borrador)"
							description="Ningún agente ni herramienta MCP podrá despachar correos autónomamente desde este buzón sin confirmación humana explícita."
						/>
					) : (
						<p className="text-xs text-kumo-subtle">
							<strong>Modo Pablo activo:</strong> redacta en primera persona plural (&ldquo;somos un equipo&rdquo;) y valida montos UF/CLP, RUT y enlaces <code>/p/:token</code> con el verificador determinista antes de guardar.
						</p>
					)}

					<div>
						<label
							htmlFor="agent-system-prompt"
							className="text-xs font-medium text-kumo-default mb-1.5 block"
						>
							Instrucciones del sistema (System Prompt)
						</label>
						<textarea
							id="agent-system-prompt"
							value={agentPrompt}
							onChange={(e) => setAgentPrompt(e.target.value)}
							placeholder={PROMPT_PLACEHOLDER}
							rows={13}
							className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono leading-relaxed"
						/>
						<p className="text-xs text-kumo-subtle mt-1.5">
							Este prompt define el tono, idioma y reglas de negocio del agente tanto en el panel lateral como al auto-redactar borradores entrantes.
						</p>
					</div>
				</div>

				{/* 3. Signature & Forwarding */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5 space-y-5">
					<div className="flex items-center gap-2">
						<SignatureIcon
							size={18}
							weight="duotone"
							className="text-kumo-brand"
						/>
						<span className="text-sm font-medium text-kumo-default">
							Firma Automática y Reenvío a Humano
						</span>
					</div>

					{/* Signature */}
					<div className="space-y-3">
						<Switch
							label="Agregar firma automática a borradores y correos salientes"
							checked={signatureEnabled}
							onCheckedChange={setSignatureEnabled}
							size="sm"
						/>
						<textarea
							value={signatureText}
							onChange={(e) => setSignatureText(e.target.value)}
							disabled={!signatureEnabled}
							placeholder={`--\nPablo\nAsistente virtual de Antonio Correa\nComputin Cloud Hosting`}
							rows={4}
							aria-label="Texto de la firma automática"
							className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono leading-relaxed disabled:opacity-50"
						/>
					</div>

					{/* Forwarding */}
					<div className="pt-4 border-t border-kumo-line space-y-3">
						<div className="flex items-center gap-2">
							<EnvelopeSimpleIcon
								size={16}
								weight="duotone"
								className="text-kumo-subtle"
							/>
							<span className="text-xs font-semibold text-kumo-default">
								Reenvío automático de correos entrantes
							</span>
						</div>
						<Switch
							label="Reenviar copia de cada correo entrante a una casilla humana"
							checked={forwardingEnabled}
							onCheckedChange={setForwardingEnabled}
							size="sm"
						/>
						<Input
							label="Correo destino de reenvío"
							type="email"
							placeholder="ej. antonio@portail.cl"
							size="sm"
							value={forwardingEmail}
							onChange={(e) => setForwardingEmail(e.target.value)}
							disabled={!forwardingEnabled}
						/>
					</div>
				</div>

				{/* Save Footer */}
				<div className="flex justify-end">
					<Button variant="primary" onClick={handleSave} loading={isSaving}>
						Guardar cambios
					</Button>
				</div>
			</div>
		</div>
	);
}
