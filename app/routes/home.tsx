// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Badge,
	Banner,
	Button,
	Dialog,
	Input,
	Loader,
	Select,
	Text,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	CheckIcon,
	CopyIcon,
	EnvelopeIcon,
	GearSixIcon,
	PaperPlaneTiltIcon,
	PlugsIcon,
	PlusIcon,
	TrashIcon,
	XIcon,
} from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link as RouterLink } from "react-router";
import { queryKeys } from "~/queries/keys";
import {
	useCreateMailbox,
	useDeleteMailbox,
	useMailboxes,
} from "~/queries/mailboxes";
import api from "~/services/api";
import type { Mailbox, OutboundProvider } from "~/types";

const DEFAULT_COBRADOR_URL = "https://cobro.computincloudhosting.com";
const CANONICAL_MCP_URL = "https://inbox.computin.dev/mcp";

export function meta() {
	return [{ title: "Agentic Inbox" }];
}

export default function HomeRoute() {
	const toastManager = useKumoToastManager();
	const queryClient = useQueryClient();
	const {
		data: mailboxes = [],
		refetch: refetchMailboxes,
		isFetched: mailboxesFetched,
	} = useMailboxes();
	const createMailbox = useCreateMailbox();
	const deleteMailbox = useDeleteMailbox();

	const { data: configData } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: 60_000,
	});

	const domains = configData?.domains ?? [];
	const emailAddresses = configData?.emailAddresses ?? [];

	// Create mailbox dialog state
	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [newPrefix, setNewPrefix] = useState("");
	const [selectedDomain, setSelectedDomain] = useState("");
	const [newName, setNewName] = useState("");
	const [isCreating, setIsCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);

	// Delete mailbox dialog state
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	const [mailboxToDelete, setMailboxToDelete] = useState<{
		id: string;
		email: string;
	} | null>(null);
	const [isDeleting, setIsDeleting] = useState(false);

	// Platform Settings dialog state
	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const [draftDomains, setDraftDomains] = useState<string[]>([]);
	const [newDomainInput, setNewDomainInput] = useState("");
	const [outboundProvider, setOutboundProvider] =
		useState<OutboundProvider>("cf_email");
	const [cobradorUrl, setCobradorUrl] = useState(DEFAULT_COBRADOR_URL);
	const [isSavingConfig, setIsSavingConfig] = useState(false);

	// Test outbound email state
	const [testFrom, setTestFrom] = useState("");
	const [testTo, setTestTo] = useState("");
	const [isSendingTest, setIsSendingTest] = useState(false);
	const [testResult, setTestResult] = useState<{
		ok: boolean;
		message: string;
	} | null>(null);

	// MCP copy state
	const [copiedMcpUrl, setCopiedMcpUrl] = useState(false);
	const [copiedMcpJson, setCopiedMcpJson] = useState(false);

	// Sync selected domain when config loads or changes
	useEffect(() => {
		if (domains.length > 0 && (!selectedDomain || !domains.includes(selectedDomain))) {
			setSelectedDomain(domains[0]);
		} else if (domains.length === 0) {
			setSelectedDomain("");
		}
	}, [domains, selectedDomain]);

	// Sync Platform Settings form when configData loads or dialog opens
	useEffect(() => {
		if (!configData) return;
		setDraftDomains(configData.domains ?? []);
		setOutboundProvider(configData.outboundProvider ?? "cf_email");
		setCobradorUrl(configData.cobradorUrl || DEFAULT_COBRADOR_URL);
	}, [configData]);

	// Default test sender mailbox
	useEffect(() => {
		if (!testFrom) {
			if (mailboxes.length > 0) {
				setTestFrom(mailboxes[0].email);
			} else if (emailAddresses.length > 0) {
				setTestFrom(emailAddresses[0]);
			}
		}
	}, [mailboxes, emailAddresses, testFrom]);

	// Auto-create mailboxes from config (run once when both data sources are ready)
	const autoCreateDone = useRef(false);
	useEffect(() => {
		if (autoCreateDone.current) return;
		if (emailAddresses.length === 0 || !mailboxesFetched) return;
		const existingEmails = new Set(
			mailboxes.map((m) => m.email.toLowerCase()),
		);
		const toCreate = emailAddresses.filter(
			(addr) => !existingEmails.has(addr.toLowerCase()),
		);
		if (toCreate.length === 0) {
			autoCreateDone.current = true;
			return;
		}
		autoCreateDone.current = true;
		let cancelled = false;
		Promise.all(
			toCreate.map((addr) => {
				const localPart = addr.split("@")[0] || addr;
				return api.createMailbox(addr, localPart).catch(() => {});
			}),
		).then(() => {
			if (!cancelled) refetchMailboxes();
		});
		return () => {
			cancelled = true;
		};
	}, [emailAddresses, mailboxes, refetchMailboxes, mailboxesFetched]);

	const handleCreate = async (e: FormEvent) => {
		e.preventDefault();
		setCreateError(null);
		if (!newPrefix || !selectedDomain) {
			setCreateError("Completa todos los campos requeridos");
			return;
		}
		const email = `${newPrefix.trim().toLowerCase()}@${selectedDomain}`;
		const name = newName.trim() || newPrefix.trim();
		setIsCreating(true);
		try {
			await createMailbox.mutateAsync({ email, name });
			toastManager.add({ title: `Buzón ${email} creado correctamente` });
			setIsCreateOpen(false);
			setNewPrefix("");
			setNewName("");
		} catch (err: unknown) {
			const message =
				(err instanceof Error ? err.message : null) ||
				"Error al crear el buzón";
			setCreateError(message);
		} finally {
			setIsCreating(false);
		}
	};

	const handleDelete = async () => {
		if (!mailboxToDelete) return;
		setIsDeleting(true);
		try {
			await deleteMailbox.mutateAsync(mailboxToDelete.id);
			toastManager.add({ title: "Buzón eliminado" });
			setIsDeleteOpen(false);
			setMailboxToDelete(null);
		} catch {
			toastManager.add({
				title: "Error al eliminar el buzón",
				variant: "error",
			});
		} finally {
			setIsDeleting(false);
		}
	};

	const handleAddDomain = () => {
		const cleaned = newDomainInput
			.trim()
			.toLowerCase()
			.replace(/^@/, "")
			.replace(/^https?:\/\//, "")
			.replace(/\/.*$/, "");
		if (!cleaned) return;
		if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(cleaned)) {
			toastManager.add({
				title: "Ingresa un dominio válido (ej. portail.cl)",
				variant: "error",
			});
			return;
		}
		if (draftDomains.includes(cleaned)) {
			setNewDomainInput("");
			return;
		}
		setDraftDomains((prev) => [...prev, cleaned]);
		setNewDomainInput("");
	};

	const handleRemoveDomain = (domain: string) => {
		setDraftDomains((prev) => prev.filter((d) => d !== domain));
	};

	const handleSavePlatformConfig = async () => {
		// Auto-include any domain typed in the input box if user forgot to click "Agregar"
		let nextDomains = draftDomains;
		const pending = newDomainInput
			.trim()
			.toLowerCase()
			.replace(/^@/, "")
			.replace(/^https?:\/\//, "")
			.replace(/\/.*$/, "");
		if (pending && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(pending) && !nextDomains.includes(pending)) {
			nextDomains = [...nextDomains, pending];
			setDraftDomains(nextDomains);
			setNewDomainInput("");
		}

		setIsSavingConfig(true);
		try {
			await api.updateConfig({
				domains: nextDomains,
				outboundProvider,
				sesRegion: "sa-east-1",
				defaultFromDomain: nextDomains[0] || "computin.dev",
				cobradorUrl: cobradorUrl.trim() || DEFAULT_COBRADOR_URL,
			});
			await queryClient.invalidateQueries({ queryKey: queryKeys.config });
			toastManager.add({ title: "Configuración de plataforma guardada" });
		} catch (err: unknown) {
			const message =
				(err instanceof Error ? err.message : null) ||
				"Error al guardar la configuración";
			toastManager.add({ title: message, variant: "error" });
		} finally {
			setIsSavingConfig(false);
		}
	};

	const handleSendTestEmail = async (e: FormEvent) => {
		e.preventDefault();
		if (!testFrom.trim() || !testTo.trim()) {
			toastManager.add({
				title: "Indica remitente y correo destino para la prueba",
				variant: "error",
			});
			return;
		}
		setIsSendingTest(true);
		setTestResult(null);
		try {
			const res = await api.sendTestEmail({
				from: testFrom.trim(),
				to: testTo.trim(),
				outboundProvider,
			});
			if (res.ok) {
				const providerLabel = res.provider || outboundProvider;
				const msg = `Envío confirmado vía ${providerLabel}${res.messageId ? ` (ID: ${res.messageId})` : ""}`;
				setTestResult({ ok: true, message: msg });
				toastManager.add({ title: msg });
			} else {
				const errMsg = res.error || "El proveedor rechazó el correo de prueba";
				setTestResult({ ok: false, message: errMsg });
				toastManager.add({ title: errMsg, variant: "error" });
			}
		} catch (err: unknown) {
			const errMsg =
				(err instanceof Error ? err.message : null) ||
				"Error al enviar correo de prueba";
			setTestResult({ ok: false, message: errMsg });
			toastManager.add({ title: errMsg, variant: "error" });
		} finally {
			setIsSendingTest(false);
		}
	};

	const mcpConfigJson = useMemo(
		() =>
			JSON.stringify(
				{
					mcpServers: {
						"computin-inbox": {
							url: CANONICAL_MCP_URL,
							headers: {
								Authorization: "Bearer <AGENT_API_KEY>",
							},
						},
					},
				},
				null,
				2,
			),
		[],
	);

	const handleCopyMcpUrl = async () => {
		try {
			await navigator.clipboard.writeText(CANONICAL_MCP_URL);
			setCopiedMcpUrl(true);
			setTimeout(() => setCopiedMcpUrl(false), 2000);
			toastManager.add({ title: "URL MCP copiada al portapapeles" });
		} catch {
			toastManager.add({ title: "No se pudo copiar al portapapeles", variant: "error" });
		}
	};

	const handleCopyMcpJson = async () => {
		try {
			await navigator.clipboard.writeText(mcpConfigJson);
			setCopiedMcpJson(true);
			setTimeout(() => setCopiedMcpJson(false), 2000);
			toastManager.add({ title: "Configuración JSON MCP copiada" });
		} catch {
			toastManager.add({ title: "No se pudo copiar al portapapeles", variant: "error" });
		}
	};

	const isConfigured = emailAddresses.length > 0;
	const mailboxMap = useMemo(
		() => new Map(mailboxes.map((m) => [m.email.toLowerCase(), m])),
		[mailboxes],
	);
	const accounts: Mailbox[] = isConfigured
		? emailAddresses.map((addr) => {
				const found = mailboxMap.get(addr.toLowerCase());
				return (
					found ?? {
						id: addr,
						email: addr,
						name: addr.split("@")[0] || addr,
					}
				);
			})
		: mailboxes;

	const isLoading = !configData;

	const hasUnsavedConfigChanges = useMemo(() => {
		if (!configData) return false;
		const origDomains = configData.domains ?? [];
		const origProvider = configData.outboundProvider ?? "cf_email";
		const origCobrador = configData.cobradorUrl || DEFAULT_COBRADOR_URL;
		return (
			JSON.stringify(origDomains) !== JSON.stringify(draftDomains) ||
			origProvider !== outboundProvider ||
			origCobrador !== cobradorUrl
		);
	}, [configData, draftDomains, outboundProvider, cobradorUrl]);

	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
				<div className="mb-8">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div>
							<h1 className="text-2xl font-bold text-kumo-default">Mailboxes</h1>
							<div className="flex flex-wrap items-center gap-2 mt-1">
								{domains.length > 0 ? (
									<span className="text-sm text-kumo-subtle">
										{domains.join(", ")}
									</span>
								) : (
									<span className="text-sm text-kumo-subtle">
										Sin dominios configurados
									</span>
								)}
								{configData?.outboundProvider && (
									<Badge variant="outline">
										{configData.outboundProvider === "aws_ses"
											? "AWS SES (sa-east-1)"
											: "Cloudflare Email"}
									</Badge>
								)}
							</div>
						</div>
						<div className="flex items-center gap-2">
							<Button
								variant="secondary"
								icon={<GearSixIcon size={16} />}
								onClick={() => setIsSettingsOpen(true)}
							>
								Configuración
							</Button>
							{!isConfigured && (
								<Button
									variant="primary"
									icon={<PlusIcon size={16} />}
									onClick={() => setIsCreateOpen(true)}
								>
									New Mailbox
								</Button>
							)}
						</div>
					</div>
				</div>

				{isLoading ? (
					<div className="flex justify-center py-20">
						<Loader size="lg" />
					</div>
				) : accounts.length > 0 ? (
					<div className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden">
						{accounts.map((account, idx) => {
							const displayTitle =
								account.settings?.fromName ||
								(account.name !== account.email
									? account.name
									: account.email.split("@")[0] || account.name);
							const aliases = account.settings?.aliases ?? [];
							return (
								<RouterLink
									key={account.id}
									to={`/mailbox/${account.id}`}
									className={`group flex items-center gap-4 px-5 py-4 no-underline transition-colors hover:bg-kumo-tint ${
										idx > 0 ? "border-t border-kumo-line" : ""
									}`}
								>
									<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-sm font-bold text-kumo-default">
										{displayTitle.charAt(0).toUpperCase()}
									</div>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2 flex-wrap">
											<span className="text-sm font-medium text-kumo-default truncate">
												{displayTitle}
											</span>
											{account.settings?.persona === "antonio" && (
												<Badge variant="secondary">Solo borrador</Badge>
											)}
										</div>
										<div className="text-sm text-kumo-subtle truncate">
											{account.email}
											{aliases.length > 0 && (
												<span className="ml-2 text-xs text-kumo-subtle">
													· Alias: {aliases.join(", ")}
												</span>
											)}
										</div>
									</div>
									{!isConfigured && (
										<Button
											variant="ghost"
											size="sm"
											shape="square"
											icon={<TrashIcon size={16} />}
											aria-label={`Delete mailbox ${account.email}`}
											onClick={(e) => {
												e.preventDefault();
												e.stopPropagation();
												setMailboxToDelete({
													id: account.id,
													email: account.email,
												});
												setIsDeleteOpen(true);
											}}
										/>
									)}
								</RouterLink>
							);
						})}
					</div>
				) : (
					<div className="rounded-xl border border-kumo-line bg-kumo-base py-16 px-6">
						<div className="flex flex-col items-center text-center">
							<div className="mb-4">
								<EnvelopeIcon
									size={48}
									weight="thin"
									className="text-kumo-subtle"
								/>
							</div>
							<h3 className="text-base font-semibold text-kumo-default mb-1.5">
								No mailboxes yet
							</h3>
							<p className="text-sm text-kumo-subtle max-w-sm mb-5">
								{isConfigured
									? "Your email routing is configured but no mailboxes have been created yet. They will appear here automatically."
									: "Create a mailbox to start sending and receiving emails with your domain."}
							</p>
							{!isConfigured && (
								<Button
									variant="primary"
									icon={<PlusIcon size={16} />}
									onClick={() => setIsCreateOpen(true)}
								>
									Create Mailbox
								</Button>
							)}
						</div>
					</div>
				)}
			</div>

			{/* Platform Settings Dialog */}
			<Dialog.Root open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
				<Dialog size="lg" className="p-6 max-h-[88vh] overflow-y-auto">
					<div className="flex items-center justify-between mb-4">
						<div>
							<Dialog.Title className="text-base font-semibold text-kumo-default">
								Configuración de Plataforma
							</Dialog.Title>
							<Dialog.Description className="text-xs text-kumo-subtle mt-0.5">
								Dominios activos, proveedor de despacho saliente, pruebas de envío y acceso MCP.
							</Dialog.Description>
						</div>
						{hasUnsavedConfigChanges && (
							<Badge variant="beta">Cambios sin guardar</Badge>
						)}
					</div>

					<div className="space-y-6">
						{/* 1. Active Domains */}
						<div className="rounded-lg border border-kumo-line bg-kumo-recessed/50 p-4 space-y-3">
							<div>
								<h3 className="text-sm font-medium text-kumo-default">
									Dominios activos
								</h3>
								<p className="text-xs text-kumo-subtle mt-0.5">
									Dominios habilitados para crear casillas y recibir correos en este Worker.
								</p>
							</div>

							<div className="flex flex-wrap gap-1.5">
								{draftDomains.length > 0 ? (
									draftDomains.map((domain) => (
										<Badge
											key={domain}
											variant="secondary"
											className="flex items-center gap-1.5 pr-1.5 py-1"
										>
											<span>{domain}</span>
											<button
												type="button"
												onClick={() => handleRemoveDomain(domain)}
												aria-label={`Eliminar dominio ${domain}`}
												className="inline-flex items-center justify-center rounded-full p-0.5 text-kumo-subtle hover:text-kumo-default hover:bg-kumo-base/60 cursor-pointer bg-transparent border-0"
											>
												<XIcon size={12} weight="bold" />
											</button>
										</Badge>
									))
								) : (
									<span className="text-xs text-kumo-subtle italic">
										No hay dominios activos. Agrega al menos uno abajo.
									</span>
								)}
							</div>

							<div className="flex items-center gap-2">
								<div className="flex-1">
									<Input
										aria-label="Nuevo dominio"
										placeholder="ej. portail.cl"
										size="sm"
										value={newDomainInput}
										onChange={(e) => setNewDomainInput(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												e.preventDefault();
												handleAddDomain();
											}
										}}
									/>
								</div>
								<Button
									type="button"
									variant="secondary"
									size="sm"
									icon={<PlusIcon size={14} />}
									onClick={handleAddDomain}
								>
									Agregar
								</Button>
							</div>
						</div>

						{/* 2. Outbound Provider & Cobrador URL */}
						<div className="rounded-lg border border-kumo-line bg-kumo-recessed/50 p-4 space-y-3">
							<div>
								<h3 className="text-sm font-medium text-kumo-default">
									Proveedor de envío saliente e integración Cobrador
								</h3>
								<p className="text-xs text-kumo-subtle mt-0.5">
									Selecciona el transporte para correos salientes y la URL de respaldo de cobrador-hosting.
								</p>
							</div>

							<Select
								label="Proveedor de envío saliente"
								value={outboundProvider}
								onValueChange={(value) => {
									if (value === "cf_email" || value === "aws_ses") {
										setOutboundProvider(value);
									}
								}}
							>
								<Select.Option value="cf_email">
									Cloudflare Email Service (env.EMAIL)
								</Select.Option>
								<Select.Option value="aws_ses">
									AWS SES (sa-east-1)
									{configData?.awsSesConfigured === false
										? " — secretos AWS pendientes"
										: ""}
								</Select.Option>
							</Select>

							<Input
								label="URL de Cobrador Hosting (cobradorUrl)"
								placeholder={DEFAULT_COBRADOR_URL}
								size="sm"
								value={cobradorUrl}
								onChange={(e) => setCobradorUrl(e.target.value)}
							/>

							<div className="flex justify-end pt-1">
								<Button
									type="button"
									variant="primary"
									size="sm"
									loading={isSavingConfig}
									onClick={handleSavePlatformConfig}
								>
									Guardar configuración
								</Button>
							</div>
						</div>

						{/* 3. Test Outbound Email */}
						<form
							onSubmit={handleSendTestEmail}
							className="rounded-lg border border-kumo-line bg-kumo-recessed/50 p-4 space-y-3"
						>
							<div>
								<h3 className="text-sm font-medium text-kumo-default">
									Probar envío saliente
								</h3>
								<p className="text-xs text-kumo-subtle mt-0.5">
									Envía un correo real de verificación para comprobar credenciales y entregabilidad.
								</p>
							</div>

							<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
								{accounts.length > 0 ? (
									<Select
										label="Desde buzón (From)"
										value={testFrom || accounts[0].email}
										onValueChange={(value) => {
											if (typeof value === "string") setTestFrom(value);
										}}
									>
										{accounts.map((acc) => (
											<Select.Option key={acc.email} value={acc.email}>
												{acc.email}
											</Select.Option>
										))}
									</Select>
								) : (
									<Input
										label="Desde buzón (From)"
										type="email"
										placeholder="pablo@computin.dev"
										size="sm"
										value={testFrom}
										onChange={(e) => setTestFrom(e.target.value)}
									/>
								)}
								<Input
									label="Para (To email)"
									type="email"
									placeholder="antonio@portail.cl"
									size="sm"
									value={testTo}
									onChange={(e) => setTestTo(e.target.value)}
									required
								/>
							</div>

							{testResult && (
								<Banner
									variant={testResult.ok ? "default" : "error"}
									title={testResult.ok ? "Envío exitoso" : "Error de envío"}
									description={testResult.message}
								/>
							)}

							<div className="flex justify-end">
								<Button
									type="submit"
									variant="secondary"
									size="sm"
									loading={isSendingTest}
									icon={<PaperPlaneTiltIcon size={14} />}
								>
									Enviar correo de prueba
								</Button>
							</div>
						</form>

						{/* 4. MCP Connection for Agents */}
						<div className="rounded-lg border border-kumo-line bg-kumo-recessed/50 p-4 space-y-3">
							<div className="flex items-start justify-between gap-2">
								<div className="flex items-center gap-2">
									<PlugsIcon
										size={18}
										weight="duotone"
										className="text-kumo-brand shrink-0"
									/>
									<div>
										<h3 className="text-sm font-medium text-kumo-default">
											Conexión MCP para Agentes (pi / Claude Code / Antigravity)
										</h3>
										<p className="text-xs text-kumo-subtle mt-0.5">
											Conecta tus agentes CLI mediante Bearer token (AGENT_API_KEY) o Cloudflare Access.
										</p>
									</div>
								</div>
							</div>

							<div className="flex items-center gap-2">
								<div className="flex-1 bg-kumo-base text-kumo-default font-mono text-xs px-3 py-2 rounded-lg border border-kumo-line truncate">
									{CANONICAL_MCP_URL}
								</div>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									shape="square"
									aria-label="Copiar URL MCP"
									icon={
										copiedMcpUrl ? (
											<CheckIcon
												size={14}
												weight="bold"
												className="text-kumo-success"
											/>
										) : (
											<CopyIcon size={14} />
										)
									}
									onClick={handleCopyMcpUrl}
								/>
							</div>

							<pre className="bg-kumo-base text-kumo-subtle font-mono text-[11px] p-3 rounded-lg border border-kumo-line overflow-x-auto leading-relaxed">
								{mcpConfigJson}
							</pre>

							<div className="flex justify-end">
								<Button
									type="button"
									variant="secondary"
									size="sm"
									icon={
										copiedMcpJson ? (
											<CheckIcon
												size={14}
												weight="bold"
												className="text-kumo-success"
											/>
										) : (
											<CopyIcon size={14} />
										)
									}
									onClick={handleCopyMcpJson}
								>
									{copiedMcpJson
										? "JSON MCP copiado"
										: "Copiar configuración JSON MCP"}
								</Button>
							</div>
						</div>

						<div className="flex justify-end pt-1">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary" size="sm">
										Cerrar
									</Button>
								)}
							/>
						</div>
					</div>
				</Dialog>
			</Dialog.Root>

			{/* Create Dialog */}
			<Dialog.Root open={isCreateOpen} onOpenChange={setIsCreateOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-5">
						Create New Mailbox
					</Dialog.Title>
					<form onSubmit={handleCreate} className="space-y-4">
						{createError && (
							<Text variant="error" size="sm">
								{createError}
							</Text>
						)}
						<div>
							<span className="text-sm font-medium text-kumo-default mb-1.5 block">
								Email Address
							</span>
							<div className="flex items-center gap-2">
								<div className="flex-1">
									<Input
										aria-label="Address prefix"
										placeholder="pablo"
										size="sm"
										value={newPrefix}
										onChange={(e) => setNewPrefix(e.target.value)}
										required
									/>
								</div>
								<span className="text-sm text-kumo-subtle">@</span>
								{domains.length > 1 ? (
									<div className="flex-1">
										<Select
											aria-label="Domain"
											value={selectedDomain}
											onValueChange={(value) => {
												if (typeof value === "string" && value) {
													setSelectedDomain(value);
												}
											}}
										>
											{domains.map((d) => (
												<Select.Option key={d} value={d}>
													{d}
												</Select.Option>
											))}
										</Select>
									</div>
								) : (
									<span className="text-sm text-kumo-subtle">
										{selectedDomain || "no domain"}
									</span>
								)}
							</div>
						</div>
						<Input
							label="Display Name (optional)"
							placeholder="Pablo, asistente virtual de Antonio Correa"
							size="sm"
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
						/>
						<div className="flex justify-end gap-2 pt-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary" size="sm">
										Cancel
									</Button>
								)}
							/>
							<Button
								type="submit"
								variant="primary"
								size="sm"
								loading={isCreating}
								disabled={!selectedDomain}
							>
								Create
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>

			{/* Delete Dialog */}
			<Dialog.Root
				open={isDeleteOpen}
				onOpenChange={(open) => {
					setIsDeleteOpen(open);
					if (!open) setMailboxToDelete(null);
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-2">
						Delete Mailbox
					</Dialog.Title>
					<Dialog.Description className="text-kumo-subtle text-sm mb-5">
						Are you sure you want to delete{" "}
						<strong className="text-kumo-default">
							{mailboxToDelete?.email}
						</strong>
						? This action cannot be undone.
					</Dialog.Description>
					<div className="flex justify-end gap-2">
						<Dialog.Close
							render={(props) => (
								<Button {...props} variant="secondary" size="sm">
									Cancel
								</Button>
							)}
						/>
						<Button
							variant="destructive"
							size="sm"
							loading={isDeleting}
							onClick={handleDelete}
						>
							Delete
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
